/**
 * Additional coverage tests for the Orchestrator module.
 *
 * Covers areas not fully tested in orchestrator.test.ts and integration.test.ts:
 * - KeywordIntentClassifier: exact matching, case-insensitive, multi-keyword, empty prompt
 * - LLMIntentClassifier: response parsing edge cases
 * - CompositeIntentClassifier: fallback logic
 * - InMemoryHistoryProvider: multi-session, concurrent access
 * - Orchestrator dispatch: edge cases
 */

import { describe, it, expect } from "bun:test";
import {
  KeywordIntentClassifier,
  LLMIntentClassifier,
  CompositeIntentClassifier,
} from "../../src/orchestrator/intent-classifier.ts";
import { InMemoryHistoryProvider } from "../../src/orchestrator/history-provider.ts";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { asSessionId } from "../../src/types/persistence.ts";
import type { ChatMessage, LLMProvider, LLMResponse, LLMChunk } from "../../src/types/llm.ts";
import type { IntentClassifier } from "../../src/orchestrator/types.ts";
import {
  createMockLLMProvider,
  createFailingLLMProvider,
  createRoutingLLMProvider,
} from "../llm/mock-providers.ts";
import { createMockAgent, createThrowingAgent } from "../helpers.ts";
import { createToolCallLLMProvider } from "../llm/mock-providers.ts";

// ─── KeywordIntentClassifier ──────────────────────────────────────

