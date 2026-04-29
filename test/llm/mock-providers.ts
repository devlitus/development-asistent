/**
 * Reusable mock LLM provider utilities for tests.
 *
 * These are in-memory implementations of the LLMProvider interface.
 * Do NOT use mock.module() here — these are pure in-memory implementations.
 */

import type { LLMProvider, ChatMessage, LLMChatOptions, LLMChunk, LLMResponse } from "../../src/types/llm.ts";

/**
 * Creates a mock LLMProvider that always returns a fixed text response.
 */
export function createMockLLMProvider(responseText = "mock response"): LLMProvider {
  return {
    name: "mock-llm",
    async chat(_messages: readonly ChatMessage[], _options?: LLMChatOptions): Promise<LLMResponse> {
      return { content: responseText, finishReason: "stop" };
    },
    async *stream(_messages: readonly ChatMessage[], _options?: LLMChatOptions): AsyncIterable<LLMChunk> {
      yield { delta: responseText, finishReason: "stop" };
    },
  };
}

/**
 * Internal helper: resolves the agent type from the last user message in a list.
 * Used by createRoutingLLMProvider to keep chat() and stream() consistent.
 */
function resolveRoutingAgentType(messages: readonly ChatMessage[]): string {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const text = (lastUserMsg?.content ?? "").toLowerCase();
  if (text.includes("git") || text.includes("commit") || text.includes("branch")) return "git";
  if (text.includes("run") || text.includes("execute") || text.includes("shell") || text.includes("bun")) return "os";
  if (text.includes("docs") || text.includes("search web") || text.includes("documentation")) return "docs";
  return "code";
}

/**
 * Creates a mock LLMProvider that routes based on prompt content.
 * If the prompt includes "git", "commit", "branch" → returns "git"
 * If the prompt includes "run", "execute", "shell", "bun" → returns "os"
 * If the prompt includes "docs", "search web", "documentation" → returns "docs"
 * Otherwise → returns "code"
 *
 * Both chat() and stream() use the same routing logic for consistency.
 */
export function createRoutingLLMProvider(): LLMProvider {
  return {
    name: "routing-mock-llm",
    async chat(messages: readonly ChatMessage[], _options?: LLMChatOptions): Promise<LLMResponse> {
      const agentType = resolveRoutingAgentType(messages);
      return { content: agentType, finishReason: "stop" };
    },
    async *stream(messages: readonly ChatMessage[], _options?: LLMChatOptions): AsyncIterable<LLMChunk> {
      const agentType = resolveRoutingAgentType(messages);
      yield { delta: agentType, finishReason: "stop" };
    },
  };
}

/**
 * Creates a mock LLMProvider that always throws an error.
 */
export function createFailingLLMProvider(errorMsg = "LLM provider error"): LLMProvider {
  return {
    name: "failing-mock-llm",
    async chat(_messages: readonly ChatMessage[], _options?: LLMChatOptions): Promise<LLMResponse> {
      throw new Error(errorMsg);
    },
    async *stream(_messages: readonly ChatMessage[], _options?: LLMChatOptions): AsyncIterable<LLMChunk> {
      throw new Error(errorMsg);
    },
  };
}

/**
 * Creates a mock LLMProvider that returns a tool_call response.
 */
export function createToolCallLLMProvider(
  toolName: string,
  args: Record<string, unknown> = {},
): LLMProvider {
  return {
    name: "tool-call-mock-llm",
    async chat(_messages: readonly ChatMessage[], _options?: LLMChatOptions): Promise<LLMResponse> {
      return {
        content: "",
        finishReason: "tool_use",
        tool_calls: [
          {
            id: `call_${toolName}_1`,
            name: toolName,
            arguments: JSON.stringify(args),
          },
        ],
      };
    },
    async *stream(_messages: readonly ChatMessage[], _options?: LLMChatOptions): AsyncIterable<LLMChunk> {
      yield { delta: "", finishReason: "tool_use" };
    },
  };
}
