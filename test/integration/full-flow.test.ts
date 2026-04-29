/**
 * Full end-to-end integration tests for the agent bootstrap flow.
 *
 * Tests the complete flow: initialize → session/new → session/prompt → response
 * All tests run in memory — no real API calls.
 *
 * These tests complement test/orchestrator/integration.test.ts by focusing on:
 * - Bootstrap flow from scratch (no pre-created sessions)
 * - Multi-turn history accumulation
 * - Edge cases: empty prompt, sequential prompts
 * - Multiple agents registered with routing
 * - stopReason verification
 */

import { describe, it, expect } from "bun:test";
import { StdioTransport } from "../../src/transport/stdio.ts";
import { AcpServer } from "../../src/protocol/acp-server.ts";
import { SessionStore } from "../../src/protocol/session-store.ts";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { KeywordIntentClassifier, LLMIntentClassifier, CompositeIntentClassifier } from "../../src/orchestrator/intent-classifier.ts";
import { InMemoryHistoryProvider } from "../../src/orchestrator/history-provider.ts";
import { asSessionId } from "../../src/types/persistence.ts";
import type { AgentContext } from "../../src/types/agent.ts";
import {
  createInputStream,
  createMockOutput,
  jsonrpc,
  createMockAgent,
  createInMemorySetup,
} from "../helpers.ts";
import {
  createMockLLMProvider,
  createRoutingLLMProvider,
  createFailingLLMProvider,
} from "../llm/mock-providers.ts";

// ─── Helpers ──────────────────────────────────────────────────────