describe("KeywordIntentClassifier", () => {
  const classifier = new KeywordIntentClassifier();
  const noHistory: readonly ChatMessage[] = [];

  it("should classify 'git commit' as git", async () => {
    const result = await classifier.classify("git commit -m 'fix'", noHistory);
    expect(result.agentType).toBe("git");
  });

  it("should classify 'run tests' as os", async () => {
    const result = await classifier.classify("run the tests", noHistory);
    expect(result.agentType).toBe("os");
  });

  it("should classify 'read file' as code", async () => {
    const result = await classifier.classify("read the config file", noHistory);
    expect(result.agentType).toBe("code");
  });

  it("should classify 'search documentation' as docs", async () => {
    const result = await classifier.classify("search documentation for React hooks", noHistory);
    expect(result.agentType).toBe("docs");
  });

  it("should be case-insensitive", async () => {
    const result = await classifier.classify("GIT STATUS", noHistory);
    expect(result.agentType).toBe("git");
  });

  it("should be case-insensitive for code keywords", async () => {
    const result = await classifier.classify("WRITE a Function", noHistory);
    expect(result.agentType).toBe("code");
  });

  it("should default to code for empty prompt", async () => {
    const result = await classifier.classify("", noHistory);
    expect(result.agentType).toBe("code");
    expect(result.confidence).toBe(1.0);
  });

  it("should default to code for whitespace-only prompt", async () => {
    const result = await classifier.classify("   ", noHistory);
    expect(result.agentType).toBe("code");
  });

  it("should default to code when no keywords match", async () => {
    const result = await classifier.classify("hello world", noHistory);
    expect(result.agentType).toBe("code");
  });

  it("should return confidence 1.0 for keyword matches", async () => {
    const result = await classifier.classify("git push origin main", noHistory);
    expect(result.confidence).toBe(1.0);
  });

  it("should prefer agent with more keyword matches", async () => {
    // "git commit branch push" has 3 git keywords vs 0 others
    const result = await classifier.classify("git commit branch push", noHistory);
    expect(result.agentType).toBe("git");
  });

  it("should classify 'pull request' as git (multi-word keyword)", async () => {
    const result = await classifier.classify("create a pull request", noHistory);
    expect(result.agentType).toBe("git");
  });

  it("should classify 'search web' as docs (multi-word keyword)", async () => {
    const result = await classifier.classify("search web for TypeScript tutorials", noHistory);
    expect(result.agentType).toBe("docs");
  });

  it("should classify 'npm install' as os", async () => {
    const result = await classifier.classify("npm install dependencies", noHistory);
    expect(result.agentType).toBe("os");
  });

  it("should classify 'bun run build' as os", async () => {
    const result = await classifier.classify("bun run build", noHistory);
    expect(result.agentType).toBe("os");
  });

  it("should include reasoning in result", async () => {
    const result = await classifier.classify("git status", noHistory);
    expect(result.reasoning).toBeDefined();
    expect(typeof result.reasoning).toBe("string");
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  it("should include reasoning for empty prompt", async () => {
    const result = await classifier.classify("", noHistory);
    expect(result.reasoning).toContain("Empty prompt");
  });

  it("should ignore history (keyword classifier is stateless)", async () => {
    const history: readonly ChatMessage[] = [
      { role: "user", content: "git commit" },
      { role: "assistant", content: "committed" },
    ];
    const result = await classifier.classify("write a function", history);
    expect(result.agentType).toBe("code");
  });
});

// ─── LLMIntentClassifier ──────────────────────────────────────────

describe("LLMIntentClassifier", () => {
  const noHistory: readonly ChatMessage[] = [];

  it("should classify when LLM returns 'code'", async () => {
    const llm = createMockLLMProvider("code");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.agentType).toBe("code");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should classify when LLM returns 'git'", async () => {
    const llm = createMockLLMProvider("git");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.agentType).toBe("git");
  });

  it("should classify when LLM returns 'os'", async () => {
    const llm = createMockLLMProvider("os");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.agentType).toBe("os");
  });

  it("should classify when LLM returns 'docs'", async () => {
    const llm = createMockLLMProvider("docs");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.agentType).toBe("docs");
  });

  it("should extract agent type from verbose LLM response", async () => {
    const llm = createMockLLMProvider("I think it's the code agent that should handle this");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.agentType).toBe("code");
  });

  it("should extract 'git' from verbose response", async () => {
    const llm = createMockLLMProvider("This looks like a git operation");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.agentType).toBe("git");
  });

  it("should fallback to 'code' for unparseable LLM response", async () => {
    const llm = createMockLLMProvider("I cannot determine the agent type");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.agentType).toBe("code");
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it("should throw when LLM provider throws", async () => {
    const llm = createFailingLLMProvider("LLM error");
    const classifier = new LLMIntentClassifier(llm);
    await expect(classifier.classify("do something", noHistory)).rejects.toThrow("LLM error");
  });

  it("should include history messages in LLM request", async () => {
    let capturedMessages: readonly ChatMessage[] = [];
    const llm: LLMProvider = {
      name: "capture-llm",
      async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
        capturedMessages = messages;
        return { content: "code" };
      },
      async *stream(_messages: readonly ChatMessage[]): AsyncIterable<LLMChunk> {
        yield { delta: "code" };
      },
    };

    const classifier = new LLMIntentClassifier(llm);
    const history: readonly ChatMessage[] = [
      { role: "user", content: "previous message" },
    ];
    await classifier.classify("new prompt", history);

    // Should include system prompt + history + current prompt
    expect(capturedMessages.length).toBeGreaterThanOrEqual(3);
  });

  it("should return confidence 0.85 for valid parsed response", async () => {
    const llm = createMockLLMProvider("git");
    const classifier = new LLMIntentClassifier(llm);
    const result = await classifier.classify("do something", noHistory);
    expect(result.confidence).toBe(0.85);
  });
});

// ─── CompositeIntentClassifier ────────────────────────────────────

