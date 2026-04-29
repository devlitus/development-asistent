/**
 * In-memory session history provider for v1 (no persistence).
 *
 * Stores session messages in a Map keyed by session ID.
 * Used when no SQLite-backed persistence is available.
 *
 * Thread-safety: Not thread-safe. Designed for single-threaded Bun runtime.
 */

import type { SessionId } from "../types/persistence.ts";
import type { ChatMessage, SessionHistoryProvider } from "./types.ts";

export class InMemoryHistoryProvider implements SessionHistoryProvider {
  private readonly store = new Map<string, ChatMessage[]>();

  /**
   * Adds a message to the session history.
   *
   * @param sessionId - The session to add the message to.
   * @param message - The chat message to append.
   */
  addMessage(sessionId: SessionId, message: ChatMessage): void {
    const key = sessionId as string;
    const existing = this.store.get(key);
    if (existing) {
      existing.push(message);
    } else {
      this.store.set(key, [message]);
    }
  }

  /**
   * Retrieves the full session history.
   *
   * Returns a defensive copy so callers cannot mutate internal state.
   *
   * @param sessionId - The session to look up.
   * @returns A readonly array of chat messages (empty if session not found).
   */
  async getHistory(sessionId: SessionId): Promise<readonly ChatMessage[]> {
    const key = sessionId as string;
    const messages = this.store.get(key);
    if (!messages) {
      return [];
    }
    // Return a defensive copy
    return [...messages];
  }
}
