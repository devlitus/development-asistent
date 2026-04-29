/**
 * Tests for intent classifier implementations:
 * - LLMIntentClassifier
 * - KeywordIntentClassifier
 * - CompositeIntentClassifier
 *
 * TDD: Tests written FIRST, implementations after.
 */

import { describe, it, expect, mock } from "bun:test";
import type {
  IntentClassifier,
  IntentClassificationResult,
  LLMProvider,
  ChatMessage,
} from "../../src/orchestrator/index.ts";
import {
  LLMIntentClassifier,
  KeywordIntentClassifier,
  CompositeIntentClassifier,
} from "../../src/orchestrator/intent-classifier.ts";

// ─── Helpers ──────────────────────────────────────────────────────

/** Creates a mock LLMProvider with a configurable response. */
function createMockLLMProvider(
  response: string,
  shouldThrow = false,
): LLMProvider {
  return {
    name: "mock-llm",
    chat: mock(async (_messages: readonly ChatMessage[]) => {
      if (shouldThrow) {
        throw new Error("LLM provider error");
      }
      return { content: response };
    }),
    async *_stream(_messages: readonly ChatMessage[]) {
      yield { delta: "mock" };
    },
    stream(_messages: readonly ChatMessage[]) {
      return this._stream(_messages);
    },
  };
}

/** Empty history constant for tests. */
const EMPTY_HISTORY: readonly ChatMessage[] = [];

// ═══════════════════════════════════════════════════════════════════
// LLMIntentClassifier
// ═══════════════════════════════════════════════════════════════════

