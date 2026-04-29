import { describe, it, expect } from "bun:test";

// These imports will fail until we implement the types modules
import {
  // JSON-RPC
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONRPCError,
  type JSONRPCNotification,
  // ACP
  type InitializeRequest,
  type InitializeResult,
  type SessionNewRequest,
  type SessionPromptRequest,
  type SessionUpdateNotification,
  type RequestPermissionRequest,
  // LLM
  type LLMProvider,
  type ChatMessage,
  type ChatRole,
  type LLMResponse,
  type LLMChunk,
  type ToolCall,
  type ToolResult,
  type LLMChatOptions,
  // Agent
  type Agent,
  type AgentContext,
  type AgentResult,
  type AgentType,
  // Persistence
  type SessionId,
  type TurnId,
  type MessageId,
  type Session,
  type Turn,
  type MessageRow,
  type SummaryRow,
  // Enums / consts
  AGENT_TYPES,
} from "../../src/types/index.ts";

describe("types/jsonrpc", () => {
  it("should export JSONRPCRequest with correct structure", () => {
    const req = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    } satisfies JSONRPCRequest;
    expect(req.jsonrpc).toBe("2.0");
    expect(req.method).toBe("initialize");
  });

  it("should export JSONRPCResponse with result", () => {
    const res = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { protocolVersion: 1 },
    } satisfies JSONRPCResponse;
    expect(res.jsonrpc).toBe("2.0");
    expect(res.result).toEqual({ protocolVersion: 1 });
  });

  it("should export JSONRPCResponse with error", () => {
    const res = {
      jsonrpc: "2.0" as const,
      id: 1,
      error: { code: -32600, message: "Invalid request" },
    } satisfies JSONRPCResponse;
    expect(res.error?.code).toBe(-32600);
  });

  it("should export JSONRPCError with optional data", () => {
    const err = {
      code: -32602,
      message: "Invalid params",
      data: { field: "missing" },
    } satisfies JSONRPCError;
    expect(err.code).toBe(-32602);
    expect(err.data).toEqual({ field: "missing" });
  });

  it("should export JSONRPCNotification without id", () => {
    const notif = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: { sessionId: "s1" },
    } satisfies JSONRPCNotification;
    expect(notif.method).toBe("session/update");
    expect("id" in notif).toBe(false);
  });
});

describe("types/acp", () => {
  it("should export InitializeRequest", () => {
    const req = {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
    } satisfies InitializeRequest;
    expect(req.protocolVersion).toBe(1);
  });

  it("should export InitializeResult", () => {
    const res = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    } satisfies InitializeResult;
    expect(res.protocolVersion).toBe(1);
  });

  it("should export SessionNewRequest", () => {
    const req = {
      cwd: "/workspace",
      mcpServers: [],
    } satisfies SessionNewRequest;
    expect(req.cwd).toBe("/workspace");
  });

  it("should export SessionPromptRequest", () => {
    const req = {
      sessionId: "sess-1",
      prompt: [{ type: "text" as const, text: "Hello" }],
    } satisfies SessionPromptRequest;
    expect(req.sessionId).toBe("sess-1");
  });

  it("should export SessionUpdateNotification", () => {
    const notif = {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "Hi" },
      },
    } satisfies SessionUpdateNotification;
    expect(notif.sessionId).toBe("sess-1");
  });

  it("should export RequestPermissionRequest", () => {
    const req = {
      sessionId: "sess-1",
      toolCall: {
        toolCallId: "tc1",
      },
      options: [{ optionId: "o1", name: "Allow", kind: "allow_once" as const }],
    } satisfies RequestPermissionRequest;
    expect(req.sessionId).toBe("sess-1");
  });
});

