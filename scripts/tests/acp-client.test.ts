/**
 * Tests for AcpClient — TUI-03
 *
 * Uses a mock AgentProcess to avoid real spawning.
 * Tests cover: handshake, timeout, error response, routing, sendPermissionResponse, sendPrompt.
 *
 * Uses bun:test (Jest-compatible syntax).
 */

import { describe, it, expect, jest, beforeEach } from "bun:test";
import { AcpClient } from "../tui/acp-client.ts";
import type { AgentMessage, SessionUpdatePayload, PermissionRequest } from "../tui/types.ts";

// ─── Mock AgentProcess ────────────────────────────────────────────────────────

function createMockAgentProcess() {
  const handlers: Array<(msg: AgentMessage) => void> = [];
  const sent: object[] = [];
  return {
    spawn: () => {},
    kill: () => {},
    send: (msg: object) => {
      sent.push(msg);
    },
    onMessage: (h: (msg: AgentMessage) => void) => handlers.push(h),
    onExit: (_h: (code: number | null) => void) => {},
    // Helper to simulate agent responses in tests
    simulateMessage: (msg: AgentMessage) => handlers.forEach((h) => h(msg)),
    getSent: () => sent,
  };
}

// ─── Test 1: Handshake completo ───────────────────────────────────────────────

describe("AcpClient — handshake completo", () => {
  it("debería completar initialize → newSession y retornar sessionId", async () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    // Start initialize (will be pending until we simulate response)
    const initPromise = client.initialize();

    // Simulate agent responding to initialize (id: 1)
    mock.simulateMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, serverInfo: { name: "test-agent" } },
    });

    const initResult = await initPromise;
    expect(initResult).toEqual({
      protocolVersion: 1,
      serverInfo: { name: "test-agent" },
    });

    // Verify the sent message was correct
    const sent = mock.getSent();
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });

    // Start newSession (will be pending until we simulate response)
    const sessionPromise = client.newSession("/home/user/project");

    // Simulate agent responding to newSession (id: 2)
    mock.simulateMessage({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "uuid-abc-123" },
    });

    const sessionId = await sessionPromise;
    expect(sessionId).toBe("uuid-abc-123");

    // Verify the sent message was correct
    expect(sent[1]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/home/user/project", mcpServers: [] },
    });
  });
});

// ─── Test 2: Timeout ──────────────────────────────────────────────────────────

describe("AcpClient — timeout", () => {
  it("debería rechazar initialize si no hay respuesta en 60s", async () => {
    // Use a very small timeout for testing
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any, { timeoutMs: 50 });

    await expect(client.initialize()).rejects.toThrow(/timeout/i);
  });

  it("debería rechazar newSession si no hay respuesta en 60s", async () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any, { timeoutMs: 50 });

    // First, complete initialize successfully
    const initPromise = client.initialize();
    mock.simulateMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, serverInfo: {} },
    });
    await initPromise;

    // Now newSession should timeout
    await expect(client.newSession("/tmp")).rejects.toThrow(/timeout/i);
  });
});

// ─── Test 3: Error response ───────────────────────────────────────────────────

describe("AcpClient — error response", () => {
  it("debería rechazar initialize cuando el agente responde con error", async () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    const initPromise = client.initialize();

    // Simulate agent responding with error (id: 1)
    mock.simulateMessage({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "bad" },
    });

    await expect(initPromise).rejects.toThrow("bad");
  });
});

// ─── Test 4: onUpdate routing ─────────────────────────────────────────────────

describe("AcpClient — onUpdate routing", () => {
  it("debería llamar al handler registrado cuando llega session/update", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    const received: SessionUpdatePayload[] = [];
    client.onUpdate((payload) => received.push(payload));

    const payload: SessionUpdatePayload = {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    };

    mock.simulateMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: payload,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it("debería soportar múltiples handlers de onUpdate", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    const calls: number[] = [];
    client.onUpdate(() => calls.push(1));
    client.onUpdate(() => calls.push(2));

    mock.simulateMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } },
    });

    expect(calls).toEqual([1, 2]);
  });
});

// ─── Test 5: onPermissionRequest routing ──────────────────────────────────────

