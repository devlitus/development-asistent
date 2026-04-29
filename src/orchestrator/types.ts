/**
 * Orchestrator types: events, config, extended context, and contracts.
 *
 * This module defines all TypeScript types needed by the orchestrator
 * module. It builds on top of the base types from `src/types/`.
 *
 * Key design decisions:
 * - AgentEvent is a discriminated union for exhaustive pattern matching
 * - ExtendedAgentContext extends AgentContext without modifying it
 * - SessionHistoryProvider decouples history source from orchestrator
 */

import type {
  AgentContext,
  AgentType,
  ChatMessage,
  JsonSchema,
  LLMProvider,
  SessionId,
} from "../types/index.ts";

// ─── Re-exports for convenience ───────────────────────────────────
// Consumers can import base types from the orchestrator barrel
// without reaching into src/types/ directly.

export type {
  AgentContext,
  AgentType,
  AgentResult,
  Agent,
} from "../types/agent.ts";

export type {
  ChatMessage,
  ChatRole,
  JsonSchema,
  LLMProvider,
  LLMResponse,
  LLMChunk,
  LLMChatOptions,
  ToolCall,
  ToolResult,
} from "../types/llm.ts";

export type { SessionId, TurnId, MessageId } from "../types/persistence.ts";

export { AGENT_TYPES } from "../types/agent.ts";

// ─── ToolCallStatus ───────────────────────────────────────────────

/** Possible statuses for a tool call event. */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** Const object for runtime iteration over ToolCallStatus values. */
export const TOOL_CALL_STATUSES = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

// ─── AgentEvent (Discriminated Union) ─────────────────────────────

/**
 * Unified event type emitted by the orchestrator during agent execution.
 *
 * Uses discriminated union pattern on `type` field for exhaustive
 * pattern matching via switch/if statements.
 */
export type AgentEvent =
  | { readonly type: "text"; readonly content: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
      readonly status: ToolCallStatus;
    }
  | {
      readonly type: "permission_request";
      readonly id: string;
      readonly tool: string;
      readonly args: unknown;
    }
  | { readonly type: "error"; readonly error: string; readonly message: string }
  | { readonly type: "done"; readonly success: boolean };

// ─── ToolDefinition ───────────────────────────────────────────────

/**
 * Describes a tool available for the orchestrator and sub-agents.
 *
 * Mirrors the tool definition format used by LLM chat APIs
 * (Anthropic, OpenAI) but kept provider-agnostic.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

// ─── ExtendedAgentContext ─────────────────────────────────────────

/**
 * Extended context passed to sub-agents by the orchestrator.
 *
 * Extends the base `AgentContext` with dependencies that sub-agents
 * need: an LLM provider, full session history, and available tools.
 *
 * Key difference from AgentContext:
 * - `sessionHistory` is required (not optional)
 * - Adds `workspacePath`, `llmProvider`, `availableTools`
 */
export interface ExtendedAgentContext extends AgentContext {
  /** Absolute path to the workspace root. */
  readonly workspacePath: string;

  /** LLM provider instance for the agent to use. */
  readonly llmProvider: LLMProvider;

  /** Full session history (required, not optional). */
  readonly sessionHistory: readonly ChatMessage[];

  /** Tools available to the agent. */
  readonly availableTools: readonly ToolDefinition[];
}

// ─── OrchestratorConfig ───────────────────────────────────────────

/**
 * Configuration for the orchestrator.
 *
 * Required fields provide the minimum needed to run:
 * - A provider for intent classification
 * - A default timeout for agent execution
 *
 * Optional fields tune behavior like retries and context window size.
 */
export interface OrchestratorConfig {
  /** LLM provider used for intent classification. */
  readonly classificationProvider: LLMProvider;

  /** Default timeout in milliseconds for agent execution. */
  readonly defaultTimeout: number;

  /** Maximum number of retries on agent failure. Default: 1. */
  readonly maxRetries?: number;

  /**
   * Number of recent messages to keep in context window.
   * Older messages are summarized. Default: 10.
   */
  readonly slidingWindowSize?: number;
}

// ─── IntentClassification ─────────────────────────────────────────

/**
 * Result of classifying a user prompt to determine which sub-agent
 * should handle it.
 */
export interface IntentClassificationResult {
  /** The agent type selected to handle the prompt. */
  readonly agentType: AgentType;

  /** Confidence score between 0 and 1. */
  readonly confidence: number;

  /** Human-readable explanation of the classification decision. */
  readonly reasoning: string;
}

/**
 * Contract for intent classification.
 *
 * Implementations receive the user prompt and session history,
 * and return which agent should handle the request.
 *
 * This interface allows swapping between:
 * - LLM-based classification (production)
 * - Rule-based classification (simple fallback)
 * - Mock classification (tests)
 */
export interface IntentClassifier {
  classify(
    prompt: string,
    history: readonly ChatMessage[],
  ): Promise<IntentClassificationResult>;
}

// ─── SessionHistoryProvider ───────────────────────────────────────

/**
 * Decouples the orchestrator from the persistence layer by providing
 * a contract for retrieving session history.
 *
 * Implementations:
 * - Production: backed by SQLite (reads from messages table)
 * - Tests: backed by a simple Map or fixed array
 * - In-memory: backed by a Map for v1 without persistence
 */
export interface SessionHistoryProvider {
  getHistory(sessionId: SessionId): Promise<readonly ChatMessage[]>;
}
