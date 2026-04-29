/**
 * ContextWindow — manages the sliding window of messages for a session.
 *
 * Keeps the last N messages intact and, when the estimated token count
 * exceeds the configured threshold, summarizes older messages via LLM
 * and persists the summary in SQLite.
 */

import type { ChatMessage, LLMProvider } from "../types/llm.ts";
import type { MessageId, SessionId } from "../types/persistence.ts";
import type { SQLiteRepository } from "../persistence/repository.ts";
import { asMessageId } from "../types/persistence.ts";

/**
 * Minimal repository interface required by ContextWindow.
 * Using this instead of the full SQLiteRepository allows injecting
 * lightweight stubs (e.g. no-op or in-memory) without unsafe casts.
 */
export interface ContextWindowRepo {
  addSummary: SQLiteRepository["addSummary"];
  getSummariesBySession: SQLiteRepository["getSummariesBySession"];
}
import { estimateChatTokens, estimateMessageTokens } from "./token-counter.ts";
import { Summarizer } from "./summarizer.ts";

export interface ContextWindowOptions {
  /** Maximum number of recent messages to keep verbatim. Default: 10 */
  maxRecentMessages?: number;
  /** Fraction of modelContextSize at which summarization is triggered. Default: 0.7 */
  tokenThresholdPercent?: number;
  /** Total context size of the active model in tokens. Default: 128_000 */
  modelContextSize?: number;
}

/** Internal representation that pairs a ChatMessage with a local ID. */
interface StoredMessage {
  readonly message: ChatMessage;
  readonly id: MessageId;
}

const MAX_SUMMARIZE_ITERATIONS = 3;

/** Maximum allowed content length per message (~25k tokens). */
export const MAX_CONTENT_LENGTH = 100_000;

/**
 * PERF-05: Maximum number of messages retained in the in-memory ring-buffer.
 * When this limit is exceeded, the oldest message is evicted (FIFO) to prevent
 * unbounded RAM growth in long-running sessions.
 */
export const MAX_STORED_MESSAGES = 1000;

/**
 * PERF-06: Maximum number of entries in the summaryCache Map.
 * When the limit is reached, the oldest entry (first inserted, per JS Map
 * insertion-order guarantee in ES2015+) is evicted before inserting the new one.
 */
export const MAX_SUMMARY_CACHE_ENTRIES = 100;

export class ContextWindow {
  private readonly sessionId: SessionId;
  private readonly repo: ContextWindowRepo;
  private readonly summarizer: Summarizer;

  private readonly maxRecentMessages: number;
  private readonly tokenThresholdPercent: number;
  private readonly modelContextSize: number;

  /** Full in-memory history — never deleted (audit trail). */
  private stored: StoredMessage[] = [];

  /** Tracks already-summarized ranges to avoid duplicate summaries. */
  private readonly summarizedRanges = new Set<string>();

  /** Cache of summary content by rangeKey. */
  private readonly summaryCache = new Map<string, string>();

  /** Cached prompt result — invalidated when stored grows. */
  private cachedPrompt: ChatMessage[] | null = null;

  constructor(
    sessionId: SessionId,
    repository: ContextWindowRepo,
    llmProvider: LLMProvider,
    options?: ContextWindowOptions,
  ) {
    this.sessionId = sessionId;
    this.repo = repository;
    this.summarizer = new Summarizer(llmProvider);

    this.maxRecentMessages = options?.maxRecentMessages ?? 10;

    const pct = options?.tokenThresholdPercent ?? 0.7;
    if (pct <= 0 || pct > 1) {
      throw new Error(
        `tokenThresholdPercent must be in range (0, 1], got ${pct}`,
      );
    }
    this.tokenThresholdPercent = pct;

    this.modelContextSize = options?.modelContextSize ?? 128_000;
  }

