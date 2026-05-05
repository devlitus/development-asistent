/**
 * Core Orchestrator class — the heart of the agent routing system.
 *
 * Responsibilities:
 * 1. Classify user intent via IntentClassifier
 * 2. Route to the appropriate registered sub-agent
 * 3. Build ExtendedAgentContext with session history and LLM provider
 * 4. Execute the agent and emit unified AgentEvent stream
 * 5. Manage per-session ContextWindow instances (T27)
 *
 * Does NOT know about ACP — only translates AgentResult → AgentEvent.
 */

import type { Agent, AgentType } from "../types/agent.ts";
import type { LLMProvider, ChatMessage } from "../types/llm.ts";
import type { SessionId } from "../types/persistence.ts";
import type {
  AgentEvent,
  ExtendedAgentContext,
  IntentClassifier,
  SessionHistoryProvider,
  ToolCallStatus,
} from "./types.ts";
import { ContextWindow, type ContextWindowOptions, type ContextWindowRepo } from "../context/context-window.ts";

// ─── Constructor Dependencies ─────────────────────────────────────

/**
 * Dependencies injected into the Orchestrator constructor.
 *
 * Separates behavioral deps (classifier, history, LLM) from
 * the runtime config defined in OrchestratorConfig (types.ts).
 */
export interface OrchestratorDeps {
  /** Intent classifier for routing prompts to agents. */
  readonly intentClassifier: IntentClassifier;

  /** Provider for retrieving session history. */
  readonly historyProvider: SessionHistoryProvider;

  /** LLM provider injected into agent contexts. */
  readonly llmProvider: LLMProvider;

  /**
   * Repository for persisting summaries and loading history.
   * Optional — if not provided, ContextWindow will not persist summaries.
   * Accepts the full SQLiteRepository or any ContextWindowRepo-compatible object.
   */
  readonly repository?: ContextWindowRepo;

  /**
   * Options for ContextWindow instances created per session.
   * Optional — uses ContextWindow defaults if not provided.
   */
  readonly contextWindowOptions?: ContextWindowOptions;

  /**
   * TTL in milliseconds for inactive sessions.
   * Sessions inactive longer than this will be evicted from the ContextWindow map.
   * Default: 3_600_000 (1 hour).
   */
  readonly sessionTtlMs?: number;

  /**
   * Interval in milliseconds at which the automatic eviction timer fires.
   * Default: 60_000 (1 minute).
   */
  readonly evictionIntervalMs?: number;
}

// ─── Internal session entry ────────────────────────────────────────

interface SessionEntry {
  readonly contextWindow: ContextWindow;
  lastAccessedAt: number;
}

// ─── Marker constants ──────────────────────────────────────────────

export const STATUS_MARKER = "\x00STATUS\x00" as const;
export const ERR_MARKER    = "\x00ERR\x00" as const;

// ─── Orchestrator ──────────────────────────────────────────────────

export class Orchestrator {
  private readonly agents = new Map<AgentType, Agent>();
  private readonly classifier: IntentClassifier;
  private readonly historyProvider: SessionHistoryProvider;
  private readonly llmProvider: LLMProvider;
  private readonly repository: ContextWindowRepo | undefined;
  private readonly contextWindowOptions: ContextWindowOptions | undefined;
  private readonly sessionTtlMs: number;

  /** Per-session ContextWindow instances with TTL tracking. */
  private readonly sessionMap = new Map<SessionId, SessionEntry>();

  /** Automatic eviction timer — fires every evictionIntervalMs. */
  private readonly evictionTimer: ReturnType<typeof setInterval>;

  constructor(deps: OrchestratorDeps) {
    this.classifier = deps.intentClassifier;
    this.historyProvider = deps.historyProvider;
    this.llmProvider = deps.llmProvider;
    this.repository = deps.repository;
    this.contextWindowOptions = deps.contextWindowOptions;
    this.sessionTtlMs = deps.sessionTtlMs ?? 3_600_000;

    const evictionIntervalMs = deps.evictionIntervalMs ?? 60_000;
    this.evictionTimer = setInterval(() => this.evictExpiredSessions(), evictionIntervalMs);
    // unref() so the timer does not prevent process exit
    if (typeof this.evictionTimer === "object" && "unref" in this.evictionTimer) {
      (this.evictionTimer as { unref(): void }).unref();
    }
  }

  /**
   * Stops the automatic eviction timer.
   * Call this when the Orchestrator is no longer needed (e.g. in tests or shutdown).
   */
  dispose(): void {
    clearInterval(this.evictionTimer);
  }

