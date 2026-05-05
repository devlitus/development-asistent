/**
 * Handler for the ACP `session/prompt` method.
 *
 * Receives the user's prompt and sends back a response
 * as a `session/update` notification followed by a `PromptResponse`.
 *
 * If an LLM provider is available, it uses it to generate the response.
 * Otherwise, falls back to a static message for the spike phase.
 *
 * See: https://agentclientprotocol.com/protocol/prompt-turn
 */

import type { ContentBlock } from "@zed-industries/agent-client-protocol";
import type { StdioTransport } from "../../transport/stdio.ts";
import type { SessionStore } from "../session-store.ts";
import type { LLMProvider, ChatMessage } from "../../types/llm.ts";
import type { Orchestrator } from "../../orchestrator/index.ts";
import { asSessionId } from "../../types/persistence.ts";
import { ERR_MARKER } from "../../orchestrator/orchestrator.ts";

/** Static response text for the spike phase when no LLM is available. */
const STATIC_RESPONSE = "Hola, soy tu asistente ACP";

/** Params validated by Zod schema in AcpServer. */
export interface SessionPromptParams {
  readonly sessionId: string;
  readonly prompt?: ContentBlock[];
}

/** Result shape for the session/prompt handler (matches PromptResponse). */
export interface SessionPromptResult {
  readonly stopReason: "end_turn" | "error";
}

/**
 * Convert ACP ContentBlock array to LLM ChatMessage array.
 *
 * In the spike phase, we only handle text blocks and treat them
 * as user messages. Other block types are skipped.
 */
/** Runtime-validated text content block from ACP. */
interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * Type guard: validate that a value is a valid text ContentBlock
 * at runtime, avoiding unsafe casting.
 */
function isTextContentBlock(value: unknown): value is TextContentBlock {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj["type"] === "text" && typeof obj["text"] === "string";
}

function mapContentBlocksToMessages(blocks: ContentBlock[] | undefined): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (!blocks || blocks.length === 0) {
    messages.push({ role: "user", content: "" });
    return messages;
  }

  for (const block of blocks) {
    if (isTextContentBlock(block)) {
      messages.push({ role: "user", content: block.text });
    }
    // Non-text blocks (image, tool_use, etc.) are silently skipped
    // per spike decision: only text blocks map to ChatMessage.
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  return messages;
}

/**
 * Redact sensitive API key patterns from error messages before sending
 * them to the client. Keeps internal logs untouched.
 *
 * Patterns matched:
 * - Anthropic: sk-ant-api03-... , sk-ant-...
 * - OpenAI: sk-... (at least 20 chars)
 * - Generic bearer tokens (long alphanumeric strings after common prefixes)
 */
function sanitizeErrorMessage(message: string): string {
  // Anthropic API keys (sk-ant-...)
  let sanitized = message.replace(
    /sk-ant-[a-zA-Z0-9_-]+/g,
    "[REDACTED]",
  );
  // OpenAI API keys (sk-... with sufficient length)
  sanitized = sanitized.replace(
    /sk-[a-zA-Z0-9]{20,}/g,
    "[REDACTED]",
  );
  // Generic bearer tokens that look like secrets (at least 32 chars)
  sanitized = sanitized.replace(
    /\b[A-Za-z0-9_\-]{32,}\b/g,
    (match) => {
      // Heuristic: if it looks like a random secret string, redact it.
      // Keep common non-secret words.
      const keepWords = new Set([
        "end_turn", "stop_sequence", "max_tokens", "temperature",
        "claude", "gpt", "openai", "anthropic", "localhost", "127_0_0_1",
      ]);
      if (keepWords.has(match.toLowerCase())) return match;
      // Check for mixed case + numbers + symbols (entropy indicator)
      const hasUpper = /[A-Z]/.test(match);
      const hasLower = /[a-z]/.test(match);
      const hasDigit = /\d/.test(match);
      const hasSymbol = /[_\-]/.test(match);
      const variety = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
      if (variety >= 3 && match.length >= 40) return "[REDACTED]";
      return match;
    },
  );
  return sanitized;
}

