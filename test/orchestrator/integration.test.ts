/**
 * Integration tests for the full Orchestrator pipeline.
 *
 * Validates the end-to-end flow:
 *   AcpServer → Orchestrator → IntentClassifier → Agent mock → AgentEvent → session/update
 *
 * These tests verify that components compose correctly,
 * complementing the unit tests in orchestrator.test.ts and acp-server.test.ts.
 */

import { describe, it, expect, mock } from "bun:test";
import { StdioTransport } from "../../src/transport/stdio.ts";
import { AcpServer } from "../../src/protocol/acp-server.ts";
import { SessionStore } from "../../src/protocol/session-store.ts";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import {
  KeywordIntentClassifier,
  CompositeIntentClassifier,
  LLMIntentClassifier,
} from "../../src/orchestrator/intent-classifier.ts";
import { InMemoryHistoryProvider } from "../../src/orchestrator/history-provider.ts";
import type { Agent, AgentResult, AgentContext } from "../../src/types/agent.ts";
import type { AgentType } from "../../src/orchestrator/types.ts";
import type { LLMProvider, ChatMessage, LLMResponse } from "../../src/types/llm.ts";

// ---------------------------------------------------------------------------
// Helpers: streams, output, JSON-RPC
// ---------------------------------------------------------------------------

/** Create a ReadableStream<Uint8Array> that emits `data` and closes. */
function createInputStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

/** Create a mock output that captures written strings. */
function createMockOutput() {
  const chunks: string[] = [];
  return {
    write(data: string) {
      chunks.push(data);
    },
    get chunks() {
      return chunks;
    },
    /** Parse all written chunks as JSON objects. */
    get messages() {
      return chunks.map((c) => JSON.parse(c.trim()));
    },
  };
}

/** Build a JSON-RPC request string. */
function jsonrpc(id: number | string, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined && { params }),
  });
}

// ---------------------------------------------------------------------------
// Helpers: mock factories
// ---------------------------------------------------------------------------

/** Create a mock Agent with a configurable result. */
function createMockAgent(type: AgentType, result: AgentResult): Agent {
  return {
    name: `mock-${type}`,
    type,
    systemPrompt: `Mock ${type} agent`,
    execute: mock((_context: AgentContext) => Promise.resolve(result)),
  };
}

/** Create a mock Agent that throws on execute. */
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

/** Create a mock LLM provider that returns a fixed response. */
function createMockLLMProvider(responseText: string): LLMProvider {
  return {
    name: "mock-llm",
    chat: mock((_messages: readonly ChatMessage[]) =>
      Promise.resolve({
        content: responseText,
        finishReason: "end_turn",
      } as LLMResponse),
    ),
    stream: mock(async function* () {
      yield { delta: responseText, finishReason: "end_turn" };
    }),
  };
}