  /**
   * Registers a sub-agent by its type.
   *
   * If an agent of the same type is already registered, it is replaced.
   * This is useful for testing and dynamic agent swapping.
   *
   * @param agent - The agent to register.
   */
  registerAgent(agent: Agent): void {
    this.agents.set(agent.type, agent);
  }

  /**
   * Returns the types of all currently registered agents.
   *
   * @returns A readonly array of agent types.
   */
  getRegisteredAgents(): readonly AgentType[] {
    return Object.freeze(Array.from(this.agents.keys()));
  }

  // ─── ContextWindow session management ─────────────────────────────

  /**
   * Initialises a new ContextWindow for the given session.
   * Call this when a session is created (session/new).
   *
   * @param sessionId - The session to initialise.
   */
  initSession(sessionId: SessionId): void {
    const cw = this.createContextWindow(sessionId);
    this.sessionMap.set(sessionId, {
      contextWindow: cw,
      lastAccessedAt: Date.now(),
    });
  }

  /**
   * Reconstructs a ContextWindow for an existing session from SQLite history.
   * Call this when resuming a session (session/resume).
   *
   * @param sessionId - The session to resume.
   */
  async resumeSession(sessionId: SessionId): Promise<void> {
    const cw = this.createContextWindow(sessionId);

    // Load historical messages from the history provider
    const history = await this.historyProvider.getHistory(sessionId);
    if (history.length > 0) {
      cw.addMessages([...history]);
    }

    this.sessionMap.set(sessionId, {
      contextWindow: cw,
      lastAccessedAt: Date.now(),
    });
  }

  /**
   * Releases the ContextWindow for the given session.
   * Call this when a session ends (session/end or timeout).
   *
   * @param sessionId - The session to end.
   */
  endSession(sessionId: SessionId): void {
    this.sessionMap.delete(sessionId);
  }

