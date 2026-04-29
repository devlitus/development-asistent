/**
 * Persistence layer types for SQLite.
 *
 * These types mirror the schema used by `bun:sqlite` tables:
 * sessions, turns, messages, tool_calls, summaries.
 */

/** Branded type to prevent mixing SessionId with plain strings. */
export type SessionId = string & { readonly __brand: "SessionId" };

/**
 * Factory function to create a SessionId from a plain string.
 *
 * Centralizes the branded type cast in one place, making it easy to
 * audit or add validation logic later (e.g., UUID format check).
 */
export function asSessionId(s: string): SessionId {
  return s as SessionId;
}

/** Branded type to prevent mixing TurnId with plain strings. */
export type TurnId = string & { readonly __brand: "TurnId" };

/** Branded type to prevent mixing MessageId with plain strings. */
export type MessageId = string & { readonly __brand: "MessageId" };

/**
 * Factory function to create a MessageId from a plain string.
 */
export function asMessageId(s: string): MessageId {
  return s as MessageId;
}

/** Branded type to prevent mixing ToolCallId with plain strings. */
export type ToolCallId = string & { readonly __brand: "ToolCallId" };

/** Branded type to prevent mixing SummaryId with plain strings. */
export type SummaryId = number & { readonly __brand: "SummaryId" };

export interface Session {
  readonly id: SessionId;
  readonly workspacePath: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Turn {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly prompt: string;
  readonly stopReason: string;
  readonly createdAt: number;
}

export interface MessageRow {
  readonly id: MessageId;
  readonly turnId: TurnId;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly createdAt: number;
}

export interface ToolCallRow {
  readonly id: ToolCallId;
  readonly turnId: TurnId;
  readonly toolName: string;
  readonly arguments: string;
  readonly result: string | null;
  readonly createdAt: number;
}

export interface SummaryRow {
  readonly id: SummaryId;
  readonly sessionId: SessionId;
  readonly content: string;
  readonly originalMessageFromId: MessageId;
  readonly originalMessageToId: MessageId;
  readonly createdAt: number;
}

export interface MigrationRecord {
  readonly id: number;
  readonly name: string;
  readonly appliedAt: number;
}