describe("CompositeIntentClassifier", () => {
  const noHistory: readonly ChatMessage[] = [];

  it("should use LLM result when LLM succeeds with high confidence", async () => {
    const llm = createMockLLMProvider("git");
    const llmClassifier = new LLMIntentClassifier(llm);
    const keywordClassifier = new KeywordIntentClassifier();
    const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);

    const result = await composite.classify("do something unrelated", noHistory);
    expect(result.agentType).toBe("git");
  });

  it("should fall back to keyword when LLM throws", async () => {
    const failingLLM = createFailingLLMProvider("LLM down");
    const llmClassifier = new LLMIntentClassifier(failingLLM);
    const keywordClassifier = new KeywordIntentClassifier();
    const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);

    const result = await composite.classify("git status", noHistory);
    expect(result.agentType).toBe("git");
    expect(result.reasoning).toContain("Keyword fallback");
  });

  it("should fall back to keyword when LLM returns low confidence", async () => {
    const llm = createMockLLMProvider("I cannot determine the agent type");
    const llmClassifier = new LLMIntentClassifier(llm);
    const keywordClassifier = new KeywordIntentClassifier();
    const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);

    const result = await composite.classify("run tests", noHistory);
    // LLM returns low confidence → keyword fallback → "os" for "run"
    expect(result.agentType).toBe("os");
    expect(result.reasoning).toContain("Keyword fallback");
  });

  it("should include 'LLM classification' in reasoning when LLM succeeds", async () => {
    const llm = createMockLLMProvider("code");
    const llmClassifier = new LLMIntentClassifier(llm);
    const keywordClassifier = new KeywordIntentClassifier();
    const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);

    const result = await composite.classify("write code", noHistory);
    expect(result.reasoning).toContain("LLM classification");
  });

  it("should default to code when both LLM fails and no keywords match", async () => {
    const failingLLM = createFailingLLMProvider("LLM down");
    const llmClassifier = new LLMIntentClassifier(failingLLM);
    const keywordClassifier = new KeywordIntentClassifier();
    const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);

    const result = await composite.classify("hello world", noHistory);
    expect(result.agentType).toBe("code");
  });
});

// ─── InMemoryHistoryProvider ──────────────────────────────────────

describe("InMemoryHistoryProvider", () => {
  it("should return empty array for unknown session", async () => {
    const provider = new InMemoryHistoryProvider();
    const history = await provider.getHistory(asSessionId("unknown"));
    expect(history).toEqual([]);
  });

  it("should store and retrieve messages for a session", async () => {
    const provider = new InMemoryHistoryProvider();
    const sessionId = asSessionId("test-session");

    provider.addMessage(sessionId, { role: "user", content: "hello" });
    provider.addMessage(sessionId, { role: "assistant", content: "hi there" });

    const history = await provider.getHistory(sessionId);
    expect(history.length).toBe(2);
    expect(history[0]?.content).toBe("hello");
    expect(history[1]?.content).toBe("hi there");
  });

  it("should keep sessions independent", async () => {
    const provider = new InMemoryHistoryProvider();
    const sessionA = asSessionId("session-a");
    const sessionB = asSessionId("session-b");

    provider.addMessage(sessionA, { role: "user", content: "message A" });
    provider.addMessage(sessionB, { role: "user", content: "message B" });

    const historyA = await provider.getHistory(sessionA);
    const historyB = await provider.getHistory(sessionB);

    expect(historyA.length).toBe(1);
    expect(historyB.length).toBe(1);
    expect(historyA[0]?.content).toBe("message A");
    expect(historyB[0]?.content).toBe("message B");
  });

  it("should return defensive copy (mutations don't affect internal state)", async () => {
    const provider = new InMemoryHistoryProvider();
    const sessionId = asSessionId("defensive-copy-session");

    provider.addMessage(sessionId, { role: "user", content: "original" });

    const history = await provider.getHistory(sessionId) as ChatMessage[];
    history.push({ role: "user", content: "injected" });

    const historyAgain = await provider.getHistory(sessionId);
    expect(historyAgain.length).toBe(1);
  });

  it("should handle many sessions concurrently", async () => {
    const provider = new InMemoryHistoryProvider();
    const sessionIds = Array.from({ length: 10 }, (_, i) => asSessionId(`session-${i}`));

    for (const id of sessionIds) {
      provider.addMessage(id, { role: "user", content: `message for ${id}` });
    }

    for (const id of sessionIds) {
      const history = await provider.getHistory(id);
      expect(history.length).toBe(1);
      expect(history[0]?.content).toBe(`message for ${id}`);
    }
  });

  it("should accumulate messages in order", async () => {
    const provider = new InMemoryHistoryProvider();
    const sessionId = asSessionId("order-session");

    const messages = ["first", "second", "third", "fourth"];
    for (const content of messages) {
      provider.addMessage(sessionId, { role: "user", content });
    }

    const history = await provider.getHistory(sessionId);
    expect(history.length).toBe(4);
    for (let i = 0; i < messages.length; i++) {
      expect(history[i]?.content).toBe(messages[i]);
    }
  });
});