/**
 * Extract plain text from ACP ContentBlock array.
 *
 * Concatenates all text blocks into a single string.
 * Returns empty string if no text blocks found.
 */
function extractPromptText(blocks: ContentBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return "";
  const texts: string[] = [];
  for (const block of blocks) {
    if (isTextContentBlock(block)) {
      texts.push(block.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * Handle a `session/prompt` request.
 *
 * When an Orchestrator is available, consumes its `dispatch()` AsyncIterable
 * and maps AgentEvents to session/update notifications. Otherwise, falls back
 * to the direct LLM provider path.
 *
 * @param params - The validated request params (sessionId, prompt).
 * @param sessions - The session store to validate the session.
 * @param transport - The transport to send notifications/responses.
 * @param requestId - The JSON-RPC request ID for the response.
 * @param llmProvider - Optional LLM provider for generating responses.
 * @param orchestrator - Optional Orchestrator for agent-based routing.
 * @returns The prompt result with stopReason, or an error object.
 */
export async function handleSessionPrompt(
  params: SessionPromptParams,
  sessions: SessionStore,
  transport: StdioTransport,
  requestId: string | number,
  llmProvider?: LLMProvider,
  orchestrator?: Orchestrator,
): Promise<SessionPromptResult | { error: { code: number; message: string } }> {
  // Validate session exists
  if (!sessions.has(params.sessionId)) {
    return {
      error: {
        code: -32602,
        message: `Invalid params: session '${params.sessionId}' not found`,
      },
    };
  }

  // ── Orchestrator path ──────────────────────────────────────────────
  if (orchestrator) {
    const promptText = extractPromptText(params.prompt);
    const session = sessions.get(params.sessionId);
    const workingDir = session?.cwd;
    let success = false;

    for await (const event of orchestrator.dispatch(
      asSessionId(params.sessionId),
      promptText,
      workingDir,
    )) {
      switch (event.type) {
        case "text":
          transport.sendNotification("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.content },
            },
          });
          break;
        case "tool_call":
          // Always log to stderr for debugging
          console.error(`[orchestrator] tool_call: ${event.name} (${event.status})`);
          if (event.status === "in_progress") {
            transport.sendNotification("session/update", {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `\x00TOOL_CALL\x00${event.name}` },
              },
            });
          } else if (event.status === "completed" || event.status === "failed") {
            transport.sendNotification("session/update", {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `\x00TOOL_RESULT\x00${event.name}\x00${event.status}` },
              },
            });
          }
          break;
        case "permission_request":
          // v1: auto-approved, logged to stderr
          console.error(`[orchestrator] permission_request auto-approved: ${event.tool}`);
          break;
        case "error":
          transport.sendNotification("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `${ERR_MARKER}${sanitizeErrorMessage(event.message)}` },
            },
          });
          break;
        case "done":
          success = event.success;
          break;
        default: {
          const _exhaustive: never = event;
          console.error("[orchestrator] Unknown event type:", _exhaustive);
          break;
        }
      }
    }

    return { stopReason: success ? "end_turn" as const : "error" as const };
  }

  // ── Direct LLM path (original behavior, unchanged) ────────────────
  let responseText: string;

  if (llmProvider) {
    try {
      const messages = mapContentBlocksToMessages(params.prompt);
      const llmResponse = await llmProvider.chat(messages);
      responseText = llmResponse.content;
    } catch (err) {
      const safeMessage = err instanceof Error ? sanitizeErrorMessage(err.message) : sanitizeErrorMessage(String(err));
      console.error("[session/prompt] LLM error:", safeMessage);
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Security: redact common API key patterns from exposed error messages
      const sanitized = sanitizeErrorMessage(rawMessage);
      return {
        error: {
          code: -32603,
          message: `LLM error: ${sanitized}`,
        },
      };
    }
  } else {
    responseText = STATIC_RESPONSE;
  }

  // Send session/update notification with agent_message_chunk
  transport.sendNotification("session/update", {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: responseText,
      },
    },
  });

  return { stopReason: "end_turn" };
}