/** Create a mock LLM provider that routes based on prompt content. */
function createRoutingLLMProvider(): LLMProvider {
  return {
    name: "routing-llm",
    chat: mock((messages: readonly ChatMessage[]) => {
      const lastMsg = messages[messages.length - 1];
      const text = lastMsg?.content?.toLowerCase() ?? "";
      // Simple keyword-based routing simulation
      if (text.includes("git") || text.includes("commit")) {
        return Promise.resolve({ content: "git", finishReason: "end_turn" } as LLMResponse);
      }
      if (text.includes("run") || text.includes("test") || text.includes("bun")) {
        return Promise.resolve({ content: "os", finishReason: "end_turn" } as LLMResponse);
      }
      if (text.includes("doc") || text.includes("search web")) {
        return Promise.resolve({ content: "docs", finishReason: "end_turn" } as LLMResponse);
      }
      return Promise.resolve({ content: "code", finishReason: "end_turn" } as LLMResponse);
    }),
    stream: mock(async function* () {
      yield { delta: "code", finishReason: "end_turn" };
    }),
  };
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

/** Run a full integration test: initialize → session/new → session/prompt. */
async function runIntegrationTest(config: {
  agents: Array<{ type: AgentType; result: AgentResult }>;
  prompt: string;
  useLLMClassifier?: boolean;
  cwd?: string;
}): Promise<{
  messages: unknown[];
  sessions: SessionStore;
  orchestrator: Orchestrator;
  agents: Agent[];
}> {
  const sessions = new SessionStore();
  const session = sessions.create(config.cwd ?? "/test/workspace");

  const historyProvider = new InMemoryHistoryProvider();
  const llmProvider = createRoutingLLMProvider();

  let orchestrator: Orchestrator;
  if (config.useLLMClassifier) {
    // Composite: LLM first, keyword fallback
    const llmClassifier = new LLMIntentClassifier(llmProvider);
    const keywordClassifier = new KeywordIntentClassifier();
    const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);
    orchestrator = new Orchestrator({
      intentClassifier: composite,
      historyProvider,
      llmProvider,
    });
  } else {
    orchestrator = new Orchestrator({
      intentClassifier: new KeywordIntentClassifier(),
      historyProvider,
      llmProvider,
    });
  }

  const agents: Agent[] = [];
  for (const agentConfig of config.agents) {
    const agent = createMockAgent(agentConfig.type, agentConfig.result);
    orchestrator.registerAgent(agent);
    agents.push(agent);
  }

  const requests = [
    jsonrpc(1, "initialize", { protocolVersion: 1 }),
    jsonrpc(2, "session/new", { cwd: config.cwd ?? "/test/workspace", mcpServers: [] }),
    jsonrpc(3, "session/prompt", {
      sessionId: session.id,
      prompt: [{ type: "text", text: config.prompt }],
    }),
  ].join("\n") + "\n";

  const input = createInputStream(requests);
  const output = createMockOutput();
  const transport = new StdioTransport({ input, output });
  const server = new AcpServer(transport, sessions, undefined, orchestrator);

  await server.start();

  return { messages: output.messages, sessions, orchestrator, agents };
}

/** Run a single session/prompt against an existing setup. */
async function runPromptOnly(config: {
  agents: Array<{ type: AgentType; result: AgentResult }>;
  prompt: string;
  cwd?: string;
  classifier?: "keyword" | "composite";
}): Promise<unknown[]> {
  const sessions = new SessionStore();
  const session = sessions.create(config.cwd ?? "/test/workspace");

  const historyProvider = new InMemoryHistoryProvider();
  const llmProvider = createRoutingLLMProvider();

  let orchestrator: Orchestrator;
  if (config.classifier === "composite") {
    const llmClassifier = new LLMIntentClassifier(llmProvider);
    const keywordClassifier = new KeywordIntentClassifier();
    const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);
    orchestrator = new Orchestrator({
      intentClassifier: composite,
      historyProvider,
      llmProvider,
    });
  } else {
    orchestrator = new Orchestrator({
      intentClassifier: new KeywordIntentClassifier(),
      historyProvider,
      llmProvider,
    });
  }

  for (const agentConfig of config.agents) {
    orchestrator.registerAgent(createMockAgent(agentConfig.type, agentConfig.result));
  }

  const input = createInputStream(
    jsonrpc(1, "session/prompt", {
      sessionId: session.id,
      prompt: [{ type: "text", text: config.prompt }],
    }) + "\n",
  );
  const output = createMockOutput();
  const transport = new StdioTransport({ input, output });
  const server = new AcpServer(transport, sessions, undefined, orchestrator);

  await server.start();
  return output.messages;
}

// ═══════════════════════════════════════════════════════════════════════
// Integration Tests
// ═══════════════════════════════════════════════════════════════════════

