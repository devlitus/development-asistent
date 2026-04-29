/**
 * llama.cpp server LLM provider implementation.
 *
 * The llama.cpp server exposes an OpenAI-compatible API at /v1/chat/completions.
 * This provider is a thin wrapper around OpenAIProvider that sets the baseURL
 * to the llama.cpp server host.
 */

import type {
  ChatMessage,
  LLMChatOptions,
  LLMChunk,
  LLMProvider,
  LLMResponse,
} from "../../types/llm.ts";
import { OpenAIProvider } from "./openai.ts";

const DEFAULT_HOST = "http://localhost:8080";
/** llama.cpp server does not require authentication — placeholder value. */
const NO_API_KEY = "not-needed";

export class LlamaCppProvider implements LLMProvider {
  readonly name = "llamacpp";
  private readonly inner: OpenAIProvider;

  constructor(host?: string) {
    const baseURL = host ?? process.env.LLAMACPP_HOST ?? DEFAULT_HOST;
    this.inner = new OpenAIProvider(NO_API_KEY, baseURL);
  }

  chat(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    return this.inner.chat(messages, options);
  }

  stream(
    messages: readonly ChatMessage[],
    options?: LLMChatOptions,
  ): AsyncIterable<LLMChunk> {
    return this.inner.stream(messages, options);
  }
}
