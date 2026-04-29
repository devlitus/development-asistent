/**
 * LLM provider layer types.
 *
 * These contracts are intentionally backend-agnostic so that
 * cloud providers (Anthropic, OpenAI) and local runners
 * (Ollama, llama.cpp) can all implement the same interface.
 */

/** JSON Schema object used for tool parameter definitions. */
export type JsonSchema = Record<string, unknown>;

/** Known finish reason values from LLM providers. */
export type FinishReason =
  | "end_turn"      // Anthropic
  | "stop"          // OpenAI
  | "tool_use"      // Anthropic tool calling
  | "tool_calls"    // OpenAI tool calling
  | "max_tokens"    // Both
  | (string & {});  // Allow unknown values

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly tool_calls?: ToolCall[];
  readonly tool_call_id?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON-encoded arguments string. */
  readonly arguments: string;
}

export interface ToolResult {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "failed";
}

export interface LLMUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface LLMResponse {
  readonly content: string;
  readonly usage?: LLMUsage;
  /**
   * Why the model stopped generating.
   * Common values: `"end_turn"`, `"stop"`, `"tool_use"` (Anthropic),
   * `"tool_calls"` (OpenAI). When `"tool_use"` or `"tool_calls"`,
   * the `tool_calls` field will typically be populated.
   */
  readonly finishReason?: FinishReason | null;
  /**
   * Structured tool calls returned by the LLM.
   * Populated when the model decides to invoke one or more tools
   * (indicated by `finishReason: "tool_use"` for Anthropic or
   * `"tool_calls"` for OpenAI). Each entry contains the tool `id`,
   * `name`, and JSON-encoded `arguments`.
   */
  readonly tool_calls?: ToolCall[];
}

/** Options for a single LLM chat or stream request. */
export interface LLMChatOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly tools?: Array<{
    name: string;
    description: string;
    parameters: JsonSchema;
  }>;
  /**
   * When `true`, instructs the provider to disable extended thinking / chain-of-thought
   * tokens before the visible response. Useful for fast single-word routing calls where
   * thinking adds latency without benefit.
   *
   * Supported by: LM Studio (Qwen3 and other thinking models via `enable_thinking: false`).
   * Ignored by providers that do not support thinking modes.
   */
  readonly disableThinking?: boolean;
}

/** A single streaming delta yielded by LLMProvider.stream(). */
export interface LLMChunk {
  readonly delta: string;
  readonly finishReason?: FinishReason | null;
}

export interface LLMProvider {
  readonly name: string;

  /** Non-streaming chat completion. */
  chat(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse>;

  /** Streaming chat completion yielding deltas. */
  stream(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): AsyncIterable<LLMChunk>;
}
