/**
 * Tests for TuiState — TUI-01
 *
 * All tests are purely synchronous (no I/O).
 * Uses bun:test (Jest-compatible syntax).
 */

import { describe, it, expect } from "bun:test";
import { TuiState } from "../tui/state.ts";
import type { TuiMessage, PermissionRequest, TuiStatus } from "../tui/types.ts";

// ─── TuiStatus transitions ────────────────────────────────────────────────────

describe("TuiState.setStatus", () => {
  it("should start with status 'connecting'", () => {
    const state = new TuiState();
    expect(state.status).toBe("connecting");
  });

  it("should transition connecting → idle via setStatus", () => {
    const state = new TuiState();
    state.setStatus("idle");
    expect(state.status).toBe("idle");
  });

  it("should transition idle → thinking", () => {
    const state = new TuiState();
    state.setStatus("idle");
    state.setStatus("thinking");
    expect(state.status).toBe("thinking");
  });

  it("should transition thinking → waiting_permission", () => {
    const state = new TuiState();
    state.setStatus("thinking");
    state.setStatus("waiting_permission");
    expect(state.status).toBe("waiting_permission");
  });

  it("should transition any state → error", () => {
    const statuses: TuiStatus[] = ["connecting", "idle", "thinking", "waiting_permission"];
    for (const s of statuses) {
      const state = new TuiState();
      state.setStatus(s);
      state.setStatus("error");
      expect(state.status).toBe("error");
    }
  });

  it("should transition error → idle (user types /new)", () => {
    const state = new TuiState();
    state.setStatus("error");
    state.setStatus("idle");
    expect(state.status).toBe("idle");
  });
});

// ─── addMessage ───────────────────────────────────────────────────────────────

describe("TuiState.addMessage", () => {
  it("should start with empty messages array", () => {
    const state = new TuiState();
    expect(state.messages).toHaveLength(0);
  });

  it("should add a message to the array", () => {
    const state = new TuiState();
    const msg: TuiMessage = {
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    };
    state.addMessage(msg);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(msg);
  });

  it("should add multiple messages in order", () => {
    const state = new TuiState();
    const msg1: TuiMessage = { role: "user", content: "First", timestamp: 1000 };
    const msg2: TuiMessage = { role: "agent", content: "Second", timestamp: 2000 };
    state.addMessage(msg1);
    state.addMessage(msg2);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual(msg1);
    expect(state.messages[1]).toEqual(msg2);
  });

  it("should support tool messages with toolName", () => {
    const state = new TuiState();
    const msg: TuiMessage = {
      role: "tool",
      content: "result",
      timestamp: 1000,
      toolName: "read_file",
    };
    state.addMessage(msg);
    expect(state.messages[0]?.toolName).toBe("read_file");
  });

  it("messages getter returns a readonly view — TypeScript type prevents direct mutation", () => {
    const state = new TuiState();
    state.addMessage({ role: "user", content: "Hello", timestamp: 1000 });

    // The getter returns readonly TuiMessage[] — same reference, no copy
    const msgs1 = state.messages;
    const msgs2 = state.messages;

    // Both calls return the same underlying reference (O(1), no copy)
    expect(msgs1).toBe(msgs2);

    // Length is correct
    expect(msgs1).toHaveLength(1);
  });
});

// ─── appendStream / flushStream ───────────────────────────────────────────────

describe("TuiState stream buffer", () => {
  it("should start with empty currentStreamBuffer", () => {
    const state = new TuiState();
    expect(state.currentStreamBuffer).toBe("");
  });

  it("appendStream should accumulate text", () => {
    const state = new TuiState();
    state.appendStream("Hello");
    state.appendStream(", ");
    state.appendStream("world");
    expect(state.currentStreamBuffer).toBe("Hello, world");
  });

  it("flushStream should clear the buffer", () => {
    const state = new TuiState();
    state.appendStream("some text");
    state.flushStream();
    expect(state.currentStreamBuffer).toBe("");
  });

  it("flushStream should add an agent message with the buffered content", () => {
    const state = new TuiState();
    state.appendStream("Agent response here");
    state.flushStream();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe("agent");
    expect(state.messages[0]?.content).toBe("Agent response here");
  });

  it("flushStream should set a valid timestamp on the flushed message", () => {
    const state = new TuiState();
    const before = Date.now();
    state.appendStream("text");
    state.flushStream();
    const after = Date.now();
    const ts = state.messages[0]?.timestamp ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("flushStream with empty buffer should NOT add a message", () => {
    const state = new TuiState();
    state.flushStream();
    expect(state.messages).toHaveLength(0);
  });
});

// ─── pendingPermission ────────────────────────────────────────────────────────

describe("TuiState.pendingPermission", () => {
  it("should start with null pendingPermission", () => {
    const state = new TuiState();
    expect(state.pendingPermission).toBeNull();
  });

  it("setPendingPermission should store the request", () => {
    const state = new TuiState();
    const req: PermissionRequest = {
      sessionId: "sess-1",
      toolName: "bash",
      description: "Run a shell command",
      input: { command: "ls -la" },
    };
    state.setPendingPermission(req);
    expect(state.pendingPermission).toEqual(req);
  });

  it("clearPendingPermission should reset to null", () => {
    const state = new TuiState();
    const req: PermissionRequest = {
      sessionId: "sess-1",
      toolName: "bash",
      description: "Run a shell command",
      input: { command: "ls -la" },
    };
    state.setPendingPermission(req);
    state.clearPendingPermission();
    expect(state.pendingPermission).toBeNull();
  });

  it("setPendingPermission should replace an existing request", () => {
    const state = new TuiState();
    const req1: PermissionRequest = {
      sessionId: "sess-1",
      toolName: "bash",
      description: "First",
      input: null,
    };
    const req2: PermissionRequest = {
      sessionId: "sess-1",
      toolName: "write_file",
      description: "Second",
      input: { path: "/tmp/x" },
    };
    state.setPendingPermission(req1);
    state.setPendingPermission(req2);
    expect(state.pendingPermission?.toolName).toBe("write_file");
  });
});