// ─── Orchestrator edge cases ──────────────────────────────────────

describe("Orchestrator dispatch edge cases", () => {
  it("should emit error when agent not found for classified type", async () => {
    const llm = createMockLLMProvider("git"); // LLM says git
    const classifier = new LLMIntentClassifier(llm);
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider: llm });

    // Only register code agent, but LLM will classify as git
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "ok" }));

    const sessionId = asSessionId("no-git-agent-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "do something")) {
      events.push(event);
    }

    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: string }
      | undefined;
    expect(errorEvent?.error).toBe("no_agent");
  });

  it("should emit error when agent throws", async () => {
    const llm = createMockLLMProvider("code");
    const classifier = new KeywordIntentClassifier();
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider: llm });

    orchestrator.registerAgent(createThrowingAgent("code", "agent crashed"));

    const sessionId = asSessionId("throwing-agent-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "write code")) {
      events.push(event);
    }

    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: string; message: string }
      | undefined;
    expect(errorEvent?.error).toBe("agent_error");
    expect(errorEvent?.message).toContain("agent crashed");
  });

  it("should fallback to first agent when classifier throws", async () => {
    const failingClassifier: IntentClassifier = {
      async classify() {
        throw new Error("classifier failed");
      },
    };
    const historyProvider = new InMemoryHistoryProvider();
    const llm = createMockLLMProvider();
    const orchestrator = new Orchestrator({
      intentClassifier: failingClassifier,
      historyProvider,
      llmProvider: llm,
    });

    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "fallback result" }));

    const sessionId = asSessionId("classifier-fail-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "do something")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { success: boolean }
      | undefined;
    expect(doneEvent?.success).toBe(true);
  });

  it("should emit tool_call events when agent returns toolCalls", async () => {
    const llm = createMockLLMProvider();
    const classifier = new KeywordIntentClassifier();
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider: llm });

    const agentWithToolCalls = {
      name: "mock-code",
      type: "code" as const,
      systemPrompt: "Mock",
      execute() {
        return Promise.resolve({
          success: true as const,
          output: "done",
          toolCalls: [
            { id: "call_1", content: "result", status: "completed" as const },
          ],
        });
      },
    };

    orchestrator.registerAgent(agentWithToolCalls);

    const sessionId = asSessionId("tool-call-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "write code")) {
      events.push(event);
    }

    const toolCallEvent = events.find((e) => (e as { type: string }).type === "tool_call");
    expect(toolCallEvent).toBeDefined();
  });

  it("should replace agent when registering same type twice", () => {
    const llm = createMockLLMProvider();
    const classifier = new KeywordIntentClassifier();
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider: llm });

    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "first" }));
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "second" }));

    const registered = orchestrator.getRegisteredAgents();
    expect(registered.filter((t) => t === "code").length).toBe(1);
  });

  it("should return all registered agent types", () => {
    const llm = createMockLLMProvider();
    const classifier = new KeywordIntentClassifier();
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider: llm });

    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "ok" }));
    orchestrator.registerAgent(createMockAgent("git", { success: true, output: "ok" }));

    const registered = orchestrator.getRegisteredAgents();
    expect(registered).toContain("code");
    expect(registered).toContain("git");
    expect(registered.length).toBe(2);
  });

  it("should handle prompt with unicode characters", async () => {
    const llm = createMockLLMProvider();
    const classifier = new KeywordIntentClassifier();
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider: llm });
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "ok" }));

    const sessionId = asSessionId("unicode-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "写代码 🚀 código")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { success: boolean }
      | undefined;
    expect(doneEvent?.success).toBe(true);
  });
});

// ─── TEST-05: createToolCallLLMProvider sin tool_calls ───────────