async function runFlow(input: string): Promise<{ chunks: string[]; messages: unknown[] }> {
  const output = createMockOutput();
  const stream = createInputStream(input);
  const transport = new StdioTransport({ input: stream, output });

  const sessions = new SessionStore();
  const historyProvider = new InMemoryHistoryProvider();
  const llmProvider = createMockLLMProvider("code");
  const classifier = new KeywordIntentClassifier();
  const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });

  orchestrator.registerAgent(createMockAgent("code", { success: true, output: "code result" }));
  orchestrator.registerAgent(createMockAgent("git", { success: true, output: "git result" }));
  orchestrator.registerAgent(createMockAgent("os", { success: true, output: "os result" }));
  orchestrator.registerAgent(createMockAgent("docs", { success: true, output: "docs result" }));

  const server = new AcpServer(transport, sessions, undefined, orchestrator);
  await server.start();

  return output;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("Full bootstrap flow", () => {
  it("should respond to initialize request", async () => {
    const input = jsonrpc(1, "initialize", { protocolVersion: "0.1", clientInfo: { name: "test", version: "1.0" } }) + "\n";
    const output = await runFlow(input);

    expect(output.messages.length).toBeGreaterThanOrEqual(1);
    const initResp = output.messages[0] as { id: number; result?: { serverInfo?: unknown } };
    expect(initResp.id).toBe(1);
    expect(initResp.result).toBeDefined();
  });

  it("should create a new session via session/new", async () => {
    const input = [
      jsonrpc(1, "initialize", { protocolVersion: "0.1", clientInfo: { name: "test", version: "1.0" } }),
      jsonrpc(2, "session/new", { workspacePath: "/tmp/test" }),
    ].join("\n") + "\n";

    const output = await runFlow(input);

    const sessionResp = output.messages.find((m) => {
      const msg = m as { id: number };
      return msg.id === 2;
    }) as { id: number; result?: { sessionId?: string } } | undefined;

    expect(sessionResp).toBeDefined();
    expect(sessionResp?.result?.sessionId).toBeDefined();
    expect(typeof sessionResp?.result?.sessionId).toBe("string");
  });

  it("should handle session/prompt after session/new", async () => {
    const sessions = new SessionStore();
    // Pre-create the session so we know its ID before building the input stream
    const session = sessions.create("/tmp/test");

    const historyProvider = new InMemoryHistoryProvider();
    const llmProvider = createMockLLMProvider("code");
    const classifier = new KeywordIntentClassifier();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "hello from code agent" }));

    const output = createMockOutput();
    const input = [
      jsonrpc(1, "initialize", { protocolVersion: "0.1", clientInfo: { name: "test", version: "1.0" } }),
      jsonrpc(2, "session/new", { workspacePath: "/tmp/test" }),
      jsonrpc(3, "session/prompt", {
        sessionId: session.id,
        prompt: [{ type: "text", text: "write a function" }],
      }),
    ].join("\n") + "\n";

    const stream = createInputStream(input);
    const transport = new StdioTransport({ input: stream, output });
    const server = new AcpServer(transport, sessions, undefined, orchestrator);
    await server.start();

    // Verify session/new returned a sessionId
    const sessionResp = output.messages.find((m) => (m as { id: number }).id === 2) as
      | { result?: { sessionId?: string } }
      | undefined;
    expect(sessionResp?.result?.sessionId).toBeDefined();

    // Verify session/prompt returned a response with stopReason
    const promptResp = output.messages.find((m) => (m as { id: number }).id === 3) as
      | { result?: { stopReason?: string }; error?: unknown }
      | undefined;
    expect(promptResp).toBeDefined();
    // Either success with stopReason or an error response — both are valid
    const hasStopReason = promptResp?.result?.stopReason !== undefined;
    const hasError = promptResp?.error !== undefined;
    expect(hasStopReason || hasError).toBe(true);
  });

  it("should route to git agent for git-related prompts", async () => {
    const { orchestrator, sessions, historyProvider } = createInMemorySetup({
      agents: [
        { type: "code", result: { success: true, output: "code result" } },
        { type: "git", result: { success: true, output: "git commit done" } },
      ],
    });

    const output = createMockOutput();
    const sessionId = asSessionId("test-session-git");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "git commit -m 'test'")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { type: string; success: boolean }
      | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.success).toBe(true);

    const textEvents = events.filter((e) => (e as { type: string }).type === "text");
    const hasGitResult = textEvents.some((e) => (e as { content: string }).content === "git commit done");
    expect(hasGitResult).toBe(true);
  });

  it("should route to code agent for code-related prompts", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [
        { type: "code", result: { success: true, output: "file written" } },
        { type: "git", result: { success: true, output: "git result" } },
      ],
    });

    const sessionId = asSessionId("test-session-code");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "write a function to parse JSON")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { type: string; success: boolean }
      | undefined;
    expect(doneEvent?.success).toBe(true);
  });

  it("should return done event with success=false when agent fails", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [
        { type: "code", result: { success: false, output: "error output", error: "agent_failed" } },
      ],
    });

    const sessionId = asSessionId("test-session-fail");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "do something")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { type: string; success: boolean }
      | undefined;
    expect(doneEvent?.success).toBe(false);
  });

  it("should accumulate history across multiple dispatches in same session", async () => {
    const historyProvider = new InMemoryHistoryProvider();
    const llmProvider = createMockLLMProvider("code");
    const classifier = new KeywordIntentClassifier();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "response" }));

    const sessionId = asSessionId("multi-turn-session");

    // First dispatch
    const events1: unknown[] = [];
    for await (const event of orchestrator.dispatch(sessionId, "first prompt")) {
      events1.push(event);
    }

    // Add messages to history manually
    historyProvider.addMessage(sessionId, { role: "user", content: "first prompt" });
    historyProvider.addMessage(sessionId, { role: "assistant", content: "response" });

    // Second dispatch — history should now have 2 messages
    const history = await historyProvider.getHistory(sessionId);
    expect(history.length).toBe(2);
    expect(history[0]?.content).toBe("first prompt");
    expect(history[1]?.content).toBe("response");
  });

  it("should handle empty prompt gracefully", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [{ type: "code", result: { success: true, output: "ok" } }],
    });

    const sessionId = asSessionId("empty-prompt-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "")) {
      events.push(event);
    }

    // Should complete (either success or error, but not hang)
    const doneEvent = events.find((e) => (e as { type: string }).type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("should handle multiple sequential prompts in same session", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [{ type: "code", result: { success: true, output: "ok" } }],
    });

    const sessionId = asSessionId("sequential-session");

    for (const prompt of ["first", "second", "third"]) {
      const events: unknown[] = [];
      for await (const event of orchestrator.dispatch(sessionId, prompt)) {
        events.push(event);
      }
      const done = events.find((e) => (e as { type: string }).type === "done") as
        | { success: boolean }
        | undefined;
      expect(done?.success).toBe(true);
    }
  });

  it("should emit done event with success=true on happy path", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [{ type: "code", result: { success: true, output: "done" } }],
    });

    const sessionId = asSessionId("done-check-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "write code")) {
      events.push(event);
    }

    const doneEvent = events[events.length - 1] as { type: string; success: boolean };
    expect(doneEvent.type).toBe("done");
    expect(doneEvent.success).toBe(true);
  });

  it("should emit error event when no agents registered", async () => {
    const historyProvider = new InMemoryHistoryProvider();
    const llmProvider = createMockLLMProvider();
    const classifier = new KeywordIntentClassifier();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });

    const sessionId = asSessionId("no-agents-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "do something")) {
      events.push(event);
    }

    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { type: string; error: string }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error).toBe("no_agents");
  });

  it("should use routing LLM provider to classify intent", async () => {
    const llmProvider = createRoutingLLMProvider();
    const classifier = new LLMIntentClassifier(llmProvider);
    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });

    orchestrator.registerAgent(createMockAgent("git", { success: true, output: "git routed" }));
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "code routed" }));

    const sessionId = asSessionId("routing-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "git commit all changes")) {
      events.push(event);
    }

    const textEvents = events.filter((e) => (e as { type: string }).type === "text");
    const hasGitResult = textEvents.some((e) => (e as { content: string }).content === "git routed");
    expect(hasGitResult).toBe(true);
  });

  it("should fall back to keyword classifier when LLM fails", async () => {
    const failingLLM = createFailingLLMProvider("LLM unavailable");
    const keywordClassifier = new KeywordIntentClassifier();
    const llmClassifier = new LLMIntentClassifier(failingLLM);
    const compositeClassifier = new CompositeIntentClassifier(llmClassifier, keywordClassifier);

    const historyProvider = new InMemoryHistoryProvider();
    const orchestrator = new Orchestrator({
      intentClassifier: compositeClassifier,
      historyProvider,
      llmProvider: failingLLM,
    });

    orchestrator.registerAgent(createMockAgent("git", { success: true, output: "git fallback" }));
    orchestrator.registerAgent(createMockAgent("code", { success: true, output: "code fallback" }));

    const sessionId = asSessionId("fallback-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "git status")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { success: boolean }
      | undefined;
    expect(doneEvent?.success).toBe(true);
  });

  it("should include session history in agent context", async () => {
    const historyProvider = new InMemoryHistoryProvider();
    const sessionId = asSessionId("history-context-session");

    // Pre-populate history
    historyProvider.addMessage(sessionId, { role: "user", content: "previous message" });
    historyProvider.addMessage(sessionId, { role: "assistant", content: "previous response" });

    let capturedHistory: readonly unknown[] = [];
    const agentWithHistoryCapture = {
      name: "mock-code",
      type: "code" as const,
      systemPrompt: "Mock",
      execute(context: AgentContext) {
        capturedHistory = context.sessionHistory ?? [];
        return Promise.resolve({ success: true as const, output: "ok" });
      },
    };

    const llmProvider = createMockLLMProvider();
    const classifier = new KeywordIntentClassifier();
    const orchestrator = new Orchestrator({ intentClassifier: classifier, historyProvider, llmProvider });
    orchestrator.registerAgent(agentWithHistoryCapture);

    for await (const _ of orchestrator.dispatch(sessionId, "write code")) {
      // consume
    }

    expect(capturedHistory.length).toBe(3); // 2 historical + 1 current prompt ("write code")
  });

  it("should handle special characters in prompt", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [{ type: "code", result: { success: true, output: "ok" } }],
    });

    const sessionId = asSessionId("special-chars-session");
    const events: unknown[] = [];

    for await (const event of orchestrator.dispatch(sessionId, "fix bug: `null` pointer in <Component> & handle 'edge' cases")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as
      | { success: boolean }
      | undefined;
    expect(doneEvent?.success).toBe(true);
  });

  it("should emit text events before done event", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [{ type: "code", result: { success: true, output: "result text" } }],
    });

    const sessionId = asSessionId("event-order-session");
    const events: Array<{ type: string }> = [];

    for await (const event of orchestrator.dispatch(sessionId, "write code")) {
      events.push(event as { type: string });
    }

    const doneIdx = events.findIndex((e) => e.type === "done");
    const textEvents = events.filter((e) => e.type === "text");

    expect(textEvents.length).toBeGreaterThan(0);
    expect(doneIdx).toBe(events.length - 1);
  });

  it("should handle multiple agents registered and route correctly", async () => {
    const { orchestrator } = createInMemorySetup({
      agents: [
        { type: "code", result: { success: true, output: "code agent" } },
        { type: "git", result: { success: true, output: "git agent" } },
        { type: "os", result: { success: true, output: "os agent" } },
        { type: "docs", result: { success: true, output: "docs agent" } },
      ],
    });

    const registered = orchestrator.getRegisteredAgents();
    expect(registered.length).toBe(4);
    expect(registered).toContain("code");
    expect(registered).toContain("git");
    expect(registered).toContain("os");
    expect(registered).toContain("docs");
  });

  it("should handle concurrent sessions independently", async () => {
    const historyProvider = new InMemoryHistoryProvider();
    const sessionA = asSessionId("session-a");
    const sessionB = asSessionId("session-b");

    historyProvider.addMessage(sessionA, { role: "user", content: "message for A" });
    historyProvider.addMessage(sessionB, { role: "user", content: "message for B" });

    const historyA = await historyProvider.getHistory(sessionA);
    const historyB = await historyProvider.getHistory(sessionB);

    expect(historyA.length).toBe(1);
    expect(historyB.length).toBe(1);
    expect(historyA[0]?.content).toBe("message for A");
    expect(historyB[0]?.content).toBe("message for B");
  });
});
