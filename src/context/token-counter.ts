/**
 * Token estimation utilities.
 *
 * Uses a simple heuristic: Math.ceil(chars / 4).
 * This is intentionally approximate — no tiktoken dependency needed for v1.
 */

import type { ChatMessage } from "../types/llm.ts";

/**
 * Estimate the number of tokens in a plain text string.
 * Heuristic: ceil(length / 4).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the number of tokens for a single ChatMessage,
 * including role, content, and optional tool_calls JSON.
 */
export function estimateMessageTokens(msg: ChatMessage): number {
  let text = msg.role + msg.content;
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    text += JSON.stringify(msg.tool_calls);
  }
  return estimateTokens(text);
}

/**
 * Estimate the total number of tokens for a list of ChatMessages.
 */
export function estimateChatTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}
