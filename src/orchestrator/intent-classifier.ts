/**
 * Intent classifier implementations for routing user prompts
 * to the appropriate sub-agent.
 *
 * Three strategies:
 * 1. LLMIntentClassifier — uses an LLM provider with a routing prompt
 * 2. KeywordIntentClassifier — keyword/heuristic fallback
 * 3. CompositeIntentClassifier — LLM first, keyword fallback on failure
 */

import type { AgentType, ChatMessage, LLMProvider } from "../types/index.ts";
import { AGENT_TYPES } from "../types/agent.ts";
import type {
  IntentClassifier,
  IntentClassificationResult,
} from "./types.ts";

// ─── Constants ────────────────────────────────────────────────────

/** Valid agent type values for runtime validation. */
const VALID_AGENT_TYPES = new Set<string>(Object.values(AGENT_TYPES));

/** Default agent type when no match is found. */
const DEFAULT_AGENT_TYPE: AgentType = AGENT_TYPES.CODE;

/** Keyword map for heuristic classification fallback. */
const KEYWORD_MAP: Readonly<Record<AgentType, readonly string[]>> = {
  [AGENT_TYPES.CODE]: [
    "file",
    "read",
    "write",
    "edit",
    "code",
    "function",
    "class",
    "refactor",
    "implement",
    "bug",
    "fix",
    "create",
    "delete",
    "search file",
    "find",
    "grep",
    "ast",
    "import",
    "export",
  ],
  [AGENT_TYPES.OS]: [
    "run",
    "execute",
    "command",
    "shell",
    "bash",
    "test",
    "script",
    "install",
    "build",
    "npm",
    "bun",
    "start",
    "process",
  ],
  [AGENT_TYPES.DOCS]: [
    "docs",
    "documentation",
    "api",
    "reference",
    "search",
    "search web",
    "look up",
    "how to",
    "tutorial",
    "fetch",
    "url",
    "documentation for",
  ],
  [AGENT_TYPES.GIT]: [
    "git",
    "commit",
    "branch",
    "push",
    "pull",
    "merge",
    "rebase",
    "diff",
    "status",
    "log",
    "pr",
    "pull request",
    "checkout",
  ],
};

/** System prompt for LLM-based routing. */
const ROUTING_SYSTEM_PROMPT = `You are a routing assistant. Given the user's message, determine which specialized agent should handle it.

Available agents:
- code: For file operations (read, write, search, edit), code generation, refactoring, AST analysis
- os: For shell commands, running tests, executing scripts, system operations
- docs: For searching documentation, fetching web content, API references
- git: For git operations (status, diff, commit, branch, push), pull requests, code review

Respond with ONLY the agent name (code, os, docs, git). If uncertain, respond with "code".`;

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Validates and normalizes an LLM response into a valid AgentType.
 *
 * @returns A valid AgentType, or `null` if the response is not valid.
 */
function parseAgentType(raw: string): AgentType | null {
  const normalized = raw.trim().toLowerCase();

  // Try exact match first
  if (VALID_AGENT_TYPES.has(normalized)) {
    return normalized as AgentType;
  }

  // Try to extract agent type from the response text
  // e.g. "I think the code agent" → "code"
  for (const agentType of VALID_AGENT_TYPES) {
    if (normalized.includes(agentType)) {
      return agentType as AgentType;
    }
  }

  return null;
}

/** Score for keyword matching: count + longest match length for tie-breaking. */
interface KeywordScore {
  readonly agentType: AgentType;
  readonly count: number;
  readonly longestMatch: number;
}

/**
 * Computes keyword scores for each agent type against a normalized prompt.
 *
 * Scores include both the number of keyword matches and the length of the
 * longest matched keyword. This allows tie-breaking by specificity:
 * longer keywords indicate more precise intent.
 */
function computeKeywordScores(
  normalizedPrompt: string,
): KeywordScore[] {
  const scores: KeywordScore[] = [];

  for (const [agentType, keywords] of Object.entries(KEYWORD_MAP) as [
    AgentType,
    readonly string[],
  ][]) {
    let count = 0;
    let longestMatch = 0;

    for (const keyword of keywords) {
      if (normalizedPrompt.includes(keyword)) {
        count++;
        if (keyword.length > longestMatch) {
          longestMatch = keyword.length;
        }
      }
    }

    if (count > 0) {
      scores.push({ agentType, count, longestMatch });
    }
  }

  return scores;
}

/**
 * Finds the best agent type from keyword scores.
 *
 * Tie-breaking strategy:
 * 1. Higher match count wins
 * 2. If tied, longer keyword match wins (more specific intent)
 *
 * Returns `null` if no keywords matched.
 */
function findBestKeywordMatch(
  scores: KeywordScore[],
): AgentType | null {
  if (scores.length === 0) {
    return null;
  }

  // Sort by count desc, then by longestMatch desc
  const sorted = [...scores].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.longestMatch - a.longestMatch;
  });

  return sorted[0]!.agentType;
}