describe("types/llm", () => {
  it("should export ChatRole values", () => {
    const roles: ChatRole[] = ["system", "user", "assistant", "tool"];
    expect(roles).toContain("system");
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
  });

  it("should export ChatMessage with tool support", () => {
    const msg = {
      role: "assistant" as ChatRole,
      content: "Hello",
      tool_calls: [{ id: "tc1", name: "read_file", arguments: "{}" }],
    } satisfies ChatMessage;
    expect(msg.role).toBe("assistant");
    expect(msg.tool_calls?.[0]?.name).toBe("read_file");
  });

  it("should export ToolCall structure", () => {
    const tc = {
      id: "tc1",
      name: "read_file",
      arguments: '{"path": "/tmp"}',
    } satisfies ToolCall;
    expect(tc.name).toBe("read_file");
  });

  it("should export ToolResult structure", () => {
    const tr = {
      id: "tc1",
      content: "file contents",
      status: "completed" as const,
    } satisfies ToolResult;
    expect(tr.id).toBe("tc1");
  });

  it("should export LLMResponse structure", () => {
    const resp = {
      content: "response",
      usage: { promptTokens: 10, completionTokens: 5 },
    } satisfies LLMResponse;
    expect(resp.content).toBe("response");
  });

  it("should export LLMResponse with optional tool_calls", () => {
    const respWithToolCalls = {
      content: "",
      finishReason: "tool_use",
      tool_calls: [
        { id: "tc1", name: "read_file", arguments: '{"path":"/tmp"}' },
        { id: "tc2", name: "search", arguments: '{"query":"test"}' },
      ],
    } satisfies LLMResponse;
    expect(respWithToolCalls.tool_calls).toHaveLength(2);
    expect(respWithToolCalls.tool_calls?.[0]?.name).toBe("read_file");
  });

  it("should export LLMResponse without tool_calls (backward compatible)", () => {
    const respWithoutToolCalls = {
      content: "Just a text response",
      finishReason: "end_turn",
    } satisfies LLMResponse;
    expect(respWithoutToolCalls.tool_calls).toBeUndefined();
  });

  it("should export LLMChunk for streaming", () => {
    const chunk = {
      delta: "chunk",
      finishReason: null,
    } satisfies LLMChunk;
    expect(chunk.delta).toBe("chunk");
  });

  it("should allow implementing LLMProvider interface", async () => {
    const provider: LLMProvider = {
      name: "test",
      async chat(messages, options) {
        return {
          content: "hello",
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
      async *stream(messages, options) {
        yield { delta: "hello", finishReason: null };
      },
    };

    const result = await provider.chat([{ role: "user", content: "hi" }]);
    expect(result.content).toBe("hello");

    const chunks: LLMChunk[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
  });
});

describe("types/agent", () => {
  it("should export AGENT_TYPES with 4 values", () => {
    expect(Object.keys(AGENT_TYPES)).toHaveLength(4);
    expect(AGENT_TYPES.CODE).toBe("code");
    expect(AGENT_TYPES.OS).toBe("os");
    expect(AGENT_TYPES.DOCS).toBe("docs");
    expect(AGENT_TYPES.GIT).toBe("git");
  });

  it("should export AgentType from AGENT_TYPES", () => {
    const types: AgentType[] = ["code", "os", "docs", "git"];
    expect(types).toContain("code");
    expect(types).toContain("os");
    expect(types).toContain("docs");
    expect(types).toContain("git");
  });

  it("should allow implementing Agent interface", async () => {
    const agent: Agent = {
      name: "test-agent",
      type: "code",
      systemPrompt: "You are a test agent",
      async execute(context) {
        return {
          success: true as const,
          output: "done",
          toolCalls: [],
        };
      },
    };

    expect(agent.name).toBe("test-agent");
    expect(agent.type).toBe("code");

    const result = await agent.execute({
      sessionId: "s1" as SessionId,
      prompt: "hello",
      workingDir: "/tmp",
    });
    expect(result.success).toBe(true);
  });

  it("should export AgentContext with required fields", () => {
    const ctx = {
      sessionId: "s1" as SessionId,
      prompt: "hello",
      workingDir: "/tmp",
    } satisfies AgentContext;
    expect(ctx.sessionId).toBe("s1");
  });

  it("should export AgentResult with optional fields", () => {
    const result = {
      success: true as const,
      output: "done",
    } satisfies AgentResult;
    expect(result.success).toBe(true);
  });

  it("should enforce AgentResult success case", () => {
    const result = {
      success: true as const,
      output: "done",
      toolCalls: [],
    } satisfies AgentResult;
    expect(result.success).toBe(true);
  });

  it("should enforce AgentResult error case", () => {
    const result = {
      success: false as const,
      output: "",
      error: "Something went wrong",
    } satisfies AgentResult;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Something went wrong");
  });

  it("should prevent assigning SessionId to TurnId at compile time", () => {
    const sessionId = "s1" as SessionId;
    // @ts-expect-error - SessionId should not be assignable to TurnId
    const turnId: TurnId = sessionId;
    // Runtime still works (branded types are strings), but compile should fail
    expect(turnId).toBe("s1");
  });

  it("should allow AgentContext with typed sessionHistory", () => {
    const ctx = {
      sessionId: "s1" as SessionId,
      prompt: "hello",
      workingDir: "/tmp",
      sessionHistory: [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "hello" },
      ],
    } satisfies AgentContext;
    expect(ctx.sessionHistory).toHaveLength(2);
  });

  it("should allow MessageRow with serialized tool calls", () => {
    const msg = {
      id: "m1" as MessageId,
      turnId: "t1" as TurnId,
      role: "assistant" as const,
      content: "Using tool",
      toolCallsJson: '[{"id":"tc1","name":"read","arguments":"{}"}]',
    } satisfies MessageRow;
    expect(msg.toolCallsJson).toContain("tc1");
  });

  it("should export LLMChatOptions with tools", () => {
    const opts = {
      model: "claude-3",
      temperature: 0.7,
      maxTokens: 4096,
      tools: [{ name: "read", description: "Read file", parameters: { type: "object" } }],
    } satisfies LLMChatOptions;
    expect(opts.tools).toHaveLength(1);
  });
});

describe("types/persistence", () => {
  it("should export Session branded type", () => {
    const session = {
      id: "s1" as SessionId,
      createdAt: Date.now(),
      metadata: JSON.stringify({}),
    } satisfies Session;
    expect(session.id).toBe("s1");
  });

  it("should export Turn branded type", () => {
    const turn = {
      id: "t1" as TurnId,
      sessionId: "s1" as SessionId,
      prompt: "hello",
      status: "completed" as const,
    } satisfies Turn;
    expect(turn.sessionId).toBe("s1");
  });

  it("should export MessageRow", () => {
    const msg = {
      id: "m1" as MessageId,
      turnId: "t1" as TurnId,
      role: "user" as const,
      content: "hello",
      toolCallsJson: null,
    } satisfies MessageRow;
    expect(msg.role).toBe("user");
  });

  it("should export SummaryRow", () => {
    const summary = {
      id: 1,
      sessionId: "s1" as SessionId,
      messageFrom: 0,
      messageTo: 10,
      content: "summary",
      createdAt: Date.now(),
    } satisfies SummaryRow;
    expect(summary.messageFrom).toBe(0);
  });

  it("should enforce branded types at compile time", () => {
    function takesSessionId(id: SessionId): string {
      return id;
    }
    function takesTurnId(id: TurnId): string {
      return id;
    }

    const sessionId = "s1" as SessionId;
    const turnId = "t1" as TurnId;

    expect(takesSessionId(sessionId)).toBe("s1");
    expect(takesTurnId(turnId)).toBe("t1");

    // These should compile because branded types are structurally strings at runtime
    expect(takesSessionId("s1" as SessionId)).toBe("s1");
  });
});
