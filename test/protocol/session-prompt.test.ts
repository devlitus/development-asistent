/**
 * Tests for session-prompt handler — DX-02 tool_call markers.
 *
 * Verifies that tool_call events emit \x00TOOL_CALL\x00 and \x00TOOL_RESULT\x00
 * markers instead of the old "\n⚙ [name]" format.
 */

import { describe, it, expect } from "bun:test";
import { handleSessionPrompt } from "../../src/protocol/handlers/session-prompt.ts";
import { SessionStore } from "../../src/protocol/session-store.ts";
import type { StdioTransport } from "../../src/transport/stdio.ts";
import type { AgentEvent } from "../../src/orchestrator/types.ts";
import type { SessionId } from "../../src/types/persistence.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTransport() {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const transport = {
    sendNotification(method: string, params: unknown) {
      notifications.push({ method, params });
    },
    sendResponse: () => {},
  } as unknown as StdioTransport;
  return { transport, notifications };
}

function makeOrchestrator(events: AgentEvent[]) {
  return {
    dispatch: async function* (_sessionId: SessionId, _prompt: string) {
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as import("../../src/orchestrator/index.ts").Orchestrator;
}

function makeSessionStore() {
  const store = new SessionStore();
  const session = store.create("/tmp/test");
  return { store, sessionId: session.id };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("session-prompt tool_call markers (DX-02)", () => {
  it("in_progress emits chunk with \\x00TOOL_CALL\\x00 prefix", async () => {
    const { store, sessionId } = makeSessionStore();
    const { transport, notifications } = makeTransport();

    const orchestrator = makeOrchestrator([
      { type: "tool_call", id: "tc1", name: "read_file", arguments: {}, status: "in_progress" },
      { type: "done", success: true },
    ]);

    await handleSessionPrompt(
      { sessionId, prompt: [{ type: "text", text: "test" } as never] },
      store,
      transport,
      1,
      undefined,
      orchestrator,
    );

    const chunks = notifications
      .filter((n) => n.method === "session/update")
      .map((n) => (n.params as { update: { content: { text: string } } }).update.content.text);

    expect(chunks.some((t) => t.startsWith("\x00TOOL_CALL\x00") && t.includes("read_file"))).toBe(true);
  });

  it("completed emits chunk with \\x00TOOL_RESULT\\x00...\\x00completed", async () => {
    const { store, sessionId } = makeSessionStore();
    const { transport, notifications } = makeTransport();

    const orchestrator = makeOrchestrator([
      { type: "tool_call", id: "tc1", name: "read_file", arguments: {}, status: "completed" },
      { type: "done", success: true },
    ]);

    await handleSessionPrompt(
      { sessionId, prompt: [{ type: "text", text: "test" } as never] },
      store,
      transport,
      1,
      undefined,
      orchestrator,
    );

    const chunks = notifications
      .filter((n) => n.method === "session/update")
      .map((n) => (n.params as { update: { content: { text: string } } }).update.content.text);

    expect(chunks.some((t) => t.startsWith("\x00TOOL_RESULT\x00") && t.includes("read_file") && t.endsWith("\x00completed"))).toBe(true);
  });

  it("failed emits chunk with \\x00TOOL_RESULT\\x00...\\x00failed", async () => {
    const { store, sessionId } = makeSessionStore();
    const { transport, notifications } = makeTransport();

    const orchestrator = makeOrchestrator([
      { type: "tool_call", id: "tc1", name: "read_file", arguments: {}, status: "failed" },
      { type: "done", success: false },
    ]);

    await handleSessionPrompt(
      { sessionId, prompt: [{ type: "text", text: "test" } as never] },
      store,
      transport,
      1,
      undefined,
      orchestrator,
    );

    const chunks = notifications
      .filter((n) => n.method === "session/update")
      .map((n) => (n.params as { update: { content: { text: string } } }).update.content.text);

    expect(chunks.some((t) => t.startsWith("\x00TOOL_RESULT\x00") && t.includes("read_file") && t.endsWith("\x00failed"))).toBe(true);
  });
});