describe("Orchestrator Integration", () => {
  // ========================================================================
  // Full flow with code agent
  // ========================================================================

  describe("full flow with code agent", () => {
    it("should route 'read file main.ts' to code agent via full initialize → prompt flow", async () => {
      const result = await runIntegrationTest({
        agents: [{ type: "code", result: { success: true, output: "File contents of main.ts" } }],
        prompt: "read file main.ts",
      });

      // Expect: initialize response, session/new response, session/update, session/prompt response
      expect(result.messages.length).toBeGreaterThanOrEqual(4);

      // 1. Initialize response
      const initResp = result.messages[0]!;
      expect(initResp.id).toBe(1);
      expect(initResp.result.protocolVersion).toBe(1);

      // 2. session/new response
      const newResp = result.messages[1]!;
      expect(newResp.id).toBe(2);
      expect(newResp.result.sessionId).toBeDefined();

      // 3. session/update notification(s) — at least the agent output
      const updates = result.messages.filter(
        (m: any) => m.method === "session/update",
      );
      expect(updates.length).toBeGreaterThanOrEqual(1);

      // The agent output should appear in a session/update
      const agentOutput = updates.find(
        (m: any) => m.params?.update?.content?.text === "File contents of main.ts",
      );
      expect(agentOutput).toBeDefined();

      // 4. session/prompt response — last message
      const promptResp = result.messages[result.messages.length - 1]!;
      expect(promptResp.id).toBe(3);
      expect(promptResp.result.stopReason).toBe("end_turn");
    });

    it("should send session/update with agent response content", async () => {
      const messages = await runPromptOnly({
        agents: [{ type: "code", result: { success: true, output: "Code analysis complete" } }],
        prompt: "analyze the code",
      });

      // Find the notification with the agent's output
      const agentNotif = messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "Code analysis complete",
      );
      expect(agentNotif).toBeDefined();
      expect(agentNotif!.params.update.sessionUpdate).toBe("agent_message_chunk");
      expect(agentNotif!.params.update.content.type).toBe("text");
    });

    it("should return end_turn stopReason for successful agent execution", async () => {
      const messages = await runPromptOnly({
        agents: [{ type: "code", result: { success: true, output: "done" } }],
        prompt: "edit file",
      });

      const lastMsg = messages[messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("end_turn");
    });
  });

  // ========================================================================
  // Full flow with os agent
  // ========================================================================

  describe("full flow with os agent", () => {
    it("should route 'run bun test' to os agent", async () => {
      const agents = [
        { type: "code", result: { success: true, output: "code fallback" } },
        { type: "os", result: { success: true, output: "Tests passed: 42/42" } },
      ];

      const messages = await runPromptOnly({
        agents,
        prompt: "run bun test",
      });

      // Verify the os agent output appears in notifications
      const agentNotif = messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "Tests passed: 42/42",
      );
      expect(agentNotif).toBeDefined();

      // Verify end_turn
      const lastMsg = messages[messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("end_turn");
    });

    it("should send session/update with command output from os agent", async () => {
      const messages = await runPromptOnly({
        agents: [{ type: "os", result: { success: true, output: "Build succeeded" } }],
        prompt: "run bun build",
      });

      const notif = messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "Build succeeded",
      );
      expect(notif).toBeDefined();
    });
  });

  // ========================================================================
  // Multi-agent routing
  // ========================================================================

  describe("multi-agent routing", () => {
    it("should route to different agents based on prompt content", async () => {
      const codeAgent = createMockAgent("code", { success: true, output: "code response" });
      const gitAgent = createMockAgent("git", { success: true, output: "git response" });

      // Test code routing
      const codeMessages = await runPromptOnly({
        agents: [
          { type: "code", result: { success: true, output: "code response" } },
          { type: "git", result: { success: true, output: "git response" } },
        ],
        prompt: "edit the file",
      });

      const codeNotif = codeMessages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "code response",
      );
      expect(codeNotif).toBeDefined();

      // Test git routing
      const gitMessages = await runPromptOnly({
        agents: [
          { type: "code", result: { success: true, output: "code response" } },
          { type: "git", result: { success: true, output: "git response" } },
        ],
        prompt: "git commit my changes",
      });

      const gitNotif = gitMessages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "git response",
      );
      expect(gitNotif).toBeDefined();
    });

    it("should handle sequential prompts to different agents in same session", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/test/workspace");

      const historyProvider = new InMemoryHistoryProvider();
      const llmProvider = createMockLLMProvider("code");

      const orchestrator = new Orchestrator({
        intentClassifier: new KeywordIntentClassifier(),
        historyProvider,
        llmProvider,
      });

      orchestrator.registerAgent(
        createMockAgent("code", { success: true, output: "file read ok" }),
      );
      orchestrator.registerAgent(
        createMockAgent("git", { success: true, output: "commit ok" }),
      );

      // First prompt → code agent
      const input1 = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "read file main.ts" }],
        }) + "\n",
      );
      const output1 = createMockOutput();
      const transport1 = new StdioTransport({ input: input1, output: output1 });
      const server1 = new AcpServer(transport1, sessions, undefined, orchestrator);
      await server1.start();

      // Verify code agent ran
      const codeNotif = output1.messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "file read ok",
      );
      expect(codeNotif).toBeDefined();

      // Second prompt → git agent (same session)
      const input2 = createInputStream(
        jsonrpc(2, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "git commit" }],
        }) + "\n",
      );
      const output2 = createMockOutput();
      const transport2 = new StdioTransport({ input: input2, output: output2 });
      const server2 = new AcpServer(transport2, sessions, undefined, orchestrator);
      await server2.start();

      // Verify git agent ran
      const gitNotif = output2.messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "commit ok",
      );
      expect(gitNotif).toBeDefined();
    });
  });

  // ========================================================================
  // Fallback: keyword classifier without LLM
  // ========================================================================

  describe("fallback without LLM classifier", () => {
    it("should work with KeywordIntentClassifier alone (no LLM for routing)", async () => {
      const messages = await runPromptOnly({
        agents: [
          { type: "code", result: { success: true, output: "code done" } },
          { type: "git", result: { success: true, output: "git done" } },
        ],
        prompt: "commit my changes",
        classifier: "keyword",
      });

      // Should have routed to git (keyword "commit" matches git agent)
      const gitNotif = messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "git done",
      );
      expect(gitNotif).toBeDefined();

      const lastMsg = messages[messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("end_turn");
    });

    it("should route to code agent by default when no keywords match", async () => {
      const messages = await runPromptOnly({
        agents: [
          { type: "code", result: { success: true, output: "default code" } },
          { type: "os", result: { success: true, output: "os fallback" } },
        ],
        prompt: "hello world, how are you?",
        classifier: "keyword",
      });

      // No specific keywords → defaults to code agent
      const codeNotif = messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "default code",
      );
      expect(codeNotif).toBeDefined();
    });
  });

  // ========================================================================
  // Error scenarios
  // ========================================================================

  describe("error scenarios", () => {
    it("should handle agent throwing error gracefully", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/test/workspace");

      const historyProvider = new InMemoryHistoryProvider();
      const llmProvider = createMockLLMProvider("code");

      const orchestrator = new Orchestrator({
        intentClassifier: new KeywordIntentClassifier(),
        historyProvider,
        llmProvider,
      });

      orchestrator.registerAgent(
        createThrowingAgent("code", "Agent exploded during execution"),
      );

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "read file" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, undefined, orchestrator);

      await server.start();

      // Should have error notification + response
      const errorNotif = output.messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text?.includes("Agent exploded during execution"),
      );
      expect(errorNotif).toBeDefined();

      // Response should have error stopReason
      const lastMsg = output.messages[output.messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("error");
    });

    it("should handle agent returning failure result", async () => {
      const messages = await runPromptOnly({
        agents: [{
          type: "code",
          result: {
            success: false,
            output: "File not found",
            error: "FILE_NOT_FOUND",
          },
        }],
        prompt: "read missing file",
      });

      // Should have error notification
      const errorNotif = messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text?.includes("File not found"),
      );
      expect(errorNotif).toBeDefined();

      // Response should have error stopReason
      const lastMsg = messages[messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("error");
    });

    it("should handle empty agent registry (no agents registered)", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/test/workspace");

      const historyProvider = new InMemoryHistoryProvider();
      const llmProvider = createMockLLMProvider("code");

      const orchestrator = new Orchestrator({
        intentClassifier: new KeywordIntentClassifier(),
        historyProvider,
        llmProvider,
      });
      // No agents registered!

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "do something" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, undefined, orchestrator);

      await server.start();

      // Should have error notification about no agents
      const errorNotif = output.messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text?.includes("No agents registered"),
      );
      expect(errorNotif).toBeDefined();

      // Response should have error stopReason
      const lastMsg = output.messages[output.messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("error");
    });
  });

  // ========================================================================
  // Backward compatibility
  // ========================================================================

  describe("backward compatibility", () => {
    it("should work exactly as before when no orchestrator is provided", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("Direct LLM response");

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Hola" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      // No orchestrator — should use LLM provider directly
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      // Should have: 1 notification + 1 response = 2 messages
      expect(output.messages).toHaveLength(2);

      const notification = output.messages[0]!;
      expect(notification.method).toBe("session/update");
      expect(notification.params.update.content.text).toBe("Direct LLM response");

      const response = output.messages[1]!;
      expect(response.result.stopReason).toBe("end_turn");
    });

    it("should work without orchestrator and without LLM (static response)", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Hola" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      // No orchestrator, no LLM
      const server = new AcpServer(transport, sessions);

      await server.start();

      expect(output.messages).toHaveLength(2);

      const notification = output.messages[0]!;
      expect(notification.params.update.content.text).toBe("Hola, soy tu asistente ACP");

      const response = output.messages[1]!;
      expect(response.result.stopReason).toBe("end_turn");
    });

    it("should complete full initialize → new → prompt flow without orchestrator", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/workspace");
      const mockProvider = createMockLLMProvider("LLM answer");

      const requests = [
        jsonrpc(1, "initialize", { protocolVersion: 1 }),
        jsonrpc(2, "session/new", { cwd: "/workspace", mcpServers: [] }),
        jsonrpc(3, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Pregunta" }],
        }),
      ].join("\n") + "\n";

      const input = createInputStream(requests);
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      expect(output.messages).toHaveLength(4);

      // 1. initialize
      expect(output.messages[0]!.result.protocolVersion).toBe(1);
      // 2. session/new
      expect(output.messages[1]!.result.sessionId).toBeDefined();
      // 3. session/update
      expect(output.messages[2]!.method).toBe("session/update");
      expect(output.messages[2]!.params.update.content.text).toBe("LLM answer");
      // 4. session/prompt response
      expect(output.messages[3]!.result.stopReason).toBe("end_turn");
    });
  });

  // ========================================================================
  // History management
  // ========================================================================

  describe("history management", () => {
    it("should provide empty history for new session", async () => {
      const historyProvider = new InMemoryHistoryProvider();
      const sessionId = "new-session" as import("../../src/types/persistence.ts").SessionId;

      const history = await historyProvider.getHistory(sessionId);
      expect(history).toEqual([]);
    });

    it("should accumulate history across turns (InMemoryHistoryProvider)", async () => {
      const historyProvider = new InMemoryHistoryProvider();
      const sessionId = "sess-001" as import("../../src/types/persistence.ts").SessionId;

      // Add messages across multiple "turns"
      historyProvider.addMessage(sessionId, { role: "user", content: "First question" });
      historyProvider.addMessage(sessionId, { role: "assistant", content: "First answer" });
      historyProvider.addMessage(sessionId, { role: "user", content: "Follow-up" });

      const history = await historyProvider.getHistory(sessionId);
      expect(history).toHaveLength(3);
      expect(history[0]!.content).toBe("First question");
      expect(history[1]!.content).toBe("First answer");
      expect(history[2]!.content).toBe("Follow-up");
    });

    it("should isolate history between different sessions", async () => {
      const historyProvider = new InMemoryHistoryProvider();
      const sess1 = "sess-001" as import("../../src/types/persistence.ts").SessionId;
      const sess2 = "sess-002" as import("../../src/types/persistence.ts").SessionId;

      historyProvider.addMessage(sess1, { role: "user", content: "Session 1 msg" });
      historyProvider.addMessage(sess2, { role: "user", content: "Session 2 msg" });

      const hist1 = await historyProvider.getHistory(sess1);
      const hist2 = await historyProvider.getHistory(sess2);

      expect(hist1).toHaveLength(1);
      expect(hist1[0]!.content).toBe("Session 1 msg");
      expect(hist2).toHaveLength(1);
      expect(hist2[0]!.content).toBe("Session 2 msg");
    });

    it("should pass session history to agent context during dispatch", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/test/workspace");
      const sessionId = session.id as import("../../src/types/persistence.ts").SessionId;

      const historyProvider = new InMemoryHistoryProvider();
      // Pre-populate history
      historyProvider.addMessage(sessionId, { role: "user", content: "Previous question" });
      historyProvider.addMessage(sessionId, { role: "assistant", content: "Previous answer" });

      const llmProvider = createMockLLMProvider("code");

      let capturedHistory: readonly ChatMessage[] | undefined;
      const spyAgent: Agent = {
        name: "spy-code",
        type: "code",
        systemPrompt: "Spy agent",
        execute: mock(async (ctx: AgentContext) => {
          capturedHistory = ctx.sessionHistory;
          return { success: true, output: "spied" };
        }),
      };

      const orchestrator = new Orchestrator({
        intentClassifier: new KeywordIntentClassifier(),
        historyProvider,
        llmProvider,
      });
      orchestrator.registerAgent(spyAgent);

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Follow-up question" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, undefined, orchestrator);

      await server.start();

      // Verify the spy agent received the history
      expect(capturedHistory).toBeDefined();
      // ContextWindow adds the current prompt ("Follow-up question") to the history,
      // so the agent receives: 2 historical messages + 1 current prompt = 3 total.
      expect(capturedHistory!).toHaveLength(3);
      expect(capturedHistory![0]!.content).toBe("Previous question");
      expect(capturedHistory![1]!.content).toBe("Previous answer");
    });
  });

  // ========================================================================
  // Composite classifier (LLM + keyword fallback)
  // ========================================================================

  describe("composite classifier integration", () => {
    it("should use LLM classifier when available and confident", async () => {
      const messages = await runPromptOnly({
        agents: [
          { type: "code", result: { success: true, output: "code output" } },
          { type: "git", result: { success: true, output: "git output" } },
        ],
        prompt: "create a git branch",
        classifier: "composite",
      });

      // "git" keyword should match git agent (keyword classifier also matches,
      // and LLM should also route to git)
      const gitNotif = messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "git output",
      );
      expect(gitNotif).toBeDefined();
    });

    it("should fall back to keyword when LLM classifier fails", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/test/workspace");

      const historyProvider = new InMemoryHistoryProvider();

      // Create an LLM provider that throws (simulating LLM failure)
      const failingLLMProvider: LLMProvider = {
        name: "failing-llm",
        chat: mock(() => Promise.reject(new Error("LLM unavailable"))),
        stream: mock(async function* () {
          yield { delta: "error", finishReason: "error" };
        }),
      };

      const llmClassifier = new LLMIntentClassifier(failingLLMProvider);
      const keywordClassifier = new KeywordIntentClassifier();
      const composite = new CompositeIntentClassifier(llmClassifier, keywordClassifier);

      const orchestrator = new Orchestrator({
        intentClassifier: composite,
        historyProvider,
        llmProvider: failingLLMProvider,
      });

      orchestrator.registerAgent(
        createMockAgent("git", { success: true, output: "git fallback success" }),
      );
      orchestrator.registerAgent(
        createMockAgent("code", { success: true, output: "code fallback" }),
      );

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "git commit" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, undefined, orchestrator);

      await server.start();

      // Should have fallen back to keyword classification and routed to git
      const gitNotif = output.messages.find(
        (m: any) =>
          m.method === "session/update" &&
          m.params?.update?.content?.text === "git fallback success",
      );
      expect(gitNotif).toBeDefined();

      const lastMsg = output.messages[output.messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("end_turn");
    });
  });

  // ========================================================================
  // Agent event mapping verification
  // ========================================================================

  describe("agent event mapping", () => {
    it("should map multiple text events to multiple session/update notifications", async () => {
      // This tests that the Orchestrator emits status texts + agent output
      const messages = await runPromptOnly({
        agents: [{ type: "code", result: { success: true, output: "Final result" } }],
        prompt: "analyze code",
      });

      // Should have multiple session/update notifications:
      // - "Analizando tu solicitud..."
      // - "Delegando al agente de mock-code..."
      // - "Final result"
      const notifications = messages.filter(
        (m: any) => m.method === "session/update",
      );
      expect(notifications.length).toBeGreaterThanOrEqual(2);

      // Last notification should contain the agent output
      const lastNotif = notifications[notifications.length - 1]!;
      expect(lastNotif.params.update.content.text).toBe("Final result");

      // Response should be end_turn
      const lastMsg = messages[messages.length - 1]!;
      expect(lastMsg.result.stopReason).toBe("end_turn");
    });

    it("should preserve session ID in all session/update notifications", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/test/workspace");

      const historyProvider = new InMemoryHistoryProvider();
      const llmProvider = createMockLLMProvider("code");

      const orchestrator = new Orchestrator({
        intentClassifier: new KeywordIntentClassifier(),
        historyProvider,
        llmProvider,
      });

      orchestrator.registerAgent(
        createMockAgent("code", { success: true, output: "done" }),
      );

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "test" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, undefined, orchestrator);

      await server.start();

      // All session/update notifications should reference the correct session
      const notifications = output.messages.filter(
        (m: any) => m.method === "session/update",
      );
      expect(notifications.length).toBeGreaterThan(0);

      for (const notif of notifications) {
        expect(notif.params.sessionId).toBe(session.id);
      }
    });
  });
});