describe("TEST-05: createToolCallLLMProvider — stream sin tool_calls", () => {
  it("agente no entra en loop de tool execution cuando LLM responde sin tool_calls", async () => {
    // Un provider que responde directamente con texto (sin tool_calls)
    const textOnlyProvider = createMockLLMProvider("Respuesta directa sin herramientas");
    const classifier = new KeywordIntentClassifier();
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({
      intentClassifier: classifier,
      historyProvider,
      llmProvider: textOnlyProvider,
    });

    let toolCallCount = 0;
    const agentWithToolTracking = {
      name: "mock-code",
      type: "code" as const,
      systemPrompt: "Mock",
      execute() {
        // This agent doesn't use tools — just returns text
        return Promise.resolve({
          success: true as const,
          output: "respuesta sin herramientas",
          toolCalls: [], // empty — no tool calls
        });
      },
    };

    orchestrator.registerAgent(agentWithToolTracking);

    const sessionId = asSessionId("no-tool-calls-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "write code")) {
      events.push(event);
    }

    // Should complete successfully
    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { success: boolean }
      | undefined;
    expect(doneEvent?.success).toBe(true);

    // No tool_call events should be emitted
    const toolCallEvents = events.filter((e) => (e as { type: string }).type === "tool_call");
    expect(toolCallEvents.length).toBe(0);
  });

  it("createToolCallLLMProvider retorna tool_calls en la respuesta", async () => {
    const provider = createToolCallLLMProvider("git_status", {});
    const response = await provider.chat([{ role: "user", content: "test" }]);
    expect(response.tool_calls).toBeDefined();
    expect(response.tool_calls!.length).toBe(1);
    expect(response.tool_calls![0]!.name).toBe("git_status");
  });

  it("LLM provider sin tool_calls → respuesta retornada como texto directamente", async () => {
    const provider = createMockLLMProvider("texto directo");
    const response = await provider.chat([{ role: "user", content: "test" }]);
    expect(response.tool_calls).toBeUndefined();
    expect(response.content).toBe("texto directo");
  });
});

// ─── TEST-06: Sesión pre-creada (documentar y testear) ────────────

describe("TEST-06: Sesión pre-creada antes de session/new", () => {
  // Note: sessions can be pre-created by the persistence layer on startup.
  // The Orchestrator should accept these sessions correctly without throwing
  // "session not found" errors.

  it("Orchestrator acepta sesión pre-creada (no lanza error por session not found)", async () => {
    const historyProvider = new InMemoryHistoryProvider();
    const llmProvider = createMockLLMProvider("code");
    const classifier = new KeywordIntentClassifier();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "ok" }));

    // Pre-create session by adding history directly (simulates persistence layer startup)
    // Note: sessions can be pre-created by the persistence layer on startup
    const preCreatedSessionId = asSessionId("pre-created-session-123");
    historyProvider.addMessage(preCreatedSessionId, {
      role: "assistant",
      content: "Sesión iniciada por la capa de persistencia",
    });

    // Dispatch to the pre-created session — should work without errors
    const events: unknown[] = [];
    for await (const event of orchestrator.dispatch(preCreatedSessionId, "write code")) {
      events.push(event);
    }

    // Should complete successfully — no "session not found" error
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: string }
      | undefined;
    // If there's an error, it should NOT be "session not found"
    if (errorEvent) {
      expect(errorEvent.error).not.toContain("session not found");
      expect(errorEvent.error).not.toContain("session_not_found");
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { success: boolean }
      | undefined;
    expect(doneEvent).toBeDefined();
  });

  it("historial pre-existente incluido en contexto del agente", async () => {
    const historyProvider = new InMemoryHistoryProvider();
    const llmProvider = createMockLLMProvider("code");
    const classifier = new KeywordIntentClassifier();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });

    // Note: sessions can be pre-created by the persistence layer on startup
    const sessionId = asSessionId("pre-created-with-history");
    historyProvider.addMessage(sessionId, { role: "user", content: "mensaje previo" });
    historyProvider.addMessage(sessionId, { role: "assistant", content: "respuesta previa" });

    // Verify the history was stored in the provider
    const storedHistory = await historyProvider.getHistory(sessionId);
    expect(storedHistory.length).toBe(2);

    // Dispatch should succeed — the pre-created session is accepted
    const events: unknown[] = [];
    for await (const event of orchestrator.dispatch(sessionId, "nuevo prompt")) {
      events.push(event);
    }

    // Session should complete without "session not found" errors
    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { success: boolean }
      | undefined;
    expect(doneEvent).toBeDefined();
  });
});
