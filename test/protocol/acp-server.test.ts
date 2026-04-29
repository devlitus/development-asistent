/**
 * Integration tests for AcpServer — the ACP protocol handler.
 *
 * Tests simulate the full JSON-RPC flow over mock stdio streams:
 * initialize → session/new → session/prompt.
 */

import { describe, it, expect, mock } from "bun:test";
import { StdioTransport } from "../../src/transport/stdio.ts";
import { AcpServer } from "../../src/protocol/acp-server.ts";
import { SessionStore } from "../../src/protocol/session-store.ts";
import type { LLMProvider, LLMResponse, ChatMessage } from "../../src/types/llm.ts";
import type { Orchestrator } from "../../src/orchestrator/index.ts";
import type { AgentEvent } from "../../src/orchestrator/types.ts";
import type { SessionId } from "../../src/types/persistence.ts";

// ---------------------------------------------------------------------------
// Helpers: mock streams (same pattern as transport tests)
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

/** Build a JSON-RPC notification string (no id). */
function jsonrpcNotification(method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method,
    ...(params !== undefined && { params }),
  });
}

/** Create a mock LLM provider for testing. */
function createMockLLMProvider(responseText: string): LLMProvider {
  return {
    name: "mock",
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

/** Create a mock Orchestrator that emits the given events via dispatch(). */
function createMockOrchestrator(events: AgentEvent[]): Orchestrator {
  return {
    registerAgent: mock(() => {}),
    getRegisteredAgents: mock(() => []),
    dispatch: mock(function (_sid: SessionId, _prompt: string, _wd?: string): AsyncGenerator<AgentEvent> {
      const evts = events;
      return (async function* () {
        for (const event of evts) {
          yield event;
        }
      })();
    }),
  } as unknown as Orchestrator;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AcpServer", () => {
  // =========================================================================
  // initialize
  // =========================================================================

  describe("initialize handler", () => {
    it("should respond with protocol version 1", async () => {
      const input = createInputStream(jsonrpc(1, "initialize", { protocolVersion: 1 }) + "\n");
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result.protocolVersion).toBe(1);
    });

    it("should respond with agent capabilities (no loadSession, no tools)", async () => {
      const input = createInputStream(jsonrpc(1, "initialize", { protocolVersion: 1 }) + "\n");
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      const response = output.messages[0]!;
      expect(response.result.agentCapabilities).toBeDefined();
      expect(response.result.agentCapabilities.loadSession).toBe(false);
      // No MCP capabilities in v1 spike
      expect(response.result.agentCapabilities.mcpCapabilities).toBeUndefined();
    });

    it("should not include authMethods", async () => {
      const input = createInputStream(jsonrpc(1, "initialize", { protocolVersion: 1 }) + "\n");
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      const response = output.messages[0]!;
      expect(response.result.authMethods).toBeUndefined();
    });

    it("should still respond successfully when protocolVersion is not 1", async () => {
      // Current implementation is lenient — it returns v1 regardless of input.
      // This test documents that behavior; strict validation may be added later.
      const input = createInputStream(jsonrpc(1, "initialize", { protocolVersion: 99 }) + "\n");
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result.protocolVersion).toBe(1);
    });
  });

  // =========================================================================
  // session/new
  // =========================================================================

  describe("session/new handler", () => {
    it("should create a session and return a unique session ID", async () => {
      const input = createInputStream(
        jsonrpc(1, "session/new", { cwd: "/tmp/test", mcpServers: [] }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.id).toBe(1);
      expect(response.result.sessionId).toBeDefined();
      expect(typeof response.result.sessionId).toBe("string");
      expect(response.result.sessionId.length).toBeGreaterThan(0);
    });

    it("should store the session in memory", async () => {
      const sessions = new SessionStore();
      const input = createInputStream(
        jsonrpc(1, "session/new", { cwd: "/tmp/test", mcpServers: [] }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions);

      await server.start();

      const response = output.messages[0]!;
      const sessionId = response.result.sessionId;
      expect(sessions.has(sessionId)).toBe(true);
      expect(sessions.get(sessionId)!.cwd).toBe("/tmp/test");
    });

    it("should generate unique session IDs for each request", async () => {
      const input = createInputStream(
        jsonrpc(1, "session/new", { cwd: "/tmp/a", mcpServers: [] }) + "\n" +
        jsonrpc(2, "session/new", { cwd: "/tmp/b", mcpServers: [] }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      const response1 = output.messages[0]!;
      const response2 = output.messages[1]!;
      expect(response1.result.sessionId).not.toBe(response2.result.sessionId);
    });
  });

  // =========================================================================
  // session/prompt
  // =========================================================================

  describe("session/prompt handler", () => {
    it("should send session/update notification with agent_message_chunk before responding", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");

      const promptParams = {
        sessionId: session.id,
        prompt: [{ type: "text", text: "Hola" }],
      };

      const input = createInputStream(
        jsonrpc(1, "session/prompt", promptParams) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions);

      await server.start();

      // Should have: 1 notification + 1 response = 2 messages
      expect(output.messages).toHaveLength(2);

      // First: session/update notification
      const notification = output.messages[0]!;
      expect(notification.jsonrpc).toBe("2.0");
      expect(notification.method).toBe("session/update");
      expect(notification.params).toBeDefined();
      expect(notification.params.sessionId).toBe(session.id);
      expect(notification.params.update.sessionUpdate).toBe("agent_message_chunk");
      expect(notification.params.update.content.type).toBe("text");
      expect(notification.params.update.content.text).toBe("Hola, soy tu asistente ACP");

      // Second: response with stopReason
      const response = output.messages[1]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result.stopReason).toBe("end_turn");
    });

    it("should respond with error for unknown session ID", async () => {
      const promptParams = {
        sessionId: "non-existent-session-id",
        prompt: [{ type: "text", text: "Hola" }],
      };

      const input = createInputStream(
        jsonrpc(1, "session/prompt", promptParams) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain("session");
    });
  });

  describe("session/prompt handler with LLM provider", () => {
    it("should use LLM provider to generate response", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("Respuesta del LLM");

      const promptParams = {
        sessionId: session.id,
        prompt: [{ type: "text", text: "Hola" }],
      };

      const input = createInputStream(
        jsonrpc(1, "session/prompt", promptParams) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      // Should have: 1 notification + 1 response = 2 messages
      expect(output.messages).toHaveLength(2);

      // First: session/update notification with LLM content
      const notification = output.messages[0]!;
      expect(notification.method).toBe("session/update");
      expect(notification.params.update.content.text).toBe("Respuesta del LLM");

      // Second: response with stopReason
      const response = output.messages[1]!;
      expect(response.result.stopReason).toBe("end_turn");

      // Verify LLM was called with correct messages
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      const llmMessages = (mockProvider.chat as ReturnType<typeof mock>).mock.calls[0][0];
      expect(llmMessages).toEqual([{ role: "user", content: "Hola" }]);
    });

    it("should handle LLM errors gracefully", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const errorProvider: LLMProvider = {
        name: "error-mock",
        chat: mock(() => Promise.reject(new Error("LLM API failure"))),
        stream: mock(async function* () { /* empty */ }),
      };

      const promptParams = {
        sessionId: session.id,
        prompt: [{ type: "text", text: "Hola" }],
      };

      const input = createInputStream(
        jsonrpc(1, "session/prompt", promptParams) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, errorProvider);

      await server.start();

      // Should respond with error
      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain("LLM");
    });

    it("should map multiple content blocks to chat messages", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("OK");

      const promptParams = {
        sessionId: session.id,
        prompt: [
          { type: "text", text: "Primera parte" },
          { type: "text", text: "Segunda parte" },
        ],
      };

      const input = createInputStream(
        jsonrpc(1, "session/prompt", promptParams) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      const llmMessages = (mockProvider.chat as ReturnType<typeof mock>).mock.calls[0][0];
      expect(llmMessages).toEqual([
        { role: "user", content: "Primera parte" },
        { role: "user", content: "Segunda parte" },
      ]);
    });

    it("should map only text blocks and skip unknown block types (mixed content)", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("OK");

      const promptParams = {
        sessionId: session.id,
        prompt: [
          { type: "text", text: "Texto válido" },
          { type: "image", source: "base64", data: "..." },
          { type: "tool_use", id: "t1", name: "tool", input: {} },
          { type: "text", text: "Otro texto" },
          { unknown: "block" },
        ],
      };

      const input = createInputStream(
        jsonrpc(1, "session/prompt", promptParams) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      const llmMessages = (mockProvider.chat as ReturnType<typeof mock>).mock.calls[0][0];
      expect(llmMessages).toEqual([
        { role: "user", content: "Texto válido" },
        { role: "user", content: "Otro texto" },
      ]);
    });

    it("should send empty user message when prompt is empty array", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("OK");

      const input = createInputStream(
        jsonrpc(1, "session/prompt", { sessionId: session.id, prompt: [] }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      const llmMessages = (mockProvider.chat as ReturnType<typeof mock>).mock.calls[0][0];
      expect(llmMessages).toEqual([{ role: "user", content: "" }]);
    });

    it("should send empty user message when prompt is undefined", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("OK");

      const input = createInputStream(
        jsonrpc(1, "session/prompt", { sessionId: session.id }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      const llmMessages = (mockProvider.chat as ReturnType<typeof mock>).mock.calls[0][0];
      expect(llmMessages).toEqual([{ role: "user", content: "" }]);
    });

    it("should send empty user message when prompt contains only non-text blocks", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("OK");

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [
            { type: "image", source: "base64", data: "..." },
            { type: "tool_use", id: "t1", name: "tool", input: {} },
          ],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      const llmMessages = (mockProvider.chat as ReturnType<typeof mock>).mock.calls[0][0];
      expect(llmMessages).toEqual([{ role: "user", content: "" }]);
    });

    it("should not leak API keys in LLM error messages", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const secretKey = "sk-ant-api03-XXXXX-SECRET-XXXXX";
      const errorProvider: LLMProvider = {
        name: "error-mock",
        chat: mock(() =>
          Promise.reject(new Error(`Request failed with 401: ${secretKey}`)),
        ),
        stream: mock(async function* () { /* empty */ }),
      };

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Hola" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, errorProvider);

      await server.start();

      const response = output.messages[0]!;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
      // The raw error message should NOT contain the secret key
      expect(response.error.message).not.toContain(secretKey);
      expect(response.error.message).toContain("LLM error");
    });

    it("should reject session/prompt for expired sessions", async () => {
      const sessions = new SessionStore({ maxAgeMs: -1 });
      const session = sessions.create("/tmp/test");

      // Session is immediately expired due to maxAgeMs: -1
      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Hola" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain("session");
      expect(response.error.message).toContain("not found");
    });

    it("should deterministically send session/update before session/prompt response", async () => {
      const sessions = new SessionStore();
      const session = sessions.create("/tmp/test");
      const mockProvider = createMockLLMProvider("Respuesta determinista");

      const input = createInputStream(
        jsonrpc(1, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Hola" }],
        }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions, mockProvider);

      await server.start();

      expect(output.messages).toHaveLength(2);
      // First must be notification, second must be response
      expect(output.messages[0]!.method).toBe("session/update");
      expect(output.messages[1]!.id).toBe(1);
      expect(output.messages[1]!.result.stopReason).toBe("end_turn");
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe("error handling", () => {
    it("should respond with method_not_found (-32601) for unknown methods", async () => {
      const input = createInputStream(
        jsonrpc(1, "unknown/method", {}) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain("Method not found");
    });

    it("should handle multiple unknown methods", async () => {
      const input = createInputStream(
        jsonrpc(1, "foo", {}) + "\n" +
        jsonrpc(2, "bar", {}) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(2);
      expect(output.messages[0]!.error.code).toBe(-32601);
      expect(output.messages[1]!.error.code).toBe(-32601);
    });
  });

  // =========================================================================
  // Notifications (no id)
  // =========================================================================

  describe("notifications", () => {
    it("should silently ignore notifications without id", async () => {
      const input = createInputStream(
        jsonrpcNotification("session/cancel", { sessionId: "abc" }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      // No responses sent for notifications
      expect(output.messages).toHaveLength(0);
    });
  });

  // =========================================================================
  // Edge cases — params validation
  // =========================================================================

  describe("params validation", () => {
    it("should respond with error when session/new is called without params", async () => {
      const input = createInputStream(
        jsonrpc(1, "session/new") + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      // Zod default: cwd defaults to "/" when missing → valid response
      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.id).toBe(1);
      expect(response.result.sessionId).toBeDefined();
    });

    it("should respond with error when session/new has null params", async () => {
      const input = createInputStream(
        jsonrpc(1, "session/new", null) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.id).toBe(1);
      // null is not an object → Zod parse fails
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32602);
    });

    it("should respond with error when session/prompt is called without params", async () => {
      const input = createInputStream(
        jsonrpc(1, "session/prompt") + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.id).toBe(1);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32602);
    });

    it("should respond with error when session/prompt has empty sessionId", async () => {
      const input = createInputStream(
        jsonrpc(1, "session/prompt", { sessionId: "", prompt: [] }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32602);
    });

    it("should respond with error when session/new has non-string cwd", async () => {
      const input = createInputStream(
        jsonrpc(1, "session/new", { cwd: 12345 }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32602);
    });

    it("should handle initialize called multiple times (idempotent)", async () => {
      const input = createInputStream(
        jsonrpc(1, "initialize", { protocolVersion: 1 }) + "\n" +
        jsonrpc(2, "initialize", { protocolVersion: 1 }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      await server.start();

      expect(output.messages).toHaveLength(2);
      expect(output.messages[0]!.id).toBe(1);
      expect(output.messages[0]!.result.protocolVersion).toBe(1);
      expect(output.messages[1]!.id).toBe(2);
      expect(output.messages[1]!.result.protocolVersion).toBe(1);
    });
  });

  // =========================================================================
  // Graceful shutdown
  // =========================================================================

  describe("graceful shutdown", () => {
    it("should stop() and resolve start()", async () => {
      // Create an input stream that stays open (doesn't close immediately)
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const input = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          // Send one message
          c.enqueue(encoder.encode(jsonrpc(1, "initialize") + "\n"));
          // Don't close — stream stays open
        },
      });
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport);

      // Start reading in background
      const startPromise = server.start();

      // Give it a tick to process the message
      await new Promise((r) => setTimeout(r, 10));

      // We should have the initialize response
      expect(output.messages).toHaveLength(1);

      // Now stop the server
      server.stop();

      // start() should resolve after stop
      await startPromise;
    });
  });

  // =========================================================================
  // Full integration flow
  // =========================================================================

  describe("full integration flow", () => {
    it("should handle initialize → session/new → session/prompt in sequence", async () => {
      // Pre-create a session so we know the ID for session/prompt
      const sessions = new SessionStore();
      const session = sessions.create("/workspace/project");

      const requests = [
        jsonrpc(1, "initialize", { protocolVersion: 1 }),
        jsonrpc(2, "session/new", { cwd: "/workspace/project", mcpServers: [] }),
        jsonrpc(3, "session/prompt", {
          sessionId: session.id,
          prompt: [{ type: "text", text: "Ayúdame con mi código" }],
        }),
      ].join("\n") + "\n";

      const input = createInputStream(requests);
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions);

      await server.start();

      // Expected output:
      // 1. initialize response
      // 2. session/new response
      // 3. session/update notification (from session/prompt)
      // 4. session/prompt response
      expect(output.messages).toHaveLength(4);

      // 1. initialize response
      const initResponse = output.messages[0]!;
      expect(initResponse.id).toBe(1);
      expect(initResponse.result.protocolVersion).toBe(1);
      expect(initResponse.result.agentCapabilities).toBeDefined();

      // 2. session/new response
      const newSessionResponse = output.messages[1]!;
      expect(newSessionResponse.id).toBe(2);
      expect(newSessionResponse.result.sessionId).toBeDefined();

      // 3. session/update notification
      const updateNotif = output.messages[2]!;
      expect(updateNotif.method).toBe("session/update");
      expect(updateNotif.params.sessionId).toBe(session.id);
      expect(updateNotif.params.update.sessionUpdate).toBe("agent_message_chunk");
      expect(updateNotif.params.update.content.text).toBe("Hola, soy tu asistente ACP");

      // 4. session/prompt response
      const promptResponse = output.messages[3]!;
      expect(promptResponse.id).toBe(3);
      expect(promptResponse.result.stopReason).toBe("end_turn");
    });

    it("should maintain independent sessions", async () => {
      const sessions = new SessionStore();
      const session1 = sessions.create("/project/a");
      const session2 = sessions.create("/project/b");

      const requests = [
        jsonrpc(1, "session/prompt", {
          sessionId: session1.id,
          prompt: [{ type: "text", text: "msg1" }],
        }),
        jsonrpc(2, "session/prompt", {
          sessionId: session2.id,
          prompt: [{ type: "text", text: "msg2" }],
        }),
      ].join("\n") + "\n";

      const input = createInputStream(requests);
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });
      const server = new AcpServer(transport, sessions);

      await server.start();

      // 4 messages: 2 notifications + 2 responses
      expect(output.messages).toHaveLength(4);

      // First prompt's notification should reference session1
      const notif1 = output.messages[0]!;
      expect(notif1.method).toBe("session/update");
      expect(notif1.params.sessionId).toBe(session1.id);

      // First prompt's response
      const resp1 = output.messages[1]!;
      expect(resp1.id).toBe(1);
      expect(resp1.result.stopReason).toBe("end_turn");

      // Second prompt's notification should reference session2
      const notif2 = output.messages[2]!;
      expect(notif2.method).toBe("session/update");
      expect(notif2.params.sessionId).toBe(session2.id);

      // Second prompt's response
      const resp2 = output.messages[3]!;
      expect(resp2.id).toBe(2);
      expect(resp2.result.stopReason).toBe("end_turn");
    });
  });
});

// ---------------------------------------------------------------------------
// AcpServer with Orchestrator integration
// ---------------------------------------------------------------------------

describe("AcpServer with Orchestrator", () => {
  it("should dispatch to orchestrator when available and map text events to session/update", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "text", content: "Respuesta del agente" },
      { type: "done", success: true },
    ]);

    const input = createInputStream(
      jsonrpc(1, "session/prompt", {
        sessionId: session.id,
        prompt: [{ type: "text", text: "Hola" }],
      }) + "\n",
    );
    const output = createMockOutput();
    const transport = new StdioTransport({ input, output });
    const server = new AcpServer(transport, sessions, undefined, orchestrator);

    await server.start();

    // Should have: 1 notification + 1 response = 2 messages
    expect(output.messages).toHaveLength(2);

    // First: session/update notification with agent_message_chunk
    const notification = output.messages[0]!;
    expect(notification.jsonrpc).toBe("2.0");
    expect(notification.method).toBe("session/update");
    expect(notification.params.sessionId).toBe(session.id);
    expect(notification.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(notification.params.update.content.type).toBe("text");
    expect(notification.params.update.content.text).toBe("Respuesta del agente");

    // Second: response with stopReason "end_turn"
    const response = output.messages[1]!;
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result.stopReason).toBe("end_turn");

    // Verify orchestrator.dispatch was called with correct args
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("should map AgentEvent.error to session/update notification with error text", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "error", error: "agent_error", message: "Something went wrong" },
      { type: "done", success: false },
    ]);

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

    // Should have: 1 notification (error) + 1 response = 2 messages
    expect(output.messages).toHaveLength(2);

    const notification = output.messages[0]!;
    expect(notification.method).toBe("session/update");
    expect(notification.params.update.content.text).toBe("Error: Something went wrong");

    const response = output.messages[1]!;
    expect(response.result.stopReason).toBe("error");
  });

  it("should return end_turn stopReason when done.success is true", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "text", content: "Todo bien" },
      { type: "done", success: true },
    ]);

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

    const response = output.messages[output.messages.length - 1]!;
    expect(response.result.stopReason).toBe("end_turn");
  });

  it("should return error stopReason when done.success is false", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "text", content: "Parcial" },
      { type: "done", success: false },
    ]);

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

    const response = output.messages[output.messages.length - 1]!;
    expect(response.result.stopReason).toBe("error");
  });

  it("should send multiple session/update notifications for multi-event dispatch", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "text", content: "Primera parte" },
      { type: "text", content: "Segunda parte" },
      { type: "text", content: "Tercera parte" },
      { type: "done", success: true },
    ]);

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

    // Should have: 3 notifications + 1 response = 4 messages
    expect(output.messages).toHaveLength(4);

    // Verify each notification
    expect(output.messages[0]!.params.update.content.text).toBe("Primera parte");
    expect(output.messages[1]!.params.update.content.text).toBe("Segunda parte");
    expect(output.messages[2]!.params.update.content.text).toBe("Tercera parte");

    // Final response
    const response = output.messages[3]!;
    expect(response.result.stopReason).toBe("end_turn");
  });

  it("should log tool_call and permission_request events to stderr without sending notifications", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "text", content: "Inicio" },
      { type: "tool_call", id: "tc1", name: "read_file", arguments: "{}", status: "completed" },
      { type: "permission_request", id: "pr1", tool: "shell", args: { cmd: "ls" } },
      { type: "text", content: "Fin" },
      { type: "done", success: true },
    ]);

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

    // Should have: text + tool_call(completed=TOOL_RESULT) + text notifications + 1 response = 4 messages
    // (permission_request should NOT produce notifications)
    expect(output.messages).toHaveLength(4);

    expect(output.messages[0]!.params.update.content.text).toBe("Inicio");
    expect(output.messages[1]!.params.update.content.text).toContain("\x00TOOL_RESULT\x00");
    expect(output.messages[2]!.params.update.content.text).toBe("Fin");
  });

  it("should send session/update notification with tool name when tool_call status is in_progress", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "text", content: "Buscando..." },
      { type: "tool_call", id: "tc1", name: "bash", arguments: '{"cmd":"ls"}', status: "in_progress" },
      { type: "text", content: "Listo" },
      { type: "done", success: true },
    ]);

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

    // Should have: text + tool_call(in_progress) + text notifications + 1 response = 4 messages
    expect(output.messages).toHaveLength(4);

    // First: text notification
    expect(output.messages[0]!.params.update.content.text).toBe("Buscando...");

    // Second: tool_call notification with \x00TOOL_CALL\x00 marker format
    const toolNotif = output.messages[1]!;
    expect(toolNotif.method).toBe("session/update");
    expect(toolNotif.params.sessionId).toBe(session.id);
    expect(toolNotif.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(toolNotif.params.update.content.type).toBe("text");
    expect(toolNotif.params.update.content.text).toBe("\x00TOOL_CALL\x00bash");

    // Third: text notification
    expect(output.messages[2]!.params.update.content.text).toBe("Listo");

    // Fourth: response
    expect(output.messages[3]!.result.stopReason).toBe("end_turn");
  });

  it("should NOT send notification for tool_call with status completed, failed, or pending", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "tool_call", id: "tc1", name: "read_file", arguments: "{}", status: "completed" },
      { type: "tool_call", id: "tc2", name: "write_file", arguments: "{}", status: "failed" },
      { type: "tool_call", id: "tc3", name: "grep", arguments: "{}", status: "pending" },
      { type: "text", content: "Solo yo" },
      { type: "done", success: true },
    ]);

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

    // completed and failed now emit TOOL_RESULT markers; pending does not.
    // So: 2 TOOL_RESULT notifications + 1 text + 1 response = 4 messages
    expect(output.messages).toHaveLength(4);
    expect(output.messages[0]!.params.update.content.text).toContain("\x00TOOL_RESULT\x00read_file\x00completed");
    expect(output.messages[1]!.params.update.content.text).toContain("\x00TOOL_RESULT\x00write_file\x00failed");
    expect(output.messages[2]!.params.update.content.text).toBe("Solo yo");
    expect(output.messages[3]!.result.stopReason).toBe("end_turn");
  });

  it("should fall back to direct LLM when orchestrator is not available", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");
    const mockProvider = createMockLLMProvider("Respuesta directa del LLM");

    const input = createInputStream(
      jsonrpc(1, "session/prompt", {
        sessionId: session.id,
        prompt: [{ type: "text", text: "Hola" }],
      }) + "\n",
    );
    const output = createMockOutput();
    const transport = new StdioTransport({ input, output });
    // No orchestrator passed — should use LLM provider directly
    const server = new AcpServer(transport, sessions, mockProvider);

    await server.start();

    // Should have: 1 notification + 1 response = 2 messages
    expect(output.messages).toHaveLength(2);

    const notification = output.messages[0]!;
    expect(notification.params.update.content.text).toBe("Respuesta directa del LLM");

    const response = output.messages[1]!;
    expect(response.result.stopReason).toBe("end_turn");

    // Verify LLM was called
    expect(mockProvider.chat).toHaveBeenCalledTimes(1);
  });

  it("should handle orchestrator dispatch throwing an error", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    // Create orchestrator whose dispatch throws
    const failingOrchestrator = {
      registerAgent: mock(() => {}),
      getRegisteredAgents: mock(() => []),
      dispatch: mock(function (_sid: SessionId, _prompt: string, _wd?: string): AsyncGenerator<AgentEvent> {
        throw new Error("Orchestrator exploded");
      }),
    } as unknown as Orchestrator;

    const input = createInputStream(
      jsonrpc(1, "session/prompt", {
        sessionId: session.id,
        prompt: [{ type: "text", text: "test" }],
      }) + "\n",
    );
    const output = createMockOutput();
    const transport = new StdioTransport({ input, output });
    const server = new AcpServer(transport, sessions, undefined, failingOrchestrator);

    await server.start();

    // Should respond with internal error
    expect(output.messages).toHaveLength(1);
    const response = output.messages[0]!;
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toBe("Internal error");
  });

  it("should pass prompt text and session cwd to orchestrator.dispatch", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/my/workspace");

    const orchestrator = createMockOrchestrator([
      { type: "done", success: true },
    ]);

    const input = createInputStream(
      jsonrpc(1, "session/prompt", {
        sessionId: session.id,
        prompt: [{ type: "text", text: "Busca archivos" }],
      }) + "\n",
    );
    const output = createMockOutput();
    const transport = new StdioTransport({ input, output });
    const server = new AcpServer(transport, sessions, undefined, orchestrator);

    await server.start();

    // Verify dispatch was called with correct prompt text and working directory
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1);
    const dispatchCall = (orchestrator.dispatch as ReturnType<typeof mock>).mock.calls[0];
    expect(dispatchCall[1]).toBe("Busca archivos"); // prompt text
    expect(dispatchCall[2]).toBe("/my/workspace"); // cwd from session
  });

  it("should sanitize error messages in orchestrator error events", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");
    const secretKey = "sk-ant-api03-XXXXX-SECRET-XXXXX";

    const orchestrator = createMockOrchestrator([
      { type: "error", error: "agent_error", message: `API failed: ${secretKey}` },
      { type: "done", success: false },
    ]);

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

    // Should have: 1 notification (error) + 1 response = 2 messages
    expect(output.messages).toHaveLength(2);

    const notification = output.messages[0]!;
    expect(notification.method).toBe("session/update");
    // The secret key must be redacted from the error message
    expect(notification.params.update.content.text).not.toContain(secretKey);
    expect(notification.params.update.content.text).toContain("[REDACTED]");
    expect(notification.params.update.content.text).toContain("API failed:");
  });

  it("should handle mixed text and error events from orchestrator", async () => {
    const sessions = new SessionStore();
    const session = sessions.create("/tmp/test");

    const orchestrator = createMockOrchestrator([
      { type: "text", content: "Procesando..." },
      { type: "error", error: "partial_fail", message: "Tool failed" },
      { type: "text", content: "Pero continué" },
      { type: "done", success: true },
    ]);

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

    // 3 notifications (text, error, text) + 1 response = 4 messages
    expect(output.messages).toHaveLength(4);

    expect(output.messages[0]!.params.update.content.text).toBe("Procesando...");
    expect(output.messages[1]!.params.update.content.text).toBe("Error: Tool failed");
    expect(output.messages[2]!.params.update.content.text).toBe("Pero continué");

    const response = output.messages[3]!;
    expect(response.result.stopReason).toBe("end_turn");
  });
});

