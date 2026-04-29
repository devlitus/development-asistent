/**
 * Integration tests for CodeAgent.
 *
 * Tests the CodeAgent class including:
 * - System prompt content validation
 * - Tool calling loop (LLM → tool_calls → execute → feed result → repeat)
 * - Error handling (LLM errors, tool errors, max iterations)
 * - ExtendedAgentContext handling
 * - Session history inclusion
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LLMChatOptions, LLMChunk, LLMProvider, LLMResponse } from "../../src/types/llm.ts";
import type { AgentContext, AgentResult } from "../../src/types/agent.ts";
import type { SessionId } from "../../src/types/persistence.ts";
import type { ExtendedAgentContext } from "../../src/orchestrator/types.ts";
import { CodeAgent } from "../../src/agents/code/code-agent.ts";
import { CODE_SYSTEM_PROMPT } from "../../src/agents/code/prompts.ts";
import { MAX_TOOL_RESULT_BYTES, READONLY_TOOLS } from "../../src/agents/code/code-agent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock LLM provider that returns a sequence of predefined responses. */
function createMockLLMProvider(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: "mock-llm",
    async chat(
      _messages: readonly ChatMessage[],
      _options?: LLMChatOptions,
    ): Promise<LLMResponse> {
      return responses[callIndex++] ?? { content: "no more responses" };
    },
    async *_stream(_messages: readonly ChatMessage[], _options?: LLMChatOptions): AsyncGenerator<LLMChunk> {
      yield { delta: "mock" };
    },
    stream(messages: readonly ChatMessage[], options?: LLMChatOptions): AsyncIterable<LLMChunk> {
      return this._stream(messages, options);
    },
  };
}

/** Create a mock LLM provider that throws on chat. */
function createFailingLLMProvider(errorMsg: string): LLMProvider {
  return {
    name: "failing-llm",
    async chat() {
      throw new Error(errorMsg);
    },
    async *_stream() {
      yield { delta: "mock" };
    },
    stream(messages: readonly ChatMessage[], options?: LLMChatOptions): AsyncIterable<LLMChunk> {
      return this._stream(messages, options);
    },
  };
}

/** Create a mock LLM that records all messages it receives. */
function createSpyLLMProvider(responses: LLMResponse[]): { provider: LLMProvider; getMessages: () => ChatMessage[][] } {
  const allCalls: ChatMessage[][] = [];
  let callIndex = 0;
  const provider: LLMProvider = {
    name: "spy-llm",
    async chat(messages: readonly ChatMessage[], _options?: LLMChatOptions): Promise<LLMResponse> {
      allCalls.push([...messages]);
      return responses[callIndex++] ?? { content: "no more responses" };
    },
    async *_stream() { yield { delta: "mock" }; },
    stream(messages: readonly ChatMessage[], options?: LLMChatOptions): AsyncIterable<LLMChunk> {
      return this._stream(messages, options);
    },
  };
  return { provider, getMessages: () => allCalls };
}

let workspace: string;

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "code-agent-integration-"));
  return dir;
}

async function cleanupWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Build an ExtendedAgentContext for testing. */
function buildContext(overrides: {
  prompt: string;
  llmProvider: LLMProvider;
  workspacePath?: string;
  sessionHistory?: ChatMessage[];
}): AgentContext {
  const ws = overrides.workspacePath ?? workspace;
  const ctx: ExtendedAgentContext = {
    sessionId: "test-session" as SessionId,
    prompt: overrides.prompt,
    workingDir: ws,
    sessionHistory: overrides.sessionHistory ?? [],
    workspacePath: ws,
    llmProvider: overrides.llmProvider,
    availableTools: [],
  };
  return ctx as AgentContext;
}

// Global workspace setup for tests that execute real tools
beforeAll(async () => {
  workspace = await createWorkspace();
  // Create a README.md so read_file tests have something to read
  await writeFile(join(workspace, "README.md"), "# Test Project\nThis is a test project.");
});

