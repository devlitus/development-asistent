/**
 * ink-renderer.test.ts — INK-02
 *
 * Tests para InkRenderer y los tipos TuiAppState / DisplayMessage.
 * No renderiza Ink real (evita stdout) — prueba solo la lógica de estado.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { TuiAppState, DisplayMessage } from "../../scripts/tui/ink-renderer.tsx";
import { InkRenderer } from "../../scripts/tui/ink-renderer.tsx";
import type { PermissionRequest } from "../../scripts/tui/types.ts";

// ─── Helper: crea un InkRenderer con setState capturado ──────────────────────

function makeRenderer(): { renderer: InkRenderer; getState: () => TuiAppState } {
  let state: TuiAppState = {
    version: "",
    status: "connecting",
    messages: [],
    streamBuffer: "",
    isThinking: false,
    inputValue: "",
    inputEnabled: true,
  };

  const setAppState = (updater: TuiAppState | ((s: TuiAppState) => TuiAppState)) => {
    if (typeof updater === "function") {
      state = updater(state);
    } else {
      state = updater;
    }
  };

  const renderer = new InkRenderer(setAppState);
  return { renderer, getState: () => state };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("InkRenderer", () => {
  let renderer: InkRenderer;
  let getState: () => TuiAppState;

  beforeEach(() => {
    ({ renderer, getState } = makeRenderer());
  });

  // ── renderHeader ────────────────────────────────────────────────────────────

  it("renderHeader actualiza state.version", () => {
    renderer.renderHeader("1.2.3");
    expect(getState().version).toBe("1.2.3");
  });

  // ── renderStatusBar ─────────────────────────────────────────────────────────

  it("renderStatusBar actualiza state.status", () => {
    renderer.renderStatusBar("idle");
    expect(getState().status).toBe("idle");

    renderer.renderStatusBar("thinking");
    expect(getState().status).toBe("thinking");
  });

  // ── renderUserMessage ───────────────────────────────────────────────────────

  it("renderUserMessage añade mensaje {kind: 'user'}", () => {
    renderer.renderUserMessage("hola mundo");
    const msgs = getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ kind: "user", text: "hola mundo" });
  });

  // ── renderAgentMessageStart / renderStreamChunk / renderAgentMessageEnd ─────

  it("renderAgentMessageStart limpia streamBuffer", () => {
    renderer.renderStreamChunk("previo");
    renderer.renderAgentMessageStart();
    expect(getState().streamBuffer).toBe("");
  });

  it("renderStreamChunk acumula en streamBuffer", async () => {
    renderer.renderAgentMessageStart();
    renderer.renderStreamChunk("hola ");
    renderer.renderStreamChunk("mundo");
    // Batching delay ~16ms
    await new Promise((r) => setTimeout(r, 30));
    expect(getState().streamBuffer).toBe("hola mundo");
  });

  it("renderAgentMessageEnd flush buffer → añade mensaje agent", () => {
    renderer.renderAgentMessageStart();
    renderer.renderStreamChunk("respuesta completa");
    renderer.renderAgentMessageEnd();

    const state = getState();
    expect(state.streamBuffer).toBe("");
    const agentMsg = state.messages.find((m) => m.kind === "agent") as Extract<DisplayMessage, { kind: "agent" }> | undefined;
    expect(agentMsg).toBeDefined();
    expect(agentMsg?.text).toBe("respuesta completa");
  });

  it("renderAgentMessageEnd con buffer vacío NO añade mensaje vacío", () => {
    renderer.renderAgentMessageStart();
    // no chunks
    renderer.renderAgentMessageEnd();

    const msgs = getState().messages.filter((m) => m.kind === "agent");
    expect(msgs).toHaveLength(0);
  });

  // ── renderSystemMessage ─────────────────────────────────────────────────────

  it("renderSystemMessage añade mensaje {kind: 'system'}", () => {
    renderer.renderSystemMessage("sistema ok");
    const msgs = getState().messages;
    expect(msgs[0]).toEqual({ kind: "system", text: "sistema ok" });
  });

  // ── renderError ─────────────────────────────────────────────────────────────

  it("renderError añade mensaje {kind: 'error'}", () => {
    renderer.renderError("algo falló");
    const msgs = getState().messages;
    expect(msgs[0]).toEqual({ kind: "error", text: "algo falló" });
  });

  // ── renderPermissionRequest ─────────────────────────────────────────────────

  it("renderPermissionRequest añade mensaje {kind: 'permission'}", () => {
    const req: PermissionRequest = {
      sessionId: "s1",
      toolName: "bash",
      description: "ejecutar comando",
      input: { cmd: "ls" },
    };
    renderer.renderPermissionRequest(req);
    const msgs = getState().messages;
    expect(msgs[0]).toEqual({ kind: "permission", req });
  });

  // ── renderTurnSeparator ─────────────────────────────────────────────────────

  it("renderTurnSeparator añade {kind: 'separator'}", () => {
    renderer.renderTurnSeparator();
    const msgs = getState().messages;
    expect(msgs[0]).toEqual({ kind: "separator" });
  });

  // ── startSpinner / stopSpinner ──────────────────────────────────────────────

  it("startSpinner pone isThinking = true", () => {
    renderer.startSpinner();
    expect(getState().isThinking).toBe(true);
  });

  it("startSpinner con label pone isThinking = true", () => {
    renderer.startSpinner("cargando...");
    expect(getState().isThinking).toBe(true);
  });

  it("stopSpinner pone isThinking = false", () => {
    renderer.startSpinner();
    renderer.stopSpinner();
    expect(getState().isThinking).toBe(false);
  });

  // ── renderRoutingInfo ───────────────────────────────────────────────────────

  it("renderRoutingInfo añade {kind: 'routing', agentName}", () => {
    renderer.renderRoutingInfo("code-agent");
    const msgs = getState().messages;
    expect(msgs[0]).toEqual({ kind: "routing", agentName: "code-agent" });
  });

  // ── renderToolCall ──────────────────────────────────────────────────────────

  it("renderToolCall añade {kind: 'tool_call', name, input}", () => {
    renderer.renderToolCall("bash", { cmd: "ls" });
    const msgs = getState().messages;
    expect(msgs[0]).toEqual({ kind: "tool_call", name: "bash", input: { cmd: "ls" } });
  });

  // ── renderToolResult ────────────────────────────────────────────────────────

  it("renderToolResult añade {kind: 'tool_result', name, status}", () => {
    renderer.renderToolResult("bash", "completed");
    const msgs = getState().messages;
    expect(msgs[0]).toEqual({ kind: "tool_result", name: "bash", status: "completed" });
  });

  // ── Acumulación de múltiples mensajes ───────────────────────────────────────

  // ── clearMessages ───────────────────────────────────────────────────────────

  it("clearMessages vacía messages y streamBuffer", () => {
    renderer.renderUserMessage("hola");
    renderer.renderStreamChunk("parcial");
    renderer.clearMessages();

    const state = getState();
    expect(state.messages).toHaveLength(0);
    expect(state.streamBuffer).toBe("");
  });

  it("clearMessages no afecta version ni status", () => {
    renderer.renderHeader("3.0.0");
    renderer.renderStatusBar("thinking");
    renderer.renderUserMessage("hola");
    renderer.clearMessages();

    const state = getState();
    expect(state.version).toBe("3.0.0");
    expect(state.status).toBe("thinking");
  });
});
