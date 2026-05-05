/**
 * Tests for the Orchestrator class and InMemoryHistoryProvider.
 *
 * TDD: Tests written FIRST, implementations after.
 *
 * Covers:
 * - registerAgent / getRegisteredAgents
 * - dispatch (happy path, errors, edge cases)
 * - InMemoryHistoryProvider
 */

import { describe, it, expect, mock } from "bun:test";
import type {
  AgentEvent,
  AgentType,
  Agent,
  AgentResult,
  AgentContext,
  IntentClassifier,
  IntentClassificationResult,
  SessionHistoryProvider,
  LLMProvider,
  ChatMessage,
  ToolResult,
} from "../../src/orchestrator/index.ts";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { InMemoryHistoryProvider } from "../../src/orchestrator/history-provider.ts";
import type { SessionId } from "../../src/types/persistence.ts";

// ─── Helpers ──────────────────────────────────────────────────────

/** Creates a branded SessionId for tests. */
function makeSessionId(id: string): SessionId {
  return id as SessionId;
}

/** Creates a mock LLMProvider. */
function createMockLLMProvider(): LLMProvider {
  return {
    name: "mock-llm",
    async chat(_messages: readonly ChatMessage[]) {
      return { content: "mock response" };
    },
    async *_stream(_messages: readonly ChatMessage[]) {
      yield { delta: "mock" };
    },
    stream(_messages: readonly ChatMessage[]) {
      return this._stream(_messages);
    },
  };
}

/** Creates a mock Agent with configurable result. */
function createMockAgent(type: AgentType, result: AgentResult): Agent {
  return {
    name: `mock-${type}`,
    type,
    systemPrompt: `Mock ${type} agent`,
    execute: mock((_context: AgentContext) => Promise.resolve(result)),
  };
}

/** Creates a mock Agent that throws on execute. */
function createThrowingAgent(type: AgentType, errorMsg: string): Agent {
  return {
    name: `mock-${type}`,
    type,
    systemPrompt: `Mock ${type} agent`,
    execute: mock((_context: AgentContext) =>
      Promise.reject(new Error(errorMsg)),
    ),
  };
}

/** Creates a mock IntentClassifier that returns a fixed classification. */
function createMockClassifier(
  agentType: AgentType,
  options?: { shouldThrow?: boolean },
): IntentClassifier {
  return {
    classify: mock(
      (
        _prompt: string,
        _history: readonly ChatMessage[],
      ): Promise<IntentClassificationResult> => {
        if (options?.shouldThrow) {
          return Promise.reject(new Error("Classification failed"));
        }
        return Promise.resolve({
          agentType,
          confidence: 1.0,
          reasoning: `Mock classification to ${agentType}`,
        });
      },
    ),
  };
}

/** Creates a mock SessionHistoryProvider with fixed messages. */
function createMockHistory(
  messages: ChatMessage[] = [],
): SessionHistoryProvider {
  return {
    getHistory: mock((_sessionId: SessionId) =>
      Promise.resolve(messages),
    ),
  };
}

