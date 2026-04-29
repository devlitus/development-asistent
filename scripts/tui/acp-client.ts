/**
 * AcpClient — TUI-03
 *
 * High-level ACP protocol client that wraps AgentProcess.
 * Handles:
 *   - JSON-RPC request/response correlation via pending requests map
 *   - Timeouts for initialize and newSession (60s default)
 *   - Routing of session/update and session/request_permission notifications
 *   - sendPermissionResponse as a notification (no id)
 *
 * Handshake sequence:
 *   initialize → session/new → session/prompt (repeated)
 */

import type { AgentMessage, SessionUpdatePayload, PermissionRequest } from "./types.ts";
import type { AgentProcess } from "./agent-process.ts";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface AcpClientOptions {
  /** Timeout in ms for initialize and newSession. Default: 60_000 */
  timeoutMs?: number;
}

// ─── Pending request entry ────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

function isSessionUpdatePayload(val: unknown): val is SessionUpdatePayload {
  if (typeof val !== "object" || val === null) return false;
  const v = val as Record<string, unknown>;
  if (typeof v["sessionId"] !== "string") return false;
  if (typeof v["update"] !== "object" || v["update"] === null) return false;
  const u = v["update"] as Record<string, unknown>;
  if (u["sessionUpdate"] !== "agent_message_chunk") return false;
  // Validate content.text to prevent TypeError on malformed server messages (TS-NEW-1)
  if (typeof u["content"] !== "object" || u["content"] === null) return false;
  const c = u["content"] as Record<string, unknown>;
  return typeof c["text"] === "string";
}

function isPermissionRequest(val: unknown): val is PermissionRequest {
  if (typeof val !== "object" || val === null) return false;
  const v = val as Record<string, unknown>;
  return (
    typeof v["sessionId"] === "string" &&
    typeof v["toolName"] === "string" &&
    typeof v["description"] === "string"
  );
}

// ─── AcpClient ────────────────────────────────────────────────────────────────

/**
 * Wraps an AgentProcess with the ACP JSON-RPC protocol.
 *
 * Usage:
 *   const client = new AcpClient(agentProcess);
 *   const { protocolVersion } = await client.initialize();
 *   const sessionId = await client.newSession(process.cwd());
 *   client.onUpdate((payload) => { ... });
 *   await client.sendPrompt(sessionId, "Hello!");
 */
export class AcpClient {
  #agent: AgentProcess;
  #nextId = 1;
  #pendingRequests = new Map<number, PendingRequest>();
  #updateHandlers: Array<(payload: SessionUpdatePayload) => void> = [];
  #permissionHandlers: Array<(req: PermissionRequest) => void> = [];
  #timeoutMs: number;

  constructor(agentProcess: AgentProcess, options: AcpClientOptions = {}) {
    this.#agent = agentProcess;
    this.#timeoutMs = options.timeoutMs ?? 60_000;

    // Register message handler once at construction time
    this.#agent.onMessage((msg) => this.#handleMessage(msg));
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Send the `initialize` handshake and wait for the server's response.
   * Rejects after `timeoutMs` if no response arrives.
   */
  async initialize(): Promise<{ protocolVersion: number; serverInfo: unknown }> {
    const result = await this.#sendRequest(
      "initialize",
      { protocolVersion: 1 },
      true, // use timeout
    );
    if (typeof result !== "object" || result === null) {
      throw new Error("AcpClient: initialize response is not an object");
    }
    const r = result as Record<string, unknown>;
    if (typeof r["protocolVersion"] !== "number") {
      throw new Error("AcpClient: initialize response missing protocolVersion");
    }
    return { protocolVersion: r["protocolVersion"] as number, serverInfo: r["serverInfo"] };
  }

  /**
   * Create a new session and return the sessionId.
   * Rejects after `timeoutMs` if no response arrives.
   */
  async newSession(cwd: string): Promise<string> {
    const result = await this.#sendRequest(
      "session/new",
      { cwd, mcpServers: [] },
      true, // use timeout
    );
    if (typeof result !== "object" || result === null) {
      throw new Error("AcpClient: newSession response is not an object");
    }
    const sessionId = (result as Record<string, unknown>)["sessionId"];
    if (typeof sessionId !== "string") {
      throw new Error("AcpClient: newSession response missing sessionId");
    }
    return sessionId;
  }

  /**
   * Send a prompt to an existing session.
   * No timeout — the agent may take a long time to respond.
   */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    await this.#sendRequest(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      false, // no timeout
    );
  }

  /**
   * Register a handler for `session/update` notifications.
   * Multiple handlers can be registered; all are called in order.
   */
  onUpdate(handler: (payload: SessionUpdatePayload) => void): void {
    this.#updateHandlers.push(handler);
  }

  /**
   * Register a handler for `session/request_permission` notifications.
   * Multiple handlers can be registered; all are called in order.
   */
  onPermissionRequest(handler: (req: PermissionRequest) => void): void {
    this.#permissionHandlers.push(handler);
  }

  /**
   * Send a permission response as a notification (no id field).
   */
  sendPermissionResponse(sessionId: string, approved: boolean): void {
    this.#agent.send({
      jsonrpc: "2.0",
      method: "session/confirm_permission",
      params: { sessionId, approved },
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC request and return a promise that resolves/rejects
   * when the corresponding response arrives.
   */
  #sendRequest(
    method: string,
    params: unknown,
    withTimeout: boolean,
  ): Promise<unknown> {
    const id = this.#nextId++;

    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (withTimeout) {
        timer = setTimeout(() => {
          this.#pendingRequests.delete(id);
          reject(new Error(`AcpClient: timeout waiting for response to "${method}" (id: ${id})`));
        }, this.#timeoutMs);
      }

      this.#pendingRequests.set(id, { resolve, reject, timer });

      this.#agent.send({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  /**
   * Route an incoming message from the agent:
   *   - Response (has id + result) → resolve pending request
   *   - Error response (has id + error) → reject pending request
   *   - Notification (has method, no id) → dispatch to handlers
   */
  #handleMessage(msg: AgentMessage): void {
    // Response with result
    if ("id" in msg && "result" in msg) {
      const pending = this.#pendingRequests.get(msg.id);
      if (pending) {
        this.#pendingRequests.delete(msg.id);
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.resolve(msg.result);
      }
      return;
    }

    // Response with error
    if ("id" in msg && "error" in msg) {
      const pending = this.#pendingRequests.get(msg.id);
      if (pending) {
        this.#pendingRequests.delete(msg.id);
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(new Error(msg.error.message));
      }
      return;
    }

    // Notification (no id, has method)
    if ("method" in msg) {
      if (msg.method === "session/update") {
        if (isSessionUpdatePayload(msg.params)) {
          for (const handler of this.#updateHandlers) {
            handler(msg.params);
          }
        }
        return;
      }

      if (msg.method === "session/request_permission") {
        if (isPermissionRequest(msg.params)) {
          for (const handler of this.#permissionHandlers) {
            handler(msg.params);
          }
        }
        return;
      }
    }
  }
}