  /** Add messages to the in-memory history. Truncates oversized content.
   * PERF-05: Enforces a ring-buffer of MAX_STORED_MESSAGES — oldest messages
   * are evicted (FIFO) when the limit is exceeded to prevent unbounded RAM growth.
   */
  addMessages(messages: ChatMessage[]): void {
    for (const msg of messages) {
      const safeContent =
        msg.content.length > MAX_CONTENT_LENGTH
          ? msg.content.slice(0, MAX_CONTENT_LENGTH)
          : msg.content;
      this.stored.push({
        message: { ...msg, content: safeContent },
        id: asMessageId(crypto.randomUUID()),
      });
      // PERF-05: Ring-buffer — evict oldest when limit exceeded
      if (this.stored.length > MAX_STORED_MESSAGES) {
        this.stored.shift();
      }
    }
    // Invalidate cached prompt when new messages arrive
    this.cachedPrompt = null;
  }

  /** Estimated token count of the full in-memory history. */
  estimatedTokens(): number {
    return estimateChatTokens(this.stored.map((s) => s.message));
  }

  /**
   * Returns the messages to send to the LLM, applying sliding window
   * and summarization if the token threshold is exceeded.
   *
   * This method is idempotent with respect to the internal history —
   * it never removes stored messages.
   */
  async getMessagesForPrompt(): Promise<ChatMessage[]> {
    // Fast path: few messages, no need to summarize
    if (this.stored.length <= this.maxRecentMessages) {
      return this.stored.map((s) => s.message);
    }

    const threshold = Math.floor(this.modelContextSize * this.tokenThresholdPercent);
    const allMessages = this.stored.map((s) => s.message);

    // Fast path: tokens below threshold
    if (estimateChatTokens(allMessages) <= threshold) {
      return allMessages;
    }

    // Return cached result if stored hasn't changed
    if (this.cachedPrompt !== null) {
      return this.cachedPrompt;
    }

    // Summarize iteratively (max MAX_SUMMARIZE_ITERATIONS rounds)
    const result = await this.buildSummarizedPrompt(threshold);
    this.cachedPrompt = result;
    return result;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async buildSummarizedPrompt(threshold: number): Promise<ChatMessage[]> {
    // Work on a mutable working set (does NOT mutate this.stored)
    let workingSet: StoredMessage[] = [...this.stored];

    for (let iteration = 0; iteration < MAX_SUMMARIZE_ITERATIONS; iteration++) {
      if (workingSet.length <= this.maxRecentMessages) break;

      const splitIndex = workingSet.length - this.maxRecentMessages;
      const ancient = workingSet.slice(0, splitIndex);
      const recent = workingSet.slice(splitIndex);

      const currentTokens = estimateChatTokens(workingSet.map((s) => s.message));
      if (currentTokens <= threshold) break;

      const rangeKey = `${ancient[0].id}-${ancient[ancient.length - 1].id}`;

      let summaryContent: string;

      if (!this.summarizedRanges.has(rangeKey)) {
        // Generate summary
        summaryContent = await this.summarizer.summarize(
          ancient.map((s) => s.message),
        );

        // Persist summary in SQLite
        this.repo.addSummary(
          this.sessionId,
          summaryContent,
          ancient[0].id,
          ancient[ancient.length - 1].id,
        );

        this.summarizedRanges.add(rangeKey);
        // PERF-06: LRU cap — evict oldest entry if at limit before inserting.
        // Non-null assertion is safe here: we just verified size >= MAX_SUMMARY_CACHE_ENTRIES,
        // so the Map is non-empty and keys().next().value is guaranteed to be defined.
        if (this.summaryCache.size >= MAX_SUMMARY_CACHE_ENTRIES) {
          const oldestKey = this.summaryCache.keys().next().value!;
          this.summaryCache.delete(oldestKey);
        }
        this.summaryCache.set(rangeKey, summaryContent);
      } else {
        // Use cached summary content
        const cached = this.summaryCache.get(rangeKey);
        if (cached === undefined) {
          throw new Error(
            `[ContextWindow] invariant violated: rangeKey "${rangeKey}" in summaryKeys but not in summaryCache`,
          );
        }
        summaryContent = cached;
      }

      // Build summary message
      const summaryMessage: ChatMessage = {
        role: "user",
        content: `[Resumen de conversación anterior]\n${summaryContent}`,
      };

      const summaryStored: StoredMessage = {
        message: summaryMessage,
        id: asMessageId(crypto.randomUUID()),
      };

      // Replace ancient with the summary in the working set
      workingSet = [summaryStored, ...recent];
    }

    return workingSet.map((s) => s.message);
  }
}
