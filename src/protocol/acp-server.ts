/**
 * AcpServer — the ACP protocol server.
 *
 * Routes incoming JSON-RPC messages to appropriate ACP method handlers
 * using the existing `StdioTransport` for reading requests and writing
 * responses/notifications.
 *
 * ## Architecture
 *
 * ```
 * Client (Zed/JetBrains)
 *   │  stdin/stdout (NDJSON)
 *   ▼
 * StdioTransport ← handles parsing/framing
 *   │  MessageHandler callback
 *   ▼
 * AcpServer.route()
 *   │  dispatch by method name
 *   ▼
 * handleInitialize / handleSessionNew / handleSessionPrompt
 *   │  via transport.sendResponse / sendNotification / sendError
 *   ▼
 * Client
 * ```
 *
 * ## Supported methods (spike phase)
 * - `initialize` — returns capabilities and protocol version
 * - `session/new` — creates an in-memory session
 * - `session/prompt` — sends response via session/update notification
 *
 * All other methods receive a `method_not_found` (-32601) error.
 */

import { z } from "zod";
import type { JSONRPCRequest, JSONRPCNotification } from "../types/jsonrpc.ts";
import type { StdioTransport } from "../transport/stdio.ts";
import type { LLMProvider } from "../types/llm.ts";
import type { Orchestrator } from "../orchestrator/index.ts";
import { SessionStore } from "./session-store.ts";
import { handleInitialize } from "./handlers/initialize.ts";
import { handleSessionNew } from "./handlers/session-new.ts";
import { handleSessionPrompt } from "./handlers/session-prompt.ts";

// ---------------------------------------------------------------------------
// Param validation schemas (Zod)
// ---------------------------------------------------------------------------

/** Schema for `session/new` params. */
const sessionNewParamsSchema = z.object({
  cwd: z.string().min(1).default("/"),
  mcpServers: z.array(z.unknown()).optional().default([]),
}).default({});

/** Schema for `session/prompt` params. */
const sessionPromptParamsSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.array(z.unknown()).optional().default([]),
});

// ---------------------------------------------------------------------------
// AcpServer
// ---------------------------------------------------------------------------

/**
 * ACP protocol server.
 *
 * Wraps a `StdioTransport` and routes JSON-RPC messages to ACP handlers.
 * Maintains session state in memory via `SessionStore`.
 */
export class AcpServer {
  private readonly transport: StdioTransport;
  private readonly sessions: SessionStore;
  private readonly llmProvider?: LLMProvider;
  private readonly orchestrator?: Orchestrator;

  /**
   * Create a new ACP server.
   *
   * @param transport - The stdio transport for reading/writing JSON-RPC.
   * @param sessions - Optional session store (defaults to a new empty store).
   * @param llmProvider - Optional LLM provider for generating prompt responses.
   * @param orchestrator - Optional Orchestrator for agent-based routing.
   */
  constructor(
    transport: StdioTransport,
    sessions?: SessionStore,
    llmProvider?: LLMProvider,
    orchestrator?: Orchestrator,
  ) {
    this.transport = transport;
    this.sessions = sessions ?? new SessionStore();
    this.llmProvider = llmProvider;
    this.orchestrator = orchestrator;
  }

  /**
   * Start the server.
   *
   * Begins reading from the transport's input stream and routing
   * incoming messages to handlers. Resolves when the stream ends.
   */
  async start(): Promise<void> {
    await this.transport.start(async (msg) => await this.route(msg));
  }

  /**
   * Stop the server gracefully.
   *
   * Closes the underlying transport, causing `start()` to resolve.
   */
  stop(): void {
    this.transport.close();
  }

  /**
   * Route an incoming message to the appropriate handler.
   *
   * - Requests (with `id`) are dispatched by method name.
   * - Notifications (no `id`) are silently ignored in the spike phase.
   */
  private async route(message: JSONRPCRequest | JSONRPCNotification): Promise<void> {
    // Notifications don't have an `id` field — ignore for now
    if (!("id" in message) || message.id === undefined) {
      return;
    }

    const { id, method, params } = message;

    switch (method) {
      case "initialize":
        this.dispatchInitialize(id);
        break;
      case "session/new":
        this.dispatchSessionNew(id, params);
        break;
      case "session/prompt":
        await this.dispatchSessionPrompt(id, params);
        break;
      default:
        this.transport.sendError(id, {
          code: -32601,
          message: "Method not found",
        });
    }
  }

  private dispatchInitialize(id: string | number): void {
    const result = handleInitialize();
    this.transport.sendResponse(id, result);
  }

  private dispatchSessionNew(id: string | number, params: unknown): void {
    const parsed = sessionNewParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.transport.sendError(id, {
        code: -32602,
        message: `Invalid params: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      });
      return;
    }
    const result = handleSessionNew(parsed.data, this.sessions);
    this.transport.sendResponse(id, result);
  }

  private async dispatchSessionPrompt(id: string | number, params: unknown): Promise<void> {
    const parsed = sessionPromptParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.transport.sendError(id, {
        code: -32602,
        message: `Invalid params: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      });
      return;
    }

    try {
      const result = await handleSessionPrompt(
        parsed.data,
        this.sessions,
        this.transport,
        id,
        this.llmProvider,
        this.orchestrator,
      );
      if ("error" in result) {
        this.transport.sendError(id, result.error);
      } else {
        this.transport.sendResponse(id, result);
      }
    } catch (err) {
      console.error("[AcpServer] unhandled error in session/prompt:", err);
      this.transport.sendError(id, {
        code: -32603,
        message: "Internal error",
      });
    }
  }
}