/** Collects all events from an AsyncIterable<AgentEvent>. */
async function collectEvents(
  iterable: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Creates a fresh Orchestrator with default mocks. */
function createTestOrchestrator(deps?: {
  classifier?: IntentClassifier;
  history?: SessionHistoryProvider;
  llmProvider?: LLMProvider;
}) {
  return new Orchestrator({
    intentClassifier: deps?.classifier ?? createMockClassifier("code"),
    historyProvider: deps?.history ?? createMockHistory(),
    llmProvider: deps?.llmProvider ?? createMockLLMProvider(),
  });
}

// ═══════════════════════════════════════════════════════════════════
// InMemoryHistoryProvider
// ═══════════════════════════════════════════════════════════════════

describe("InMemoryHistoryProvider", () => {
  it("should return empty array for unknown session", async () => {
    const provider = new InMemoryHistoryProvider();
    const history = await provider.getHistory(makeSessionId("unknown"));
    expect(history).toEqual([]);
  });

  it("should return messages added via addMessage", async () => {
    const provider = new InMemoryHistoryProvider();
    const sessionId = makeSessionId("sess-001");

    provider.addMessage(sessionId, { role: "user", content: "Hello" });
    provider.addMessage(sessionId, { role: "assistant", content: "Hi there" });

    const history = await provider.getHistory(sessionId);
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("Hello");
    expect(history[1]!.content).toBe("Hi there");
  });

  it("should separate messages by session", async () => {
    const provider = new InMemoryHistoryProvider();
    const sess1 = makeSessionId("sess-001");
    const sess2 = makeSessionId("sess-002");

    provider.addMessage(sess1, { role: "user", content: "Session 1" });
    provider.addMessage(sess2, { role: "user", content: "Session 2" });

    const hist1 = await provider.getHistory(sess1);
    const hist2 = await provider.getHistory(sess2);

    expect(hist1).toHaveLength(1);
    expect(hist1[0]!.content).toBe("Session 1");
    expect(hist2).toHaveLength(1);
    expect(hist2[0]!.content).toBe("Session 2");
  });

  it("should return readonly array (immutable snapshot)", async () => {
    const provider = new InMemoryHistoryProvider();
    const sessionId = makeSessionId("sess-001");

    provider.addMessage(sessionId, { role: "user", content: "Hello" });

    const history1 = await provider.getHistory(sessionId);
    const history2 = await provider.getHistory(sessionId);

    // Both calls should return independent snapshots
    expect(history1).toEqual(history2);
    // They should not be the same reference (defensive copy)
    expect(history1).not.toBe(history2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orchestrator — registerAgent / getRegisteredAgents
// ═══════════════════════════════════════════════════════════════════

describe("Orchestrator — registerAgent", () => {
  it("should register an agent and make it available via getRegisteredAgents", () => {
    const orchestrator = createTestOrchestrator();
    const agent = createMockAgent("code", {
      success: true,
      output: "done",
    });

    orchestrator.registerAgent(agent);

    const types = orchestrator.getRegisteredAgents();
    expect(types).toEqual(["code"]);
  });

  it("should register multiple agents of different types", () => {
    const orchestrator = createTestOrchestrator();

    orchestrator.registerAgent(
      createMockAgent("code", { success: true, output: "code done" }),
    );
    orchestrator.registerAgent(
      createMockAgent("git", { success: true, output: "git done" }),
    );

    const types = orchestrator.getRegisteredAgents();
    expect(types).toContain("code");
    expect(types).toContain("git");
    expect(types).toHaveLength(2);
  });

  it("should replace agent when registering same type twice", () => {
    const orchestrator = createTestOrchestrator();

    const agent1 = createMockAgent("code", {
      success: true,
      output: "agent1",
    });
    const agent2 = createMockAgent("code", {
      success: true,
      output: "agent2",
    });

    orchestrator.registerAgent(agent1);
    orchestrator.registerAgent(agent2);

    const types = orchestrator.getRegisteredAgents();
    expect(types).toEqual(["code"]);
    expect(types).toHaveLength(1);
  });

  it("should return empty array when no agents registered", () => {
    const orchestrator = createTestOrchestrator();
    expect(orchestrator.getRegisteredAgents()).toEqual([]);
  });

  it("should return readonly array (not mutable from outside)", () => {
    const orchestrator = createTestOrchestrator();
    orchestrator.registerAgent(
      createMockAgent("code", { success: true, output: "" }),
    );

    const types = orchestrator.getRegisteredAgents();
    // Attempting to mutate should not affect internal state
    expect(() => {
      (types as AgentType[]).push("os");
    }).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orchestrator — dispatch (happy path)
// ═══════════════════════════════════════════════════════════════════

describe("Orchestrator — dispatch", () => {
  it("should classify intent and dispatch to correct agent", async () => {
    const classifier = createMockClassifier("git");
    const orchestrator = createTestOrchestrator({ classifier });

    const gitAgent = createMockAgent("git", {
      success: true,
      output: "Committed successfully",
    });
    orchestrator.registerAgent(gitAgent);

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "git commit my changes"),
    );

    // Should have text (status), text (output), and done events
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]!.success).toBe(true);

    // Verify agent was called
    expect(gitAgent.execute).toHaveBeenCalledTimes(1);
  });

  it("should emit text events for status messages", async () => {
    const classifier = createMockClassifier("code");
    const orchestrator = createTestOrchestrator({ classifier });

    orchestrator.registerAgent(
      createMockAgent("code", { success: true, output: "File read" }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "read the file"),
    );

    const textEvents = events.filter((e) => e.type === "text") as Array<{ type: "text"; content: string }>;
    // Should have at least 3 text events: "Analizando...", routing marker, "Delegando..."
    expect(textEvents.length).toBeGreaterThanOrEqual(3);

    // First text event should be the analyzing status
    expect(textEvents[0]!.content).toContain("Analizando");

    // Second text event should be the routing marker
    expect(textEvents[1]!.content).toContain("\x00ROUTING\x00");

    // Third text event should be the delegating status
    expect(textEvents[2]!.content).toContain("Delegando");
  });

  it("should emit done event on success", async () => {
    const orchestrator = createTestOrchestrator();

    orchestrator.registerAgent(
      createMockAgent("code", {
        success: true,
        output: "Operation complete",
      }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "do something"),
    );

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);

    const doneEvent = doneEvents[0]!;
    if (doneEvent.type === "done") {
      expect(doneEvent.success).toBe(true);
    }
  });

  it("should emit output as text event on success", async () => {
    const orchestrator = createTestOrchestrator();

    orchestrator.registerAgent(
      createMockAgent("code", {
        success: true,
        output: "File contents here",
      }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "read file"),
    );

    const textEvents = events.filter((e) => e.type === "text");
    const outputText = textEvents.find(
      (e) => e.type === "text" && e.content === "File contents here",
    );
    expect(outputText).toBeDefined();
  });

  it("should emit tool_call events when agent result includes toolCalls", async () => {
    const orchestrator = createTestOrchestrator();

    const toolCalls: readonly ToolResult[] = [
      { id: "tc-001", content: "file content", status: "completed" },
      { id: "tc-002", content: "search result", status: "completed" },
    ];

    orchestrator.registerAgent(
      createMockAgent("code", {
        success: true,
        output: "Done",
        toolCalls,
      }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "read file"),
    );

    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(2);
  });

  it("should build ExtendedAgentContext with session history", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ];
    const history = createMockHistory(messages);
    const classifier = createMockClassifier("code");
    const orchestrator = createTestOrchestrator({ classifier, history });

    let capturedContext: AgentContext | undefined;
    const agent: Agent = {
      name: "spy-code",
      type: "code",
      systemPrompt: "Spy agent",
      execute: mock(async (ctx: AgentContext) => {
        capturedContext = ctx;
        return { success: true, output: "spied" };
      }),
    };

    orchestrator.registerAgent(agent);

    await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "follow up"),
    );

    expect(capturedContext).toBeDefined();
    // Session history includes the 2 historical messages + the new prompt ("follow up")
    // ContextWindow adds the current prompt before building the active messages list.
    expect(capturedContext!.sessionHistory).toHaveLength(3);
    expect(capturedContext!.sessionHistory![0]!.content).toBe(
      "previous question",
    );
  });

  it("should pass workingDir to agent context", async () => {
    const orchestrator = createTestOrchestrator();

    let capturedContext: AgentContext | undefined;
    const agent: Agent = {
      name: "spy-code",
      type: "code",
      systemPrompt: "Spy agent",
      execute: mock(async (ctx: AgentContext) => {
        capturedContext = ctx;
        return { success: true, output: "done" };
      }),
    };

    orchestrator.registerAgent(agent);

    await collectEvents(
      orchestrator.dispatch(
        makeSessionId("s1"),
        "read file",
        "/custom/workspace",
      ),
    );

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.workingDir).toBe("/custom/workspace");
  });

  it("should default workingDir to process.cwd() when not provided", async () => {
    const orchestrator = createTestOrchestrator();

    let capturedContext: AgentContext | undefined;
    const agent: Agent = {
      name: "spy-code",
      type: "code",
      systemPrompt: "Spy agent",
      execute: mock(async (ctx: AgentContext) => {
        capturedContext = ctx;
        return { success: true, output: "done" };
      }),
    };

    orchestrator.registerAgent(agent);

    await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "read file"),
    );

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.workingDir).toBe(process.cwd());
  });

  it("should pass llmProvider in the extended context", async () => {
    const llmProvider = createMockLLMProvider();
    const orchestrator = createTestOrchestrator({ llmProvider });

    let capturedContext: AgentContext | undefined;
    const agent: Agent = {
      name: "spy-code",
      type: "code",
      systemPrompt: "Spy agent",
      execute: mock(async (ctx: AgentContext) => {
        capturedContext = ctx;
        return { success: true, output: "done" };
      }),
    };

    orchestrator.registerAgent(agent);

    await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "read file"),
    );

    // The extended context should have the llmProvider
    expect(capturedContext).toBeDefined();
    // Access via extended context — need to cast
    const extCtx = capturedContext as any;
    expect(extCtx.llmProvider).toBe(llmProvider);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orchestrator — dispatch (error handling)
