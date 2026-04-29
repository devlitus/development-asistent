/**
 * Factory for creating LLM provider instances from configuration.
 */

import type { LLMProvider } from "../../types/llm.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { LlamaCppProvider } from "./providers/llamacpp.ts";
import { LMStudioProvider } from "./providers/lmstudio.ts";

export type ProviderConfig =
  | { readonly type: "anthropic" | "openai"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "ollama" | "llamacpp" | "lmstudio"; readonly apiKey?: never; readonly baseURL?: string };

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config.apiKey);
    case "openai":
      return new OpenAIProvider(config.apiKey, config.baseURL);
    case "ollama":
      return new OllamaProvider(config.baseURL);
    case "llamacpp":
      return new LlamaCppProvider(config.baseURL);
    case "lmstudio":
      return new LMStudioProvider(config.baseURL);
    default: {
      // Exhaustiveness check
      const _exhaustive: never = config.type;
      throw new Error(`Unknown provider type: ${_exhaustive}`);
    }
  }
}
