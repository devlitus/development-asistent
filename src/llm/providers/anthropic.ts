/**
 * Anthropic (Claude) LLM provider implementation.
 */

import Anthropic from "@anthropic-ai/sdk";
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

const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

/** Convert our ChatMessage[] to Anthropic's message format. */
function mapMessages(
  messages: readonly ChatMessage[],
): {
  system?: string;
  anthropicMessages: Anthropic.Messages.MessageParam[];
} {
  let system: string | undefined;
  const anthropicMessages: Anthropic.Messages.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = system ? `${system}\n\n${msg.content}` : msg.content;
      continue;
    }

    if (msg.role === "user") {
      anthropicMessages.push({ role: "user", content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content: Anthropic.Messages.ContentBlockParam[] = msg.tool_calls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeJsonParse(tc.arguments),
        }));
        if (msg.content) {
          content.unshift({ type: "text", text: msg.content });
        }
        anthropicMessages.push({ role: "assistant", content });
      } else {
        anthropicMessages.push({ role: "assistant", content: msg.content });
      }
      continue;
    }

    if (msg.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: msg.content,
          },
        ],
      });
      continue;
    }
  }

  return { system, anthropicMessages };
}

/** Extract text content from Anthropic response blocks. */
function extractContent(content: Anthropic.Messages.ContentBlock[]): string {
  const textParts: string[] = [];
  const toolParts: string[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolParts.push(`<tool_use name="${block.name}" id="${block.id}">\n${JSON.stringify(block.input)}\n</tool_use>`);
    }
  }

  const text = textParts.join("");
  if (toolParts.length > 0) {
    return text ? `${text}\n\n${toolParts.join("\n\n")}` : toolParts.join("\n\n");
  }
  return text;
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/** Extract tool_use blocks from Anthropic response content as structured ToolCall[]. */
function extractToolCalls(content: Anthropic.Messages.ContentBlock[]): ToolCall[] | undefined {
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}

/** Map generic tool definitions to Anthropic's API format. */
function mapToolsToAnthropic(
  tools: Array<{ name: string; description: string; parameters: JsonSchema }>,
): Array<{ name: string; description: string; input_schema: JsonSchema }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const { system, anthropicMessages } = mapMessages(messages);

    try {
      const hasTools = (options?.tools?.length ?? 0) > 0;

      const response = await this.client.messages.create({
        model: options?.model ?? DEFAULT_MODEL,
        max_tokens: options?.maxTokens ?? 1024,
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(system ? { system } : {}),
        messages: anthropicMessages,
        ...(hasTools && options?.tools
          ? { tools: mapToolsToAnthropic(options.tools) }
          : {}),
      });

      const rawContent = response.content ?? [];

      if (hasTools) {
        const toolCalls = extractToolCalls(rawContent);
        const textContent = rawContent
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");

        return {
          content: textContent,
          tool_calls: toolCalls,
          usage: response.usage
            ? {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
              }
            : undefined,
          finishReason: response.stop_reason ?? null,
        };
      }

      // Backward-compatible path: serialize tool_use blocks as XML in content
      const content = extractContent(rawContent);

      return {
        content,
        usage: response.usage
          ? {
              promptTokens: response.usage.input_tokens,
              completionTokens: response.usage.output_tokens,
            }
          : undefined,
        finishReason: response.stop_reason ?? null,
      };
    } catch (error) {
      throw normalizeLLMError(error);
    }
  }

  async *stream(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): AsyncIterable<LLMChunk> {
    const { system, anthropicMessages } = mapMessages(messages);

    try {
      const stream = await this.client.messages.create({
        model: options?.model ?? DEFAULT_MODEL,
        max_tokens: options?.maxTokens ?? 1024,
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(system ? { system } : {}),
        messages: anthropicMessages,
        stream: true,
      });

      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield { delta: ev.delta.text ?? "", finishReason: undefined };
        } else if (ev.type === "message_delta") {
          yield { delta: "", finishReason: ev.delta.stop_reason };
        }
      }
    } catch (error) {
      throw normalizeLLMError(error);
    }
  }
}