describe("AcpClient — onPermissionRequest routing", () => {
  it("debería llamar al handler cuando llega session/request_permission", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    const received: PermissionRequest[] = [];
    client.onPermissionRequest((req) => received.push(req));

    const permReq: PermissionRequest = {
      sessionId: "sess-1",
      toolName: "bash",
      description: "Run shell command",
      input: { command: "ls" },
    };

    mock.simulateMessage({
      jsonrpc: "2.0",
      method: "session/request_permission",
      params: permReq,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(permReq);
  });
});

// ─── Test 6: sendPermissionResponse ──────────────────────────────────────────

describe("AcpClient — sendPermissionResponse", () => {
  it("debería enviar notificación sin campo id cuando approved=true", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    client.sendPermissionResponse("sess-1", true);

    const sent = mock.getSent();
    expect(sent).toHaveLength(1);

    const msg = sent[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty("id");
    expect(msg).toEqual({
      jsonrpc: "2.0",
      method: "session/confirm_permission",
      params: { sessionId: "sess-1", approved: true },
    });
  });

  it("debería enviar notificación sin campo id cuando approved=false", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    client.sendPermissionResponse("sess-2", false);

    const sent = mock.getSent();
    const msg = sent[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty("id");
    expect(msg).toEqual({
      jsonrpc: "2.0",
      method: "session/confirm_permission",
      params: { sessionId: "sess-2", approved: false },
    });
  });
});

// ─── Test 7: sendPrompt ───────────────────────────────────────────────────────

describe("AcpClient — sendPrompt", () => {
  it("debería enviar prompt y resolver cuando llega la respuesta con result", async () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    // Complete initialize first
    const initPromise = client.initialize();
    mock.simulateMessage({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, serverInfo: {} } });
    await initPromise;

    // Complete newSession
    const sessionPromise = client.newSession("/tmp");
    mock.simulateMessage({ jsonrpc: "2.0", id: 2, result: { sessionId: "sess-42" } });
    await sessionPromise;

    // Send prompt (id: 3)
    const promptPromise = client.sendPrompt("sess-42", "Hello agent!");

    // Verify the sent message
    const sent = mock.getSent();
    expect(sent[2]).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "sess-42",
        prompt: [{ type: "text", text: "Hello agent!" }],
      },
    });

    // Simulate session/update notifications arriving before the final result
    mock.simulateMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-42",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
      },
    });

    // Simulate final result
    mock.simulateMessage({
      jsonrpc: "2.0",
      id: 3,
      result: { stopReason: "end_turn" },
    });

    // Should resolve without error
    await expect(promptPromise).resolves.toBeUndefined();
  });

  it("debería rechazar sendPrompt si el agente responde con error", async () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    // Complete initialize
    const initPromise = client.initialize();
    mock.simulateMessage({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, serverInfo: {} } });
    await initPromise;

    // Send prompt (id: 2, since no newSession)
    const promptPromise = client.sendPrompt("sess-1", "test");

    mock.simulateMessage({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "session not found" },
    });

    await expect(promptPromise).rejects.toThrow("session not found");
  });
});

// ─── Test 9: Payload malformado no causa crash ────────────────────────────────

describe("AcpClient — malformed payload resilience", () => {
  it("no debería llamar al handler de onUpdate si session/update tiene estructura incorrecta", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    const received: unknown[] = [];
    client.onUpdate((payload) => received.push(payload));

    // Simulate a session/update with malformed params (missing required fields)
    mock.simulateMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: { badField: "not a valid SessionUpdatePayload" },
    });

    // Handler should NOT have been called
    expect(received).toHaveLength(0);
  });

  it("no debería llamar al handler de onPermissionRequest si params son malformados", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    const received: unknown[] = [];
    client.onPermissionRequest((req) => received.push(req));

    // Simulate a session/request_permission with malformed params
    mock.simulateMessage({
      jsonrpc: "2.0",
      method: "session/request_permission",
      params: { onlySessionId: "sess-1" }, // missing toolName and description
    });

    // Handler should NOT have been called
    expect(received).toHaveLength(0);
  });

  it("no debería crashear si params es null en session/update", () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    const received: unknown[] = [];
    client.onUpdate((payload) => received.push(payload));

    // Should not throw
    expect(() => {
      mock.simulateMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: null as any,
      });
    }).not.toThrow();

    expect(received).toHaveLength(0);
  });
});

describe("AcpClient — ID counter incremental", () => {
  it("debería usar IDs incrementales: 1, 2, 3, ...", async () => {
    const mock = createMockAgentProcess();
    const client = new AcpClient(mock as any);

    // initialize → id: 1
    const p1 = client.initialize();
    mock.simulateMessage({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, serverInfo: {} } });
    await p1;

    // newSession → id: 2
    const p2 = client.newSession("/tmp");
    mock.simulateMessage({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } });
    await p2;

    // sendPrompt → id: 3
    const p3 = client.sendPrompt("s", "hi");
    mock.simulateMessage({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    await p3;

    const sent = mock.getSent();
    expect((sent[0] as any).id).toBe(1);
    expect((sent[1] as any).id).toBe(2);
    expect((sent[2] as any).id).toBe(3);
  });
});