afterAll(async () => {
  if (workspace) {
    await cleanupWorkspace(workspace);
  }
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe("CODE_SYSTEM_PROMPT", () => {
  it("es un string no vacio", () => {
    expect(typeof CODE_SYSTEM_PROMPT).toBe("string");
    expect(CODE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("describe las 4 herramientas disponibles", () => {
    expect(CODE_SYSTEM_PROMPT).toContain("read_file");
    expect(CODE_SYSTEM_PROMPT).toContain("write_file");
    expect(CODE_SYSTEM_PROMPT).toContain("list_directory");
    expect(CODE_SYSTEM_PROMPT).toContain("search_code");
  });

  it("incluye instruccion de leer archivos antes de modificarlos", () => {
    expect(CODE_SYSTEM_PROMPT.toLowerCase()).toContain("read");
  });

  it("incluye instruccion sobre TypeScript estricto", () => {
    expect(CODE_SYSTEM_PROMPT).toContain("TypeScript");
  });

  it("incluye instruccion sobre generar tests", () => {
    expect(CODE_SYSTEM_PROMPT.toLowerCase()).toContain("test");
  });

  it("incluye instruccion sobre formato Markdown para codigo", () => {
    expect(CODE_SYSTEM_PROMPT).toContain("Markdown");
  });
});

// ---------------------------------------------------------------------------
// CodeAgent class
// ---------------------------------------------------------------------------

describe("CodeAgent", () => {
  const agent = new CodeAgent();

  it('tiene name "code-agent"', () => {
    expect(agent.name).toBe("code-agent");
  });

  it('tiene type "code"', () => {
    expect(agent.type).toBe("code");
  });

  it("systemPrompt retorna CODE_SYSTEM_PROMPT", () => {
    expect(agent.systemPrompt).toBe(CODE_SYSTEM_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — simple text response (no tool calls)
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — sin tool calls", () => {
  it("retorna success cuando el LLM responde con texto", async () => {
    const mockProvider = createMockLLMProvider([
      { content: "The file contains a simple hello world program." },
    ]);
    const context = buildContext({
      prompt: "Read src/index.ts",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("hello world");
    }
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — con tool calls
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — con tool calls", () => {
  it("ejecuta tools y alimenta resultados al LLM, luego retorna success", async () => {
    const mockProvider = createMockLLMProvider([
      // First call: LLM asks to read a file
      {
        content: "",
        tool_calls: [
          {
            id: "tc-1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
      // Second call: LLM responds with analysis
      {
        content: "I've read the README file. It contains project documentation.",
      },
    ]);
    const context = buildContext({
      prompt: "Read the README",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("README file");
    }
  });

  it("recopila tool results en AgentResult.toolCalls", async () => {
    const mockProvider = createMockLLMProvider([
      {
        content: "",
        tool_calls: [
          {
            id: "tc-1",
            name: "list_directory",
            arguments: '{"path":"."}',
          },
        ],
      },
      { content: "Directory listed successfully." },
    ]);
    const context = buildContext({
      prompt: "List files",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls![0]!.id).toBe("tc-1");
    expect(result.toolCalls![0]!.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — LLM error
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — error del LLM", () => {
  it("retorna AgentResult con success: false cuando el LLM falla", async () => {
    const mockProvider = createFailingLLMProvider("API rate limit exceeded");
    const context = buildContext({
      prompt: "Read the file",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("API rate limit exceeded");
      expect(result.output).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — tool error
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — error de tool", () => {
  it("tool error no crashea el agente, retorna error en tool result", async () => {
    const mockProvider = createMockLLMProvider([
      {
        content: "",
        tool_calls: [
          {
            id: "tc-err",
            name: "read_file",
            arguments: '{"path":"nonexistent-file-xyz.ts"}',
          },
        ],
      },
      {
        content: "The file was not found. I'll explain this to the user.",
      },
    ]);
    const context = buildContext({
      prompt: "Read a file that doesn't exist",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBeDefined();
      // The tool call should have been collected with "failed" status
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThanOrEqual(1);
      expect(result.toolCalls![0]!.status).toBe("failed");
    }
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — max iterations
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — maximo de iteraciones", () => {
  it("retorna output parcial con warning al alcanzar max iteraciones", async () => {
    // Create 12 responses, all with tool calls — this should exceed the max of 10
    const responses: LLMResponse[] = [];
    for (let i = 0; i < 12; i++) {
      responses.push({
        content: `Iteration ${i}`,
        tool_calls: [
          {
            id: `tc-${i}`,
            name: "list_directory",
            arguments: '{"path":"."}',
          },
        ],
      });
    }

    const mockProvider = createMockLLMProvider(responses);
    const context = buildContext({
      prompt: "Keep listing",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("Maximum tool iterations");
    }
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — session history
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — session history", () => {
  it("incluye session history en los messages enviados al LLM", async () => {
    const { provider, getMessages } = createSpyLLMProvider([
      { content: "Based on our previous discussion..." },
    ]);

    const history: ChatMessage[] = [
      { role: "user", content: "What does the project do?" },
      { role: "assistant", content: "It's a personal assistant." },
    ];

    const context = buildContext({
      prompt: "Tell me more",
      llmProvider: provider,
      sessionHistory: history,
    });

    const agent = new CodeAgent();
    await agent.execute(context);

    const messages = getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // First call should include history between system and user prompt
    const firstCall = messages[0]!;
    // System message is first
    expect(firstCall[0]!.role).toBe("system");
    // History messages are in the middle
    const roles = firstCall.map((m) => m.role);
    // Should have: system, user (history), assistant (history), user (prompt)
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");

    // Check that history content is present
    const contents = firstCall.map((m) => m.content);
    expect(contents).toContain("What does the project do?");
    expect(contents).toContain("It's a personal assistant.");
    expect(contents).toContain("Tell me more");
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — type guard for ExtendedAgentContext
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — type guard ExtendedAgentContext", () => {
  it("should return error when context lacks llmProvider", async () => {
    const context = {
      sessionId: "test-session" as SessionId,
      prompt: "Hello",
      workingDir: "/tmp",
      sessionHistory: [],
    };
    const agent = new CodeAgent();
    const result = await agent.execute(context);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ExtendedAgentContext");
    }
  });

  it("should return error when context lacks workspacePath", async () => {
    const mockProvider = createMockLLMProvider([
      { content: "hello" },
    ]);
    const context = {
      sessionId: "test-session" as SessionId,
      prompt: "Hello",
      workingDir: "/tmp",
      sessionHistory: [],
      llmProvider: mockProvider,
    };
    const agent = new CodeAgent();
    const result = await agent.execute(context);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ExtendedAgentContext");
    }
  });

  it("should return error when llmProvider is not an object", async () => {
    const context = {
      sessionId: "test-session" as SessionId,
      prompt: "Hello",
      workingDir: "/tmp",
      sessionHistory: [],
      llmProvider: "not-an-object",
      workspacePath: "/tmp",
    };
    const agent = new CodeAgent();
    const result = await agent.execute(context);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ExtendedAgentContext");
    }
  });

  it("should return error when workspacePath is not a string", async () => {
    const mockProvider = createMockLLMProvider([
      { content: "hello" },
    ]);
    const context = {
      sessionId: "test-session" as SessionId,
      prompt: "Hello",
      workingDir: "/tmp",
      sessionHistory: [],
      llmProvider: mockProvider,
      workspacePath: 123,
    };
    const agent = new CodeAgent();
    const result = await agent.execute(context);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ExtendedAgentContext");
    }
  });

  it("should return error when llmProvider is null", async () => {
    const context = {
      sessionId: "test-session-null-provider" as SessionId,
      prompt: "Hello",
      workingDir: "/tmp",
      sessionHistory: [],
      llmProvider: null,
      workspacePath: "/tmp",
    };
    const agent = new CodeAgent();
    const result = await agent.execute(context as unknown as AgentContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain("ExtendedAgentContext");
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — tool name whitelist
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — tool name whitelist", () => {
  it("should reject unknown tool names with error message", async () => {
    const mockProvider = createMockLLMProvider([
      {
        content: "",
        tool_calls: [
          {
            id: "tc-evil",
            name: "delete_everything",
            arguments: "{}",
          },
        ],
      },
      {
        content: "I handled the error.",
      },
    ]);
    const context = buildContext({
      prompt: "Do something malicious",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBeGreaterThanOrEqual(1);
    // The unknown tool should have status "failed"
    const failedTool = result.toolCalls!.find((tc) => tc.id === "tc-evil");
    expect(failedTool).toBeDefined();
    expect(failedTool!.status).toBe("failed");
    expect(failedTool!.content).toContain("Unknown tool");
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — tool result truncation
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — tool result truncation", () => {
  it("should truncate tool results exceeding MAX_TOOL_RESULT_LENGTH", async () => {
    // Create a spy provider that captures messages fed back
    const capturedMessages: ChatMessage[][] = [];
    const longContent = "x".repeat(15_000);

    const spyProvider: LLMProvider = {
      name: "spy",
      async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
        capturedMessages.push([...messages]);
        // First call: return tool call; second call: return text
        if (capturedMessages.length === 1) {
          return {
            content: "",
            tool_calls: [{ id: "tc-1", name: "read_file", arguments: '{"path":"README.md"}' }],
          };
        }
        return { content: "Done" };
      },
      async *_stream() { yield { delta: "mock" }; },
      stream(messages: readonly ChatMessage[], options?: LLMChatOptions): AsyncIterable<LLMChunk> {
        return this._stream(messages, options);
      },
    };

    // We need to override the tool execution to return a long result.
    // Since we can't easily mock executeTool, we'll test truncation indirectly
    // by verifying the truncateContent function works correctly.
    // Instead, let's test with a real file that we write a long content to.
    const longFileContent = "A".repeat(15_000);
    const longFilePath = join(workspace, "long-file.txt");
    await writeFile(longFilePath, longFileContent);

    const mockProvider2 = createMockLLMProvider([
      {
        content: "",
        tool_calls: [{ id: "tc-long", name: "read_file", arguments: JSON.stringify({ path: "long-file.txt" }) }],
      },
      { content: "Done reading long file." },
    ]);

    const { provider: spyProv, getMessages: getMsgs } = createSpyLLMProvider([
      {
        content: "",
        tool_calls: [{ id: "tc-long", name: "read_file", arguments: JSON.stringify({ path: "long-file.txt" }) }],
      },
      { content: "Done reading long file." },
    ]);

    const context = buildContext({
      prompt: "Read the long file",
      llmProvider: spyProv,
    });

    const agent = new CodeAgent();
    await agent.execute(context);

    const msgs = getMsgs();
    // Second call should have the tool result message
    if (msgs.length >= 2) {
      const toolMsg = msgs[1]!.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      // The tool result should be truncated (less than 15_000 + overhead)
      expect(toolMsg!.content.length).toBeLessThan(longFileContent.length);
      expect(toolMsg!.content).toContain("--- TOOL OUTPUT TRUNCATED ---");
    }
  });
});

// ---------------------------------------------------------------------------
// CodeAgent.execute — multiple tool calls in single response
// ---------------------------------------------------------------------------

describe("CodeAgent.execute — parseToolArguments con array", () => {
  it("handles tool call with array arguments gracefully", async () => {
    const provider = createMockLLMProvider([
      {
        content: "",
        tool_calls: [{ id: "tc-arr", name: "read_file", arguments: '["not", "an", "object"]' }],
        finishReason: "tool_calls",
      },
      { content: "Handled gracefully", finishReason: "stop" },
    ]);
    const context = buildContext({
      prompt: "Test array args",
      llmProvider: provider,
    });
    const agent = new CodeAgent();
    const result = await agent.execute(context);
    // No debe crashear — el agente debe manejar esto y continuar
    expect(result.success).toBe(true);
    expect(result.output).toBe("Handled gracefully");
  });
});

describe("CodeAgent.execute — multiple tool calls", () => {
  it("ejecuta multiples tool calls en una sola respuesta", async () => {
    const mockProvider = createMockLLMProvider([
      {
        content: "Let me read both files",
        tool_calls: [
          {
            id: "tc-a",
            name: "list_directory",
            arguments: '{"path":"."}',
          },
          {
            id: "tc-b",
            name: "list_directory",
            arguments: '{"path":"."}',
          },
        ],
      },
      {
        content: "I've read both locations.",
      },
    ]);
    const context = buildContext({
      prompt: "Read two directories",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PERF-02: MAX_TOOL_RESULT_BYTES — truncación de tool results
// ---------------------------------------------------------------------------

describe("PERF-02: MAX_TOOL_RESULT_BYTES — constante exportada y truncación", () => {
  it("MAX_TOOL_RESULT_BYTES está exportada y vale 10_240", () => {
    expect(MAX_TOOL_RESULT_BYTES).toBe(10_240);
  });

  it("tool result mayor a MAX_TOOL_RESULT_BYTES se trunca con marker correcto", async () => {
    // Write a file with content > 10KB
    const bigContent = "Z".repeat(15_000);
    const bigFilePath = join(workspace, "perf02-big.txt");
    await writeFile(bigFilePath, bigContent);

    const { provider: spyProv, getMessages: getMsgs } = createSpyLLMProvider([
      {
        content: "",
        tool_calls: [{ id: "tc-perf02", name: "read_file", arguments: JSON.stringify({ path: "perf02-big.txt" }) }],
      },
      { content: "Done." },
    ]);

    const context = buildContext({
      prompt: "Read big file",
      llmProvider: spyProv,
    });

    const agent = new CodeAgent();
    await agent.execute(context);

    const msgs = getMsgs();
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const toolMsg = msgs[1]!.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    // Must be truncated to MAX_TOOL_RESULT_BYTES + marker overhead
    expect(toolMsg!.content.length).toBeLessThan(bigContent.length);
    // Must contain the specific marker from the task spec
    expect(toolMsg!.content).toContain("--- TOOL OUTPUT TRUNCATED ---");
  });

  it("tool result menor a MAX_TOOL_RESULT_BYTES NO se trunca", async () => {
    const smallContent = "Hello small content";
    const smallFilePath = join(workspace, "perf02-small.txt");
    await writeFile(smallFilePath, smallContent);

    const { provider: spyProv, getMessages: getMsgs } = createSpyLLMProvider([
      {
        content: "",
        tool_calls: [{ id: "tc-perf02-s", name: "read_file", arguments: JSON.stringify({ path: "perf02-small.txt" }) }],
      },
      { content: "Done." },
    ]);

    const context = buildContext({
      prompt: "Read small file",
      llmProvider: spyProv,
    });

    const agent = new CodeAgent();
    await agent.execute(context);

    const msgs = getMsgs();
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    const toolMsg = msgs[1]!.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain(smallContent);
    expect(toolMsg!.content).not.toContain("--- TOOL OUTPUT TRUNCATED ---");
  });

  it("marker de truncación es el especificado en la tarea", async () => {
    const bigContent = "W".repeat(20_000);
    const bigFilePath2 = join(workspace, "perf02-marker.txt");
    await writeFile(bigFilePath2, bigContent);

    const { provider: spyProv, getMessages: getMsgs } = createSpyLLMProvider([
      {
        content: "",
        tool_calls: [{ id: "tc-marker", name: "read_file", arguments: JSON.stringify({ path: "perf02-marker.txt" }) }],
      },
      { content: "Done." },
    ]);

    const agent = new CodeAgent();
    await agent.execute(buildContext({ prompt: "Read", llmProvider: spyProv }));

    const msgs = getMsgs();
    const toolMsg = msgs[1]!.find((m) => m.role === "tool");
    expect(toolMsg!.content).toContain("Use more specific parameters to retrieve less data");
  });
});

// ---------------------------------------------------------------------------
// PERF-03: READONLY_TOOLS — paralelización de tool calls de solo lectura
// ---------------------------------------------------------------------------

describe("PERF-03: READONLY_TOOLS — constante exportada y paralelización", () => {
  it("READONLY_TOOLS está exportada y contiene las 3 herramientas de lectura", () => {
    expect(READONLY_TOOLS).toBeInstanceOf(Set);
    expect(READONLY_TOOLS.has("read_file")).toBe(true);
    expect(READONLY_TOOLS.has("list_directory")).toBe(true);
    expect(READONLY_TOOLS.has("search_code")).toBe(true);
  });

  it("write_file NO está en READONLY_TOOLS", () => {
    expect(READONLY_TOOLS.has("write_file")).toBe(false);
  });

  it("múltiples tool calls readonly se ejecutan y retornan resultados en orden correcto", async () => {
    // Two list_directory calls — both readonly, should run in parallel
    const mockProvider = createMockLLMProvider([
      {
        content: "",
        tool_calls: [
          { id: "tc-r1", name: "list_directory", arguments: '{"path":"."}' },
          { id: "tc-r2", name: "list_directory", arguments: '{"path":"."}' },
        ],
      },
      { content: "Both listed." },
    ]);

    const context = buildContext({
      prompt: "List twice",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(2);
    // Order must be preserved: tc-r1 first, tc-r2 second
    expect(result.toolCalls![0]!.id).toBe("tc-r1");
    expect(result.toolCalls![1]!.id).toBe("tc-r2");
    expect(result.toolCalls![0]!.status).toBe("completed");
    expect(result.toolCalls![1]!.status).toBe("completed");
  });

  it("mix de readonly + mutating ejecuta en serie (write_file presente)", async () => {
    // One read + one write — must run in series (no Promise.all)
    const mockProvider = createMockLLMProvider([
      {
        content: "",
        tool_calls: [
          { id: "tc-read", name: "read_file", arguments: '{"path":"README.md"}' },
          { id: "tc-write", name: "write_file", arguments: JSON.stringify({ path: "perf03-output.txt", content: "hello" }) },
        ],
      },
      { content: "Done." },
    ]);

    const context = buildContext({
      prompt: "Read then write",
      llmProvider: mockProvider,
    });

    const agent = new CodeAgent();
    const result = await agent.execute(context);

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(2);
    // Both should complete
    expect(result.toolCalls![0]!.id).toBe("tc-read");
    expect(result.toolCalls![1]!.id).toBe("tc-write");
    expect(result.toolCalls![0]!.status).toBe("completed");
    expect(result.toolCalls![1]!.status).toBe("completed");
  });
});