// ═══════════════════════════════════════════════════════════════════

describe("Orchestrator — dispatch errors", () => {
  it("should emit error + done when no agents registered", async () => {
    const orchestrator = createTestOrchestrator();

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "do something"),
    );

    const errorEvents = events.filter((e) => e.type === "error");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0]!.type === "error") {
      expect(errorEvents[0]!.error).toBe("no_agents");
      expect(errorEvents[0]!.message).toContain("No agents registered");
    }

    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]!.type === "done") {
      expect(doneEvents[0]!.success).toBe(false);
    }
  });

  it("should emit error + done when agent not found for classified type", async () => {
    // Classifier returns "git", but only "code" agent is registered
    const classifier = createMockClassifier("git");
    const orchestrator = createTestOrchestrator({ classifier });

    orchestrator.registerAgent(
      createMockAgent("code", { success: true, output: "" }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "git commit"),
    );

    const errorEvents = events.filter((e) => e.type === "error");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0]!.type === "error") {
      expect(errorEvents[0]!.error).toBe("no_agent");
      expect(errorEvents[0]!.message).toContain("git");
    }

    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]!.type === "done") {
      expect(doneEvents[0]!.success).toBe(false);
    }
  });

  it("should emit error + done when agent.execute throws", async () => {
    const orchestrator = createTestOrchestrator();

    orchestrator.registerAgent(
      createThrowingAgent("code", "Agent execution exploded"),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "do something"),
    );

    const errorEvents = events.filter((e) => e.type === "error");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0]!.type === "error") {
      expect(errorEvents[0]!.error).toBe("agent_error");
      expect(errorEvents[0]!.message).toContain("Agent execution exploded");
    }

    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]!.type === "done") {
      expect(doneEvents[0]!.success).toBe(false);
    }
  });

  it("should emit error + done when agent.execute returns failure", async () => {
    const orchestrator = createTestOrchestrator();

    orchestrator.registerAgent(
      createMockAgent("code", {
        success: false,
        output: "Something went wrong with the file",
        error: "FILE_NOT_FOUND",
      }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "read missing file"),
    );

    const errorEvents = events.filter((e) => e.type === "error");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0]!.type === "error") {
      expect(errorEvents[0]!.error).toBe("FILE_NOT_FOUND");
      expect(errorEvents[0]!.message).toContain("Something went wrong");
    }

    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]!.type === "done") {
      expect(doneEvents[0]!.success).toBe(false);
    }
  });

  it("should default to first agent when classification fails/throws", async () => {
    const classifier = createMockClassifier("code", { shouldThrow: true });
    const orchestrator = createTestOrchestrator({ classifier });

    // Register "code" agent as first agent
    const codeAgent = createMockAgent("code", {
      success: true,
      output: "Fallback success",
    });
    orchestrator.registerAgent(codeAgent);

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "ambiguous prompt"),
    );

    // Should still succeed — fell back to first registered agent
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]!.type === "done") {
      expect(doneEvents[0]!.success).toBe(true);
    }

    // Agent should have been called
    expect(codeAgent.execute).toHaveBeenCalledTimes(1);
  });

  it("should emit error + done when classification fails and no agents registered", async () => {
    const classifier = createMockClassifier("code", { shouldThrow: true });
    const orchestrator = createTestOrchestrator({ classifier });
    // No agents registered

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "ambiguous prompt"),
    );

    const errorEvents = events.filter((e) => e.type === "error");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]!.type === "done") {
      expect(doneEvents[0]!.success).toBe(false);
    }
  });

  it("should emit error + done when getHistory() throws", async () => {
    const failingHistory: SessionHistoryProvider = {
      getHistory: mock((_sessionId: SessionId) =>
        Promise.reject(new Error("DB connection lost")),
      ),
    };
    const classifier = createMockClassifier("code");
    const orchestrator = createTestOrchestrator({ classifier, history: failingHistory });

    orchestrator.registerAgent(
      createMockAgent("code", { success: true, output: "done" }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "test"),
    );

    const errorEvents = events.filter((e) => e.type === "error");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0]!.type === "error") {
      expect(errorEvents[0]!.error).toBe("history_error");
      expect(errorEvents[0]!.message).toContain("Failed to retrieve session history");
      expect(errorEvents[0]!.message).toContain("DB connection lost");
    }

    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]!.type === "done") {
      expect(doneEvents[0]!.success).toBe(false);
    }
  });

  it("should always end with a done event as the last event", async () => {
    const orchestrator = createTestOrchestrator();

    orchestrator.registerAgent(
      createMockAgent("code", { success: true, output: "Done" }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "test"),
    );

    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1]!;
    expect(lastEvent.type).toBe("done");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orchestrator — dispatch (tool_calls in failure result)
// ═══════════════════════════════════════════════════════════════════

describe("Orchestrator — dispatch with toolCalls in failure", () => {
  it("should emit tool_call events even when agent returns failure", async () => {
    const orchestrator = createTestOrchestrator();

    const toolCalls: readonly ToolResult[] = [
      { id: "tc-001", content: "partial result", status: "failed" },
    ];

    orchestrator.registerAgent(
      createMockAgent("code", {
        success: false,
        output: "Failed after tool call",
        error: "TOOL_FAILED",
        toolCalls,
      }),
    );

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "do risky thing"),
    );

    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orchestrator — dispatch (session ID propagation)
// ═══════════════════════════════════════════════════════════════════

describe("Orchestrator — dispatch context propagation", () => {
  it("should pass the correct sessionId to the agent", async () => {
    const orchestrator = createTestOrchestrator();
    const sessionId = makeSessionId("my-special-session");

    let capturedContext: AgentContext | undefined;
    const agent: Agent = {
      name: "spy-code",
      type: "code",
      systemPrompt: "Spy agent",
      execute: mock(async (ctx: AgentContext) => {
        capturedContext = ctx;
        return { success: true, output: "done" };
      }),
    };

    orchestrator.registerAgent(agent);

    await collectEvents(
      orchestrator.dispatch(sessionId, "test prompt"),
    );

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.sessionId).toBe(sessionId);
  });

  it("should pass the prompt to the agent context", async () => {
    const orchestrator = createTestOrchestrator();

    let capturedContext: AgentContext | undefined;
    const agent: Agent = {
      name: "spy-code",
      type: "code",
      systemPrompt: "Spy agent",
      execute: mock(async (ctx: AgentContext) => {
        capturedContext = ctx;
        return { success: true, output: "done" };
      }),
    };

    orchestrator.registerAgent(agent);

    await collectEvents(
      orchestrator.dispatch(makeSessionId("s1"), "my specific prompt here"),
    );

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.prompt).toBe("my specific prompt here");
  });
});

// ═══════════════════════════════════════════════════════════════════
// DX-01: Routing marker event
// ═══════════════════════════════════════════════════════════════════

describe("dispatch routing marker", () => {
  it("should emit a routing marker event with the agent name before delegating", async () => {
    const orchestrator = createTestOrchestrator({
      classifier: createMockClassifier("code"),
    });

    const agent = createMockAgent("code", { success: true, output: "done" });
    orchestrator.registerAgent(agent);

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s-routing"), "test prompt"),
    );

    const routingEvent = events.find(
      (e) => e.type === "text" && e.content.startsWith("\x00ROUTING\x00"),
    );

    expect(routingEvent).toBeDefined();
    expect((routingEvent as { type: "text"; content: string }).content).toBe(
      `\x00ROUTING\x00mock-code`,
    );
  });

  it("routing marker should appear before the delegating text event", async () => {
    const orchestrator = createTestOrchestrator({
      classifier: createMockClassifier("code"),
    });

    const agent = createMockAgent("code", { success: true, output: "done" });
    orchestrator.registerAgent(agent);

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s-routing-order"), "test prompt"),
    );

    const textEvents = events.filter((e) => e.type === "text") as Array<{ type: "text"; content: string }>;
    const routingIdx = textEvents.findIndex((e) => e.content.startsWith("\x00ROUTING\x00"));
    const delegatingIdx = textEvents.findIndex((e) => e.content.includes("Delegando"));

    expect(routingIdx).toBeGreaterThanOrEqual(0);
    expect(delegatingIdx).toBeGreaterThanOrEqual(0);
    expect(routingIdx).toBeLessThan(delegatingIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════
// D-01: STATUS_MARKER en yields de progreso
// ═══════════════════════════════════════════════════════════════════

describe("dispatch STATUS_MARKER (D-01)", () => {
  it("primer yield de texto incluye STATUS_MARKER + 'Analizando tu solicitud'", async () => {
    const orchestrator = createTestOrchestrator({
      classifier: createMockClassifier("code"),
    });
    const agent = createMockAgent("code", { success: true, output: "done" });
    orchestrator.registerAgent(agent);

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s-status-1"), "hola"),
    );

    const textEvents = events.filter((e) => e.type === "text") as Array<{ type: "text"; content: string }>;
    const statusEvent = textEvents.find((e) => e.content.startsWith("\x00STATUS\x00") && e.content.includes("Analizando"));

    expect(statusEvent).toBeDefined();
    expect(statusEvent!.content).toBe("\x00STATUS\x00Analizando tu solicitud...");
  });

  it("yield de delegación incluye STATUS_MARKER + 'Delegando al agente'", async () => {
    const orchestrator = createTestOrchestrator({
      classifier: createMockClassifier("code"),
    });
    const agent = createMockAgent("code", { success: true, output: "done" });
    orchestrator.registerAgent(agent);

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s-status-2"), "hola"),
    );

    const textEvents = events.filter((e) => e.type === "text") as Array<{ type: "text"; content: string }>;
    const delegatingEvent = textEvents.find((e) => e.content.startsWith("\x00STATUS\x00") && e.content.includes("Delegando"));

    expect(delegatingEvent).toBeDefined();
    expect(delegatingEvent!.content).toContain("\x00STATUS\x00Delegando al agente de");
  });

  it("STATUS_MARKER es el prefijo correcto (\\x00STATUS\\x00)", async () => {
    const { STATUS_MARKER } = await import("../../src/orchestrator/orchestrator.ts");
    expect(STATUS_MARKER).toBe("\x00STATUS\x00");
  });

  it("ERR_MARKER es el prefijo correcto (\\x00ERR\\x00)", async () => {
    const { ERR_MARKER } = await import("../../src/orchestrator/orchestrator.ts");
    expect(ERR_MARKER).toBe("\x00ERR\x00");
  });

  it("output del LLM con marcadores NUL es filtrado antes de emitir", async () => {
    // Si el LLM genera \x00STATUS\x00 o \x00ERR\x00 en su output, deben eliminarse
    const orchestrator = createTestOrchestrator({
      classifier: createMockClassifier("code"),
    });
    const agent = createMockAgent("code", {
      success: true,
      output: "respuesta normal\x00STATUS\x00inyectado\x00ERR\x00también",
    });
    orchestrator.registerAgent(agent);

    const events = await collectEvents(
      orchestrator.dispatch(makeSessionId("s-nul-filter"), "hola"),
    );

    const textEvents = events.filter((e) => e.type === "text") as Array<{ type: "text"; content: string }>;
    const outputEvent = textEvents.find((e) => e.content.includes("respuesta normal"));

    expect(outputEvent).toBeDefined();
    expect(outputEvent!.content).not.toContain("\x00STATUS\x00");
    expect(outputEvent!.content).not.toContain("\x00ERR\x00");
    expect(outputEvent!.content).toBe("respuesta normalinyectadotambién");
  });
});
