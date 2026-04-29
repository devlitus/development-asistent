/**
 * Tests for orchestrator types: AgentEvent, OrchestratorConfig,
 * ExtendedAgentContext, IntentClassificationResult, IntentClassifier,
 * SessionHistoryProvider, ToolDefinition, ToolCallStatus.
 *
 * These tests validate:
 * 1. Types compile correctly (structural satisfaction via `satisfies`)
 * 2. Discriminated union narrowing works for AgentEvent
 * 3. ExtendedAgentContext is compatible with AgentContext
 * 4. Interface contracts can be implemented
 */

import { describe, it, expect } from "bun:test";
import {
  // Discriminated union & status
  type AgentEvent,
  type ToolCallStatus,
  // Config
  type OrchestratorConfig,
  // Extended context
  type ExtendedAgentContext,
  // Intent classification
  type IntentClassificationResult,
  type IntentClassifier,
  // Session history
  type SessionHistoryProvider,
  // Tool definition
  type ToolDefinition,
  // Re-exported existing types (verify barrel)
  type AgentContext,
  type AgentType,
  type LLMProvider,
  type SessionId,
  type ChatMessage,
  type ToolResult,
  // Const
  TOOL_CALL_STATUSES,
} from "../../src/orchestrator/index.ts";

// ─── Helpers ──────────────────────────────────────────────────────

/** Helper to create a branded SessionId for tests. */
function makeSessionId(id: string): SessionId {
  return id as SessionId;
}

