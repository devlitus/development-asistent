/**
 * TuiState — mutable state container for the TUI client.
 *
 * Encapsulates:
 *   - Current TuiStatus
 *   - Immutable message history
 *   - Streaming text buffer (accumulates chunks before flushing)
 *   - Pending permission request (if any)
 *
 * All getters return copies / readonly views so external code cannot
 * mutate internal state directly.
 */

import type { TuiStatus, TuiMessage, PermissionRequest } from "./types.ts";

export class TuiState {
  // ── Private fields ──────────────────────────────────────────────────────────

  #status: TuiStatus = "connecting";
  #messages: TuiMessage[] = [];
  #streamChunks: string[] = [];
  #pendingPermission: PermissionRequest | null = null;

  // ── Getters ─────────────────────────────────────────────────────────────────

  /** Current status of the TUI client. */
  get status(): TuiStatus {
    return this.#status;
  }

  /**
   * Readonly view of the conversation history.
   * Returns a readonly reference — no copy — for O(1) access.
   * External code cannot push/pop but can read all elements.
   */
  get messages(): readonly TuiMessage[] {
    return this.#messages as readonly TuiMessage[];
  }

  /** Pending permission request, or null if none. */
  get pendingPermission(): PermissionRequest | null {
    return this.#pendingPermission;
  }

  /** Current accumulated stream text (not yet flushed as a message). */
  get currentStreamBuffer(): string {
    return this.#streamChunks.join("");
  }

  /** Number of messages in the conversation history. */
  get messageCount(): number {
    return this.#messages.length;
  }

  // ── Mutators ─────────────────────────────────────────────────────────────────

  /** Transition to a new status. */
  setStatus(s: TuiStatus): void {
    this.#status = s;
  }

  /** Append a message to the conversation history. */
  addMessage(m: TuiMessage): void {
    this.#messages.push(m);
  }

  /** Accumulate a text chunk into the stream buffer. */
  appendStream(text: string): void {
    this.#streamChunks.push(text);
  }

  /**
   * Flush the stream buffer:
   *   - If the buffer is non-empty, saves it as an "agent" message.
   *   - Clears the buffer regardless.
   */
  flushStream(): void {
    if (this.#streamChunks.length > 0) {
      this.#messages.push({
        role: "agent",
        content: this.#streamChunks.join(""),
        timestamp: Date.now(),
      });
      // Reuse array reference to avoid GC pressure on frequent flushes (TS-NEW-3)
      this.#streamChunks.length = 0;
    }
  }

  /** Store a pending permission request. */
  setPendingPermission(req: PermissionRequest): void {
    this.#pendingPermission = req;
  }

  /** Clear the pending permission request. */
  clearPendingPermission(): void {
    this.#pendingPermission = null;
  }
}
