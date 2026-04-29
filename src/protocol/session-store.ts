/**
 * In-memory session store for ACP sessions.
 *
 * Maintains a Map of active sessions keyed by session ID.
 * In the spike phase, sessions live only in memory.
 * Persistence will be added in a later task (SQLite).
 */

/** Default max age for sessions: 24 hours. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** State for a single ACP session. */
export interface SessionState {
  /** Unique session identifier (UUID v4). */
  readonly id: string;
  /** Working directory for this session. */
  readonly cwd: string;
  /** Timestamp (epoch ms) when the session was created. */
  readonly createdAt: number;
}

/**
 * Simple in-memory store for ACP sessions.
 *
 * Uses `crypto.randomUUID()` for generating unique session IDs.
 * Thread-safe within the Bun single-threaded event loop.
 *
 * Supports lazy TTL-based eviction on `get()` and explicit
 * cleanup via `delete()` / `evictExpired()`.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxAgeMs: number;

  constructor(options?: { maxAgeMs?: number }) {
    this.maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /**
   * Create a new session and store it.
   *
   * @param cwd - Working directory for the session.
   * @returns The newly created session state.
   */
  create(cwd: string): SessionState {
    const id = crypto.randomUUID();
    const session: SessionState = Object.freeze({ id, cwd, createdAt: Date.now() });
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Retrieve a session by its ID.
   *
   * Performs lazy eviction: if the session has expired, it is
   * removed and `undefined` is returned.
   *
   * @param id - Session identifier.
   * @returns The session state, or `undefined` if not found or expired.
   */
  get(id: string): SessionState | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() - session.createdAt > this.maxAgeMs) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /**
   * Check whether a session exists and is not expired.
   *
   * @param id - Session identifier.
   */
  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /**
   * Delete a session by ID.
   *
   * @returns `true` if the session existed and was removed.
   */
  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /**
   * Remove all expired sessions.
   *
   * @returns The number of sessions evicted.
   */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > this.maxAgeMs) {
        this.sessions.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  /** Number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }
}