describe("LLMIntentClassifier", () => {
  it('should classify "read file src/index.ts" as "code"', async () => {
    const provider = createMockLLMProvider("code");
    const classifier = new LLMIntentClassifier(provider);

    const result = await classifier.classify(
      "read file src/index.ts",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("code");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reasoning).toBeTruthy();
  });

  it('should classify "run bun test" as "os"', async () => {
    const provider = createMockLLMProvider("os");
    const classifier = new LLMIntentClassifier(provider);

    const result = await classifier.classify("run bun test", EMPTY_HISTORY);

    expect(result.agentType).toBe("os");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toBeTruthy();
  });

  it('should classify "search docs for react hooks" as "docs"', async () => {
    const provider = createMockLLMProvider("docs");
    const classifier = new LLMIntentClassifier(provider);

    const result = await classifier.classify(
      "search docs for react hooks",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("docs");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toBeTruthy();
  });

  it('should classify "git commit my changes" as "git"', async () => {
    const provider = createMockLLMProvider("git");
    const classifier = new LLMIntentClassifier(provider);

    const result = await classifier.classify(
      "git commit my changes",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("git");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toBeTruthy();
  });

  it('should default to "code" when LLM response is ambiguous', async () => {
    const provider = createMockLLMProvider("I think maybe the code agent?");
    const classifier = new LLMIntentClassifier(provider);

    const result = await classifier.classify(
      "do something weird",
      EMPTY_HISTORY,
    );

    // Ambiguous response should fall back to "code"
    expect(result.agentType).toBe("code");
    expect(result.confidence).toBeLessThan(1);
  });

  it("should fallback gracefully when LLM throws error", async () => {
    const provider = createMockLLMProvider("", true);
    const classifier = new LLMIntentClassifier(provider);

    // LLM throws → classifier should throw, not silently swallow
    // The composite will handle the fallback
    await expect(
      classifier.classify("do something", EMPTY_HISTORY),
    ).rejects.toThrow("LLM provider error");
  });

  it("should handle LLM response with extra whitespace", async () => {
    const provider = createMockLLMProvider("  \n  git  \n  ");
    const classifier = new LLMIntentClassifier(provider);

    const result = await classifier.classify("push to main", EMPTY_HISTORY);

    expect(result.agentType).toBe("git");
  });

  it("should handle LLM response with uppercase", async () => {
    const provider = createMockLLMProvider("CODE");
    const classifier = new LLMIntentClassifier(provider);

    const result = await classifier.classify("read the file", EMPTY_HISTORY);

    expect(result.agentType).toBe("code");
  });

  it("should construct the routing prompt correctly", async () => {
    const provider = createMockLLMProvider("code");
    const classifier = new LLMIntentClassifier(provider);

    await classifier.classify("my custom prompt", EMPTY_HISTORY);

    // Verify the provider was called with proper routing messages
    expect(provider.chat).toHaveBeenCalledTimes(1);
    const calls = provider.chat.mock.calls;
    expect(calls.length).toBe(1);

    const messages = calls[0]![0] as readonly ChatMessage[];
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // First message should be the system routing prompt
    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("routing assistant");
    expect(systemMsg!.content).toContain("Available agents");

    // Should contain the user prompt
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toContain("my custom prompt");
  });

  it("should include conversation history in the LLM call", async () => {
    const provider = createMockLLMProvider("code");
    const classifier = new LLMIntentClassifier(provider);

    const history: readonly ChatMessage[] = [
      { role: "user", content: "previous message" },
      { role: "assistant", content: "previous response" },
    ];

    await classifier.classify("follow up question", history);

    const calls = provider.chat.mock.calls;
    const messages = calls[0]![0] as readonly ChatMessage[];

    // History messages should be included
    const historyUserMsg = messages.find(
      (m) => m.role === "user" && m.content === "previous message",
    );
    expect(historyUserMsg).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// KeywordIntentClassifier
// ═══════════════════════════════════════════════════════════════════

describe("KeywordIntentClassifier", () => {
  it('should match "read file" keywords to "code"', async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify("read the file", EMPTY_HISTORY);

    expect(result.agentType).toBe("code");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should match "run command" keywords to "os"', async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify(
      "run the command",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("os");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should match "search docs" keywords to "docs"', async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify(
      "search docs for react",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("docs");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should match "git commit" keywords to "git"', async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify(
      "git commit my changes",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("git");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('should return "code" as default for ambiguous prompts', async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify(
      "hello how are you doing today",
      EMPTY_HISTORY,
    );

    // No keywords match → default to "code"
    expect(result.agentType).toBe("code");
    expect(result.confidence).toBe(1.0);
    expect(result.reasoning).toContain("default");
  });

  it("should return agent with most keyword matches", async () => {
    const classifier = new KeywordIntentClassifier();

    // "git diff" has git keywords; "git" matches git, "diff" matches both git and code
    // git should win because "git" is a direct match for git agent
    const result = await classifier.classify("git diff", EMPTY_HISTORY);
    expect(result.agentType).toBe("git");
  });

  it("should be case-insensitive for keyword matching", async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify(
      "GIT COMMIT",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("git");
  });

  it("should return confidence of 1.0 for exact keyword matches", async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify(
      "git push origin main",
      EMPTY_HISTORY,
    );

    expect(result.confidence).toBe(1.0);
    expect(result.agentType).toBe("git");
  });

  it("should handle multi-word keywords like 'search web'", async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify(
      "search web for react docs",
      EMPTY_HISTORY,
    );

    // "search web" is a docs keyword, "docs" is also a docs keyword
    expect(result.agentType).toBe("docs");
  });

  it("should handle empty prompt gracefully", async () => {
    const classifier = new KeywordIntentClassifier();
    const result = await classifier.classify("", EMPTY_HISTORY);

    expect(result.agentType).toBe("code");
    expect(result.confidence).toBe(1.0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CompositeIntentClassifier
// ═══════════════════════════════════════════════════════════════════

describe("CompositeIntentClassifier", () => {
  it("should prefer LLM classification when available", async () => {
    const llmProvider = createMockLLMProvider("docs");
    const classifier = new CompositeIntentClassifier(
      new LLMIntentClassifier(llmProvider),
      new KeywordIntentClassifier(),
    );

    // "read file" would match code keywords, but LLM says "docs"
    const result = await classifier.classify(
      "read file about react hooks",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("docs");
    expect(result.reasoning).toContain("LLM");
  });

  it("should fall back to keywords when LLM fails", async () => {
    const llmProvider = createMockLLMProvider("", true); // throws
    const classifier = new CompositeIntentClassifier(
      new LLMIntentClassifier(llmProvider),
      new KeywordIntentClassifier(),
    );

    // LLM throws, should fall back to keyword classifier
    const result = await classifier.classify(
      "git commit my changes",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("git");
    expect(result.reasoning).toContain("keyword");
  });

  it('should default to "code" when both fail to find specific match', async () => {
    const llmProvider = createMockLLMProvider("", true); // throws
    const classifier = new CompositeIntentClassifier(
      new LLMIntentClassifier(llmProvider),
      new KeywordIntentClassifier(),
    );

    // No keywords match, LLM throws → defaults to "code"
    const result = await classifier.classify(
      "hello how are you",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("code");
  });

  it("should fall back to keywords when LLM returns invalid response", async () => {
    const llmProvider = createMockLLMProvider("invalid_agent_type");
    const classifier = new CompositeIntentClassifier(
      new LLMIntentClassifier(llmProvider),
      new KeywordIntentClassifier(),
    );

    // LLM returns invalid type → keyword fallback
    const result = await classifier.classify(
      "git push origin main",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("git");
    expect(result.reasoning).toContain("keyword");
  });

  it("should use LLM confidence when LLM succeeds", async () => {
    const llmProvider = createMockLLMProvider("os");
    const classifier = new CompositeIntentClassifier(
      new LLMIntentClassifier(llmProvider),
      new KeywordIntentClassifier(),
    );

    const result = await classifier.classify(
      "execute the tests",
      EMPTY_HISTORY,
    );

    expect(result.agentType).toBe("os");
    // LLM confidence should be present (it's a valid result)
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("should implement the IntentClassifier interface", () => {
    const llmProvider = createMockLLMProvider("code");
    const classifier: IntentClassifier = new CompositeIntentClassifier(
      new LLMIntentClassifier(llmProvider),
      new KeywordIntentClassifier(),
    );

    // TypeScript structural typing: classifier must satisfy IntentClassifier
    expect(typeof classifier.classify).toBe("function");
  });
});
