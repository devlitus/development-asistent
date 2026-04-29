/**
 * LM Studio LLM provider implementation.
 *
 * LM Studio exposes an OpenAI-compatible API at {host}/v1/chat/completions.
 * This provider is a thin wrapper around OpenAIProvider that sets the baseURL
 * to `{host}/v1` so the OpenAI SDK constructs the correct endpoint URL.
 *
 * LM_STUDIO_HOST env var stores only the host:port (e.g. http://localhost:1234).
 * Default model: any model loaded in LM Studio UI (pass model name in LLMChatOptions).
 */

import type {
  ChatMessage,
  LLMChatOptions,
  LLMChunk,
  LLMProvider,
  LLMResponse,
} from "../../types/llm.ts";
import { OpenAIProvider } from "./openai.ts";

const DEFAULT_HOST = "http://localhost:1234";
/** LM Studio does not require authentication — placeholder value expected by SDK. */
const NO_API_KEY = "lm-studio";

export class LMStudioProvider implements LLMProvider {
  readonly name = "lmstudio";
  private readonly inner: OpenAIProvider;
  /** Exposed for testing — the full baseURL passed to OpenAIProvider. */
  private readonly baseURL: string;

  constructor(host?: string) {
    // Resolve: empty string ("") must be treated as absent → DEFAULT_HOST
    const rawHost = host || process.env.LM_STUDIO_HOST || DEFAULT_HOST;

    // Normalize: remove trailing slash(es)
    const normalizedHost = rawHost.replace(/\/+$/, "");

    // Validate: only http:// or https:// allowed (prevents SSRF with file://, ftp://, etc.)
    let parsedURL: URL;
    try {
      parsedURL = new URL(normalizedHost);
    } catch {
      throw new Error(
        `[lmstudio] Invalid host URL: "${normalizedHost}". Expected format: "http://host:port"`,
      );
    }
    if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
      throw new Error(
        `[lmstudio] Host must use http:// or https://, got: "${parsedURL.protocol}"`,
      );
    }

    // OpenAI SDK appends /chat/completions to baseURL.
    // LM Studio serves OpenAI-compat at {host}/v1/chat/completions,
    // so we must pass baseURL = normalizedHost + "/v1".
    this.baseURL = `${normalizedHost}/v1`;
    this.inner = new OpenAIProvider(NO_API_KEY, this.baseURL);
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