// ═══════════════════════════════════════════════════════════════════
// LLMIntentClassifier
// ═══════════════════════════════════════════════════════════════════

/**
 * Classifies user intent using an LLM provider with a routing prompt.
 *
 * Sends the user prompt and conversation history to the LLM with
 * a system prompt that instructs it to respond with a single agent
 * type name. The response is validated and normalized.
 */
export class LLMIntentClassifier implements IntentClassifier {
  constructor(private readonly provider: LLMProvider) {}

  async classify(
    prompt: string,
    history: readonly ChatMessage[],
  ): Promise<IntentClassificationResult> {
    // Build messages for the routing prompt
    const messages: ChatMessage[] = [
      { role: "system", content: ROUTING_SYSTEM_PROMPT },
      // Include conversation history for context
      ...history.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      { role: "user", content: prompt },
    ];

    const response = await this.provider.chat(messages, {
      // Disable extended thinking for routing calls: we only need a single word
      // (code/os/docs/git) so thinking tokens add latency without benefit.
      disableThinking: true,
    });

    const parsed = parseAgentType(response.content);

    if (parsed !== null) {
      return {
        agentType: parsed,
        confidence: 0.85,
        reasoning: `LLM classified as "${parsed}" based on routing prompt`,
      };
    }

    // LLM returned something unparseable — return default with low confidence
    return {
      agentType: DEFAULT_AGENT_TYPE,
      confidence: 0.3,
      reasoning: `LLM response "${response.content.trim()}" could not be parsed, defaulting to "${DEFAULT_AGENT_TYPE}"`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// KeywordIntentClassifier
// ═══════════════════════════════════════════════════════════════════

/**
 * Classifies user intent using keyword matching as a heuristic fallback.
 *
 * Normalizes the prompt to lowercase and counts keyword matches for each
 * agent type. The agent with the most matches wins. If no keywords match,
 * defaults to the "code" agent (most versatile).
 *
 * Always returns a confidence of 1.0 for keyword matches (deterministic).
 */
export class KeywordIntentClassifier implements IntentClassifier {
  async classify(
    prompt: string,
    _history: readonly ChatMessage[],
  ): Promise<IntentClassificationResult> {
    const normalizedPrompt = prompt.toLowerCase();

    // Edge case: empty prompt
    if (!normalizedPrompt.trim()) {
      return {
        agentType: DEFAULT_AGENT_TYPE,
        confidence: 1.0,
        reasoning: `Empty prompt, defaulting to "${DEFAULT_AGENT_TYPE}"`,
      };
    }

    const scores = computeKeywordScores(normalizedPrompt);
    const bestMatch = findBestKeywordMatch(scores);

    if (bestMatch !== null) {
      const bestScore = scores.find((s) => s.agentType === bestMatch)!;
      return {
        agentType: bestMatch,
        confidence: 1.0,
        reasoning: `Keyword match: "${bestMatch}" agent (${bestScore.count} keyword${bestScore.count > 1 ? "s" : ""} matched)`,
      };
    }

    // No keywords matched — default to code
    return {
      agentType: DEFAULT_AGENT_TYPE,
      confidence: 1.0,
      reasoning: `No keyword matches found, defaulting to "${DEFAULT_AGENT_TYPE}"`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// CompositeIntentClassifier
// ═══════════════════════════════════════════════════════════════════

/**
 * Composite classifier that chains LLM and keyword strategies.
 *
 * Flow:
 * 1. Try LLMIntentClassifier
 * 2. If LLM succeeds with a valid agent type → use it
 * 3. If LLM fails or returns invalid → fall back to KeywordIntentClassifier
 * 4. If keywords don't match → default to "code"
 */
export class CompositeIntentClassifier implements IntentClassifier {
  constructor(
    private readonly llmClassifier: LLMIntentClassifier,
    private readonly keywordClassifier: KeywordIntentClassifier,
  ) {}

  async classify(
    prompt: string,
    history: readonly ChatMessage[],
  ): Promise<IntentClassificationResult> {
    try {
      const llmResult = await this.llmClassifier.classify(prompt, history);

      // If LLM returned a confident result (parsed a valid agent type), use it
      if (llmResult.confidence > 0.5) {
        return {
          ...llmResult,
          reasoning: `LLM classification: ${llmResult.reasoning}`,
        };
      }

      // LLM returned a low-confidence/unparseable result — fall back to keywords
    } catch {
      // LLM failed entirely — fall through to keywords
    }

    // Keyword fallback path
    const keywordResult = await this.keywordClassifier.classify(
      prompt,
      history,
    );

    return {
      ...keywordResult,
      reasoning: `Keyword fallback: ${keywordResult.reasoning}`,
    };
  }
}