// ---------------------------------------------------------------------------
// SessionStore unit tests
// ---------------------------------------------------------------------------

describe("SessionStore", () => {
  it("should create and retrieve a session", () => {
    const store = new SessionStore();
    const session = store.create("/tmp/test");

    expect(session.id).toBeDefined();
    expect(session.cwd).toBe("/tmp/test");
    expect(session.createdAt).toBeGreaterThan(0);

    const retrieved = store.get(session.id);
    expect(retrieved).toEqual(session);
  });

  it("should return undefined for non-existent session", () => {
    const store = new SessionStore();
    expect(store.get("non-existent")).toBeUndefined();
  });

  it("should report correct size", () => {
    const store = new SessionStore();
    expect(store.size).toBe(0);

    store.create("/tmp/a");
    expect(store.size).toBe(1);

    store.create("/tmp/b");
    expect(store.size).toBe(2);
  });

  it("should generate unique IDs", () => {
    const store = new SessionStore();
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const session = store.create(`/tmp/${i}`);
      ids.add(session.id);
    }

    expect(ids.size).toBe(100);
  });

  it("should return false for has() with non-existent ID", () => {
    const store = new SessionStore();
    expect(store.has("non-existent")).toBe(false);
  });

  it("should delete a session", () => {
    const store = new SessionStore();
    const session = store.create("/tmp/test");

    expect(store.has(session.id)).toBe(true);
    expect(store.delete(session.id)).toBe(true);
    expect(store.has(session.id)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("should return false when deleting non-existent session", () => {
    const store = new SessionStore();
    expect(store.delete("non-existent")).toBe(false);
  });

  it("should evict expired sessions", () => {
    // Use a negative maxAge so sessions are always expired
    const store = new SessionStore({ maxAgeMs: -1 });
    const session = store.create("/tmp/test");

    // Session should be expired after creation (maxAgeMs=-1)
    // has() uses get() internally which does lazy eviction
    expect(store.has(session.id)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("should lazily evict expired session on get()", () => {
    const store = new SessionStore({ maxAgeMs: -1 });
    const session = store.create("/tmp/test");

    expect(store.get(session.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("should keep sessions that are not expired", () => {
    const store = new SessionStore({ maxAgeMs: 60 * 60 * 1000 }); // 1 hour
    const session = store.create("/tmp/test");

    expect(store.has(session.id)).toBe(true);
    expect(store.get(session.id)).toEqual(session);
    expect(store.size).toBe(1);
  });

  it("should evictExpired clean up stale sessions", () => {
    const store = new SessionStore({ maxAgeMs: -1 });
    store.create("/tmp/a");
    store.create("/tmp/b");

    expect(store.size).toBe(2);

    const evicted = store.evictExpired();
    expect(evicted).toBe(2);
    expect(store.size).toBe(0);
  });
});