/** Helper to create a minimal mock LLMProvider. */
function mockLLMProvider(): LLMProvider {
  return {
    name: "mock-provider",
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

// ─── AgentEvent (Discriminated Union) ─────────────────────────────

describe("orchestrator/types — AgentEvent", () => {
  it("should create a valid text event", () => {
    const event = {
      type: "text",
      content: "Hello from orchestrator",
    } satisfies AgentEvent;

    expect(event.type).toBe("text");
    expect(event.content).toBe("Hello from orchestrator");
  });

  it("should create a valid tool_call event", () => {
    const event = {
      type: "tool_call",
      id: "tc-001",
      name: "read_file",
      arguments: '{"path": "/src/main.ts"}',
      status: "completed" as ToolCallStatus,
    } satisfies AgentEvent;

    expect(event.type).toBe("tool_call");
    expect(event.id).toBe("tc-001");
    expect(event.name).toBe("read_file");
    expect(event.status).toBe("completed");
  });

  it("should create a valid permission_request event", () => {
    const event = {
      type: "permission_request",
      id: "perm-001",
      tool: "execute_shell",
      args: { command: "rm -rf /tmp/test" },
    } satisfies AgentEvent;

    expect(event.type).toBe("permission_request");
    expect(event.id).toBe("perm-001");
    expect(event.tool).toBe("execute_shell");
  });

  it("should create a valid error event", () => {
    const event = {
      type: "error",
      error: "LLM_TIMEOUT",
      message: "The LLM provider timed out after 30s",
    } satisfies AgentEvent;

    expect(event.type).toBe("error");
    expect(event.error).toBe("LLM_TIMEOUT");
    expect(event.message).toContain("timed out");
  });

  it("should create a valid done event with success=true", () => {
    const event = {
      type: "done",
      success: true,
    } satisfies AgentEvent;

    expect(event.type).done;
    expect(event.success).toBe(true);
  });

  it("should create a valid done event with success=false", () => {
    const event = {
      type: "done",
      success: false,
    } satisfies AgentEvent;

    expect(event.type).toBe("done");
    expect(event.success).toBe(false);
  });

  it("should narrow discriminated union with switch", () => {
    const events: AgentEvent[] = [
      { type: "text", content: "hi" },
      { type: "done", success: true },
    ];

    for (const event of events) {
      switch (event.type) {
        case "text":
          // TypeScript should narrow to the text variant
          expect(typeof event.content).toBe("string");
          break;
        case "done":
          // TypeScript should narrow to the done variant
          expect(typeof event.success).toBe("boolean");
          break;
        default:
          // Exhaustive check should not reach here
          throw new Error(`Unexpected event type: ${(event as AgentEvent).type}`);
      }
    }
  });

  it("should narrow discriminated union with if statements", () => {
    const event: AgentEvent = { type: "error", error: "E1", message: "fail" };

    if (event.type === "error") {
      expect(event.error).toBe("E1");
      expect(event.message).toBe("fail");
    } else {
      expect.unreachable("Should have narrowed to error variant");
    }
  });

  it("should allow all ToolCallStatus values", () => {
    const statuses: ToolCallStatus[] = ["pending", "in_progress", "completed", "failed"];
    expect(statuses).toHaveLength(4);
    expect(TOOL_CALL_STATUSES).toBeDefined();
    expect(Object.values(TOOL_CALL_STATUSES)).toHaveLength(4);
  });
});

// ─── OrchestratorConfig ───────────────────────────────────────────

describe("orchestrator/types — OrchestratorConfig", () => {
  it("should create a valid OrchestratorConfig with required fields", () => {
    const config = {
      classificationProvider: mockLLMProvider(),
      defaultTimeout: 30_000,
    } satisfies OrchestratorConfig;

    expect(config.defaultTimeout).toBe(30_000);
    expect(config.classificationProvider.name).toBe("mock-provider");
  });

  it("should create a valid OrchestratorConfig with optional fields", () => {
    const config = {
      classificationProvider: mockLLMProvider(),
      defaultTimeout: 30_000,
      maxRetries: 3,
      slidingWindowSize: 10,
    } satisfies OrchestratorConfig;

    expect(config.maxRetries).toBe(3);
    expect(config.slidingWindowSize).toBe(10);
  });
});

// ─── ExtendedAgentContext ─────────────────────────────────────────

describe("orchestrator/types — ExtendedAgentContext", () => {
  it("should satisfy AgentContext interface", () => {
    const provider = mockLLMProvider();
    const extCtx: ExtendedAgentContext = {
      sessionId: makeSessionId("sess-001"),
      prompt: "Read the main file",
      workingDir: "/workspace/project",
      workspacePath: "/workspace/project",
      llmProvider: provider,
      sessionHistory: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
      availableTools: [
        { name: "read_file", description: "Read file contents", parameters: { type: "object" } },
      ],
    };

    // ExtendedAgentContext must be assignable to AgentContext
    const baseCtx: AgentContext = extCtx;
    expect(baseCtx.sessionId).toBe("sess-001");
    expect(baseCtx.prompt).toBe("Read the main file");
  });

  it("should require sessionHistory as non-optional", () => {
    const extCtx = {
      sessionId: makeSessionId("sess-002"),
      prompt: "test",
      workingDir: "/tmp",
      workspacePath: "/tmp",
      llmProvider: mockLLMProvider(),
      sessionHistory: [],
      availableTools: [],
    } satisfies ExtendedAgentContext;

    // sessionHistory should always be present (not undefined)
    expect(extCtx.sessionHistory).toEqual([]);
    expect(Array.isArray(extCtx.sessionHistory)).toBe(true);
  });

  it("should hold availableTools as readonly array", () => {
    const tool: ToolDefinition = {
      name: "grep",
      description: "Search file contents",
      parameters: { type: "object", properties: { pattern: { type: "string" } } },
    };

    const extCtx = {
      sessionId: makeSessionId("sess-003"),
      prompt: "search for TODO",
      workingDir: "/src",
      workspacePath: "/src",
      llmProvider: mockLLMProvider(),
      sessionHistory: [],
      availableTools: [tool],
    } satisfies ExtendedAgentContext;

    expect(extCtx.availableTools).toHaveLength(1);
    expect(extCtx.availableTools[0]!.name).toBe("grep");
  });
});

// ─── IntentClassificationResult ───────────────────────────────────

describe("orchestrator/types — IntentClassificationResult", () => {
  it("should create a valid classification result", () => {
    const result = {
      agentType: "code" as AgentType,
      confidence: 0.95,
      reasoning: "User wants to read a file, which maps to the code agent",
    } satisfies IntentClassificationResult;

    expect(result.agentType).toBe("code");
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toContain("file");
  });

  it("should allow all valid agent types", () => {
    const types: AgentType[] = ["code", "os", "docs", "git"];

    for (const t of types) {
      const result: IntentClassificationResult = {
        agentType: t,
        confidence: 0.5,
        reasoning: "test",
      };
      expect(result.agentType).toBe(t);
    }
  });
});

// ─── IntentClassifier (Interface Contract) ────────────────────────

describe("orchestrator/types — IntentClassifier", () => {
  it("should allow implementing IntentClassifier interface", async () => {
    const classifier: IntentClassifier = {
      async classify(prompt: string, _history: readonly ChatMessage[]) {
        if (prompt.includes("file")) {
          return {
            agentType: "code",
            confidence: 0.9,
            reasoning: "File operations → code agent",
          };
        }
        return {
          agentType: "os",
          confidence: 0.7,
          reasoning: "Default to OS agent",
        };
      },
    };

    const result = await classifier.classify("read the file", []);
    expect(result.agentType).toBe("code");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("should pass history to classify method", async () => {
    const classifier: IntentClassifier = {
      async classify(_prompt: string, history: readonly ChatMessage[]) {
        return {
          agentType: "git",
          confidence: history.length > 0 ? 0.8 : 0.5,
          reasoning: "Based on history",
        };
      },
    };

    const history: ChatMessage[] = [
      { role: "user", content: "commit my changes" },
      { role: "assistant", content: "Done" },
    ];

    const result = await classifier.classify("push", history);
    expect(result.confidence).toBe(0.8);
  });
});

// ─── SessionHistoryProvider (Interface Contract) ──────────────────

describe("orchestrator/types — SessionHistoryProvider", () => {
  it("should allow implementing SessionHistoryProvider with in-memory store", async () => {
    const store = new Map<string, ChatMessage[]>();
    store.set("sess-001", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);

    const provider: SessionHistoryProvider = {
      async getHistory(sessionId: SessionId): Promise<readonly ChatMessage[]> {
        return store.get(sessionId) ?? [];
      },
    };

    const history = await provider.getHistory(makeSessionId("sess-001"));
    expect(history).toHaveLength(2);
  });

  it("should return empty array for unknown session", async () => {
    const provider: SessionHistoryProvider = {
      async getHistory(_sessionId: SessionId): Promise<readonly ChatMessage[]> {
        return [];
      },
    };

    const history = await provider.getHistory(makeSessionId("unknown"));
    expect(history).toEqual([]);
  });
});

// ─── ToolDefinition ───────────────────────────────────────────────

describe("orchestrator/types — ToolDefinition", () => {
  it("should define a tool with name, description and parameters", () => {
    const tool = {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    } satisfies ToolDefinition;

    expect(tool.name).toBe("write_file");
    expect(tool.description).toContain("Write");
    expect(tool.parameters.type).toBe("object");
  });
});

// ─── Barrel Export Validation ─────────────────────────────────────

describe("orchestrator/types — barrel exports", () => {
  it("should re-export AgentContext from base types", () => {
    // If this compiles, the barrel export works
    const ctx: AgentContext = {
      sessionId: makeSessionId("s1"),
      prompt: "test",
      workingDir: "/tmp",
    };
    expect(ctx.prompt).toBe("test");
  });

  it("should re-export AgentType from base types", () => {
    const t: AgentType = "code";
    expect(t).toBe("code");
  });

  it("should re-export SessionId branded type", () => {
    const id = makeSessionId("abc");
    const fn = (s: SessionId): string => s;
    expect(fn(id)).toBe("abc");
  });
});
