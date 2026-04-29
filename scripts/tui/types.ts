/**
 * TUI types and interfaces — TUI-01
 *
 * All types consumed by TUI-02..06.
 *
 * State machine (valid transitions):
 *   connecting → idle             (initialize OK)
 *   connecting → error            (spawn fails)
 *   idle       → thinking         (user sends prompt)
 *   thinking   → idle             (stopReason received)
 *   thinking   → waiting_permission (session/request_permission arrives)
 *   waiting_permission → thinking (user responds Y/n)
 *   *          → error            (critical error)
 *   error      → idle             (user types /new)
 */

// ─── TuiStatus ────────────────────────────────────────────────────────────────

/** Possible states of the TUI client. */
export type TuiStatus =
  | "connecting"
  | "idle"
  | "thinking"
  | "waiting_permission"
  | "error";

// ─── TuiMessage ───────────────────────────────────────────────────────────────

/** A single message in the conversation history. */
export interface TuiMessage {
  readonly role: "user" | "agent" | "system" | "tool";
  readonly content: string;
  readonly timestamp: number; // Date.now()
  readonly toolName?: string; // only for role "tool"
}

// ─── PermissionRequest ────────────────────────────────────────────────────────

/**
 * Payload from a `session/request_permission` notification.
 * Stored in TuiState while waiting for user confirmation.
 */
export interface PermissionRequest {
  readonly sessionId: string;
  readonly toolName: string;
  readonly description: string;
  readonly input: unknown;
}

// ─── AgentMessage ─────────────────────────────────────────────────────────────

/**
 * Union type of JSON-RPC messages received from the agent server.
 *
 * - Response with result
 * - Response with error
 * - Notification (no id)
 */
export type AgentMessage =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string } }
  | { jsonrpc: "2.0"; method: string; params: unknown };

// ─── SessionUpdatePayload ─────────────────────────────────────────────────────

/**
 * Payload of a `session/update` notification from the server.
 *
 * The server uses `sessionUpdate: "agent_message_chunk"` (NOT `type: "text_delta"`).
 * See: src/protocol/handlers/session-prompt.ts
 */
export interface SessionUpdatePayload {
  sessionId: string;
  update: {
    sessionUpdate: "agent_message_chunk";
    content: { type: "text"; text: string };
  };
}
