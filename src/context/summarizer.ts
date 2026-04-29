/**
 * Summarizer — generates a condensed summary of a list of ChatMessages
 * using an LLMProvider.
 */

import type { ChatMessage, LLMProvider } from "../types/llm.ts";

const SUMMARIZE_SYSTEM_PROMPT =
  "Resume la siguiente conversación manteniendo los puntos clave, " +
  "decisiones y contexto técnico relevante. Sé conciso pero completo.";

/**
 * Sanitize role delimiters inside message content to prevent prompt injection.
 *
 * SEC-05: If a message contains `[user]:`, `[assistant]:`, or `[system]:`,
 * those sequences are replaced with `{user}:`, `{assistant}:`, `{system}:`
 * so the LLM cannot interpret them as new conversation turns.
 */
export function sanitizeRoleDelimiter(content: string): string {
  return content
    .replace(/\[user\]:/gi, "{user}:")
    .replace(/\[assistant\]:/gi, "{assistant}:")
    .replace(/\[system\]:/gi, "{system}:");
}

export class Summarizer {
  private readonly llm: LLMProvider;

  constructor(llmProvider: LLMProvider) {
    this.llm = llmProvider;
  }

  /**
   * Generates a summary of the given messages.
   * Throws if the LLM returns an empty response.
   */
  async summarize(messages: ChatMessage[]): Promise<string> {
    if (messages.length === 0) {
      throw new Error("Summarizer: cannot summarize an empty message list");
    }

    // Build a single user message containing the conversation transcript.
    // SEC-05: sanitize role delimiters in content to prevent prompt injection.
    const transcript = messages
      .map((m) => `[${m.role}]: ${sanitizeRoleDelimiter(m.content)}`)
      .join("\n");

    const prompt: ChatMessage[] = [
      { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ];

    const response = await this.llm.chat(prompt);

    if (!response.content || response.content.trim().length === 0) {
      throw new Error("Summarizer: LLM returned empty summary");
    }

    return response.content;
  }
}
