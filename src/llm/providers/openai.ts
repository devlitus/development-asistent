/**
 * OpenAI (and compatible APIs) LLM provider implementation.
 */

import OpenAI from "openai";
import type {
  ChatMessage,
  JsonSchema,
  LLMChatOptions,
  LLMChunk,
  LLMProvider,
  LLMResponse,
  ToolCall,
} from "../../types/llm.ts";
import { normalizeLLMError } from "../errors.ts";

const DEFAULT_MODEL = "gpt-4o";

/** Convert our ChatMessage[] to OpenAI's chat completion message format. */
function mapMessages(
  messages: readonly ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })),
      };
    }

    if (msg.role === "tool") {
      return {
        role: "tool",
        content: msg.content,
        tool_call_id: msg.tool_call_id ?? "",
      };
    }

    return {
      role: msg.role,
      content: msg.content,
    };
  });
}

/** Extract text content + tool_calls from OpenAI response message (legacy XML serialization). */
function extractContent(
  message: OpenAI.Chat.Completions.ChatCompletionMessage | null | undefined,
): string {
  if (!message) {
    return "";
  }

  const parts: string[] = [];

  if (message.content) {
    parts.push(message.content);
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      const id = tc.id ?? "";
      const name = tc.function?.name ?? "";
      const args = tc.function?.arguments ?? "";
      parts.push(`<tool_call id="${id}" name="${name}">\n${args}\n</tool_call>`);
    }
  }

  return parts.join("\n\n");
}

/** Map generic tool definitions to OpenAI's function calling format. */
function mapToolsToOpenAI(
  tools: Array<{ name: string; description: string; parameters: JsonSchema }>,
): Array<{ type: "function"; function: { name: string; description: string; parameters: JsonSchema } }> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Extract structured tool_calls from OpenAI response message. */
function extractToolCalls(
  message: OpenAI.Chat.Completions.ChatCompletionMessage | null | undefined,
): ToolCall[] | undefined {
  if (!message?.tool_calls || message.tool_calls.length === 0) {
    return undefined;
  }
  return message.tool_calls.map((tc) => {
    if (!tc.id || !tc.function?.name || !tc.function?.arguments) {
      console.error(
        `[openai] Warning: incomplete tool_call received (id=${tc.id ?? "missing"}, name=${tc.function?.name ?? "missing"})`,
      );
    }
    return {
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "",
    };
  });
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async chat(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const openaiMessages = mapMessages(messages);
    const hasTools = (options?.tools?.length ?? 0) > 0;

    try {
      // Build request params. Use `as any` only for the `enable_thinking` field
      // which is a LM Studio / Qwen3 extension not present in the OpenAI SDK types.
      // All other fields are fully typed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const requestParams: any = {
        model: options?.model ?? DEFAULT_MODEL,
        messages: openaiMessages,
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options?.maxTokens !== undefined
          ? { max_tokens: options.maxTokens }
          : {}),
        ...(hasTools && options?.tools
          ? { tools: mapToolsToOpenAI(options.tools) }
          : {}),
        // LM Studio / Qwen3: disable chain-of-thought thinking tokens
        // to reduce latency for fast routing calls.
        ...(options?.disableThinking === true
          ? { enable_thinking: false }
          : {}),
      };
      const response = await this.client.chat.completions.create(requestParams);

      const choice = (response.choices ?? [])[0];

      if (hasTools) {
        const toolCalls = extractToolCalls(choice?.message);
        return {
          content: choice?.message?.content ?? "",
          tool_calls: toolCalls,
          usage: response.usage
            ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
              }
            : undefined,
          finishReason: choice?.finish_reason ?? null,
        };
      }

      // Backward-compatible path: serialize tool_calls as XML in content
      const content = extractContent(choice?.message);

      return {
        content,
        usage: response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
            }
          : undefined,
        finishReason: choice?.finish_reason ?? null,
      };
    } catch (error) {
      throw normalizeLLMError(error);
    }
  }

  async *stream(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): AsyncIterable<LLMChunk> {
    const openaiMessages = mapMessages(messages);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamParams: any = {
        model: options?.model ?? DEFAULT_MODEL,
        messages: openaiMessages,
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options?.maxTokens !== undefined
          ? { max_tokens: options.maxTokens }
          : {}),
        // LM Studio / Qwen3: disable thinking for stream calls as well.
        ...(options?.disableThinking === true
          ? { enable_thinking: false }
          : {}),
        stream: true,
      };
      const stream = await this.client.chat.completions.create(streamParams);

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content ?? "";
        const finishReason = choice?.finish_reason ?? undefined;

        yield { delta, finishReason };
      }
    } catch (error) {
      throw normalizeLLMError(error);
    }
  }
}