  /**
   * Returns the ContextWindow for the given session, or undefined if not found.
   *
   * @param sessionId - The session to look up.
   */
  getContextWindow(sessionId: SessionId): ContextWindow | undefined {
    const entry = this.sessionMap.get(sessionId);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      return entry.contextWindow;
    }
    return undefined;
  }

  /**
   * Returns true if a ContextWindow exists for the given session.
   *
   * @param sessionId - The session to check.
   */
  hasContextWindow(sessionId: SessionId): boolean {
    return this.sessionMap.has(sessionId);
  }

  /**
   * Evicts sessions that have been inactive longer than sessionTtlMs.
   * Should be called periodically (e.g., on a timer) to prevent memory leaks.
   */
  evictExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessionMap) {
      if (now - entry.lastAccessedAt > this.sessionTtlMs) {
        this.sessionMap.delete(sessionId);
      }
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────

  private createContextWindow(sessionId: SessionId): ContextWindow {
    // ContextWindow requires a SQLiteRepository. If none is provided,
    // create a no-op stub that satisfies the interface.
    const repo = this.repository ?? createNoOpRepository();
    return new ContextWindow(sessionId, repo, this.llmProvider, this.contextWindowOptions);
  }

  /**
   * Gets or lazily creates a ContextWindow for the given session.
   * Used internally during dispatch to handle sessions that were not
   * explicitly initialised (backward-compatible behaviour).
   */
  private getOrCreateContextWindow(sessionId: SessionId): ContextWindow {
    const existing = this.sessionMap.get(sessionId);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing.contextWindow;
    }
    // Lazy init for sessions that weren't explicitly initialised
    const cw = this.createContextWindow(sessionId);
    this.sessionMap.set(sessionId, {
      contextWindow: cw,
      lastAccessedAt: Date.now(),
    });
    return cw;
  }

  /**
   * Main dispatch flow: classify intent → find agent → execute → emit events.
   *
   * Emits an AsyncIterable of AgentEvent that callers can consume
   * to track progress, handle errors, and get results.
   *
   * Error handling strategy:
   * - No agents registered → error + done(false)
   * - Classification fails → fallback to first registered agent
   * - Agent not found for classified type → error + done(false)
   * - Agent.execute throws → error + done(false)
   * - Agent returns failure → error + done(false)
   *
   * @param sessionId - The current session identifier.
   * @param prompt - The user's prompt to classify and dispatch.
   * @param workingDir - Optional working directory. Defaults to process.cwd().
   * @yields AgentEvent — status updates, results, and completion.
   */
  async *dispatch(
    sessionId: SessionId,
    prompt: string,
    workingDir?: string,
  ): AsyncGenerator<AgentEvent> {
    // ─── Step 0: Check if any agents are registered ───────────
    if (this.agents.size === 0) {
      yield {
        type: "error",
        error: "no_agents",
        message: "No agents registered. Register at least one agent before dispatching.",
      };
      yield { type: "done", success: false };
      return;
    }

    // ─── Step 1: Emit initial status ──────────────────────────
    yield { type: "text", content: `${STATUS_MARKER}Analizando tu solicitud...` };

    // ─── Step 2: Get active messages from ContextWindow ───────
    // If no ContextWindow exists for this session, lazily create one and
    // seed it with the history from the historyProvider (backward-compatible).
    let contextWindow: ContextWindow;
    if (!this.sessionMap.has(sessionId)) {
      // Lazy init: load history first, then seed the ContextWindow
      let seedHistory: readonly ChatMessage[];
      try {
        seedHistory = await this.historyProvider.getHistory(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield {
          type: "error",
          error: "history_error",
          message: `Failed to retrieve session history: ${msg}`,
        };
        yield { type: "done", success: false };
        return;
      }
      const cw = this.createContextWindow(sessionId);
      if (seedHistory.length > 0) {
        cw.addMessages([...seedHistory]);
      }
      this.sessionMap.set(sessionId, {
        contextWindow: cw,
        lastAccessedAt: Date.now(),
      });
      contextWindow = cw;
    } else {
      contextWindow = this.getOrCreateContextWindow(sessionId);
    }

    // Add the new user message to the context window
    contextWindow.addMessages([{ role: "user", content: prompt }]);

    let history: readonly ChatMessage[];
    try {
      // Use ContextWindow's sliding window instead of raw history provider
      history = await contextWindow.getMessagesForPrompt();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        error: "history_error",
        message: `Failed to retrieve session history: ${msg}`,
      };
      yield { type: "done", success: false };
      return;
    }

    // ─── Step 3: Classify intent ──────────────────────────────
    let agentType: AgentType;
    try {
      const classification = await this.classifier.classify(prompt, history);
      agentType = classification.agentType;
    } catch {
      // Classification failed → fallback to first registered agent
      const firstAgent = this.agents.values().next().value;
      if (!firstAgent) {
        // Shouldn't happen since we checked size > 0 above
        yield {
          type: "error",
          error: "no_agents",
          message: "No agents available for fallback.",
        };
        yield { type: "done", success: false };
        return;
      }
      agentType = firstAgent.type;
    }

    // ─── Step 4: Find the agent ───────────────────────────────
    const agent = this.agents.get(agentType);
    if (!agent) {
      yield {
        type: "error",
        error: "no_agent",
        message: `No agent registered for type "${agentType}".`,
      };
      yield { type: "done", success: false };
      return;
    }

    // ─── Step 4b: Emit routing marker ──────────────────────────
    yield {
      type: "text",
      content: `\x00ROUTING\x00${agent.name}`,
    };

    // ─── Step 5: Emit delegating status ───────────────────────
    yield {
      type: "text",
      content: `${STATUS_MARKER}Delegando al agente de ${agent.name}...`,
    };

    // ─── Step 6: Build extended context ───────────────────────
    const context: ExtendedAgentContext = {
      sessionId,
      prompt,
      workingDir: workingDir ?? process.cwd(),
      workspacePath: workingDir ?? process.cwd(),
      llmProvider: this.llmProvider,
      sessionHistory: history,
      availableTools: [],
    };

    // ─── Step 7: Execute agent ────────────────────────────────
    try {
      const result = await agent.execute(context);

      // Emit tool_call events if present
      if (result.toolCalls) {
        for (const tc of result.toolCalls) {
          yield {
            type: "tool_call",
            id: tc.id,
            name: tc.id, // ToolResult doesn't have a name field; use id
            arguments: tc.content,
            status: tc.status as ToolCallStatus,
          };
        }
      }

      if (result.success) {
        // Add assistant response to context window
        contextWindow.addMessages([{ role: "assistant", content: result.output }]);

        const safeOutput = result.output.replace(/\x00[A-Z_]+\x00/g, "");
        yield { type: "text", content: safeOutput };
        yield { type: "done", success: true };
      } else {
        yield {
          type: "error",
          error: result.error,
          message: result.output,
        };
        yield { type: "done", success: false };
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        error: "agent_error",
        message,
      };
      yield { type: "done", success: false };
    }
  }
}

// ─── No-op repository stub ────────────────────────────────────────

/**
 * Creates a minimal no-op ContextWindowRepo stub for use when no real
 * repository is provided. This allows ContextWindow to function without
 * persisting summaries.
 *
 * Implements only the two methods required by ContextWindow — no unsafe cast needed.
 */
function createNoOpRepository(): ContextWindowRepo {
  return {
    addSummary: () => {
      throw new Error(
        "[Orchestrator] Cannot persist summary: no repository provided. " +
        "Pass a repository in OrchestratorDeps to enable summary persistence.",
      );
    },
    getSummariesBySession: () => [],
  };
}
