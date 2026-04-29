/**
 * Ollama LLM provider implementation.
 *
 * Communicates with a local Ollama server via HTTP POST to /api/chat.
 * Supports both streaming (NDJSON) and non-streaming responses.
 */

import type {
  ChatMessage,
  LLMChatOptions,
  LLMChunk,
  LLMProvider,
  LLMResponse,
  ToolCall,
} from "../../types/llm.ts";
import { normalizeLLMError } from "../errors.ts";

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2";
const DEFAULT_TIMEOUT_MS = 120_000;

/** Ollama tool call shape in responses. */
interface OllamaToolCall {
  readonly function: {
    readonly name: string;
    readonly arguments: unknown; // Ollama returns an object, not a string
  };
}

/** Ollama /api/chat response shape. */
interface OllamaChatResponse {
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
    readonly tool_calls?: readonly OllamaToolCall[];
  };
  readonly done?: boolean;
  readonly done_reason?: string;
}

/** Build the request body for Ollama /api/chat, including tool_calls and tool_call_id. */
function buildBody(
  messages: readonly ChatMessage[],
  options: LLMChatOptions | undefined,
  stream: boolean,
): unknown {
  const body: Record<string, unknown> = {
    model: options?.model ?? DEFAULT_MODEL,
    messages: messages.map((m) => {
      const base: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };

      // Map tool_calls from our format to Ollama format
      if (m.tool_calls && m.tool_calls.length > 0) {
        base.tool_calls = m.tool_calls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }

      // Map tool_call_id for tool role messages
      if (m.tool_call_id) {
        base.tool_call_id = m.tool_call_id;
      }

      return base;
    }),
    stream,
    ...(options?.temperature !== undefined || options?.maxTokens !== undefined
      ? {
          options: {
            ...(options.temperature !== undefined
              ? { temperature: options.temperature }
              : {}),
            ...(options.maxTokens !== undefined
              ? { num_predict: options.maxTokens }
              : {}),
          },
        }
      : {}),
  };

  // Include tools in Ollama format when provided
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  return body;
}

/** Parse a single NDJSON line from Ollama stream. */
function parseStreamLine(line: string): { content: string; done: boolean } {
  try {
    const data = JSON.parse(line) as OllamaChatResponse;
    return {
      content: data.message?.content ?? "",
      done: data.done ?? false,
    };
  } catch (err) {
    // Log malformed NDJSON lines to stderr (does not break ACP protocol)
    console.error(`[ollama] Failed to parse NDJSON line: ${String(err)}`);
    return { content: "", done: false };
  }
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private readonly host: string;

  constructor(host?: string) {
    this.host = host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  }

  /**
   * Shared POST helper with AbortController timeout and error normalization.
   * Eliminates duplication between chat() and stream().
   */
  private async post(body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw normalizeLLMError(error, this.host, "ollama");
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      // Include response body in error for better diagnostics (#10)
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        // Ignore body read errors
      }
      const suffix = errorBody ? `: ${errorBody}` : `: ${response.statusText}`;
      throw new Error(
        `Ollama request failed (${response.status})${suffix}`,
      );
    }

    return response;
  }

  async chat(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    const body = buildBody(messages, options, false);
    const response = await this.post(body);

    const data = (await response.json()) as OllamaChatResponse;

    // Map tool_calls if present (Ollama returns arguments as object, we stringify)
    const rawToolCalls = data.message?.tool_calls;
    if (rawToolCalls && rawToolCalls.length > 0) {
      const tool_calls: ToolCall[] = rawToolCalls.map((tc) => ({
        id: crypto.randomUUID(),
        name: tc.function.name,
        // If Ollama already returns arguments as a pre-serialized JSON string, use it as-is.
        // Otherwise (object), stringify it. Prevents double-encoding.
        arguments: typeof tc.function.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments),
      }));

      return {
        content: data.message?.content ?? "",
        finishReason: "tool_calls",
        tool_calls,
      };
    }

    return {
      content: data.message?.content ?? "",
      finishReason: data.done ? "stop" : null,
    };
  }

  async *stream(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): AsyncIterable<LLMChunk> {
    const body = buildBody(messages, options, true);
    const response = await this.post(body);

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Ollama stream: no response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = parseStreamLine(line);
          yield {
            delta: parsed.content,
            finishReason: parsed.done ? "stop" : undefined,
          };
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const parsed = parseStreamLine(buffer.trim());
        yield {
          delta: parsed.content,
          finishReason: parsed.done ? "stop" : undefined,
        };
      }
    } finally {
      // Cancel reader to close the HTTP connection if consumer exits early (#4)
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors
      }
      reader.releaseLock();
    }
  }
}
