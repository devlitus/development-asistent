/**
 * Tests para ink-renderer — Sprint B UX
 *
 * Cubre:
 *   A8 — aviso de truncado de historial
 *   M4 — updateSpinnerLabel
 *
 * Framework: bun:test
 */

import { describe, it, expect, jest } from "bun:test";
import { InkRenderer, initialTuiAppState } from "../tui/ink-renderer.tsx";
import type { TuiAppState, SetAppState } from "../tui/ink-renderer.tsx";

// Helper: crea un InkRenderer con setState capturado
function createRenderer() {
  let state: TuiAppState = { ...initialTuiAppState };
  const setState: SetAppState = jest.fn((updater) => {
    if (typeof updater === "function") {
      state = updater(state);
    } else {
      state = updater;
    }
  });
  const renderer = new InkRenderer(setState);
  return { renderer, getState: () => state, setState };
}

// ─── A8: aviso de truncado ────────────────────────────────────────────────────

describe("InkRenderer — A8: truncado de historial", () => {
  it("no añade aviso si hay menos de MAX_MESSAGES mensajes", () => {
    const { renderer, getState } = createRenderer();
    renderer.renderSystemMessage("hola");
    const msgs = getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toEqual({ kind: "system", text: "hola" });
  });

  it("añade aviso de truncado al superar MAX_MESSAGES", () => {
    const { renderer, getState } = createRenderer();
    // Llenar hasta MAX_MESSAGES (200)
    for (let i = 0; i < 200; i++) {
      renderer.renderSystemMessage(`msg ${i}`);
    }
    // El 201º mensaje debe disparar el truncado
    renderer.renderSystemMessage("mensaje nuevo");
    const msgs = getState().messages;
    // El primer mensaje debe ser el aviso de truncado
    expect(msgs[0]?.kind).toBe("system");
    expect(msgs[0]?.text).toContain("Historial truncado");
    expect(msgs[0]?.text).toContain("200");
  });

  it("el array nunca supera MAX_MESSAGES tras truncado", () => {
    const { renderer, getState } = createRenderer();
    for (let i = 0; i < 205; i++) {
      renderer.renderSystemMessage(`msg ${i}`);
    }
    expect(getState().messages.length).toBeLessThanOrEqual(200);
  });

  it("el aviso solo aparece una vez por truncado (no en cada mensaje posterior)", () => {
    const { renderer, getState } = createRenderer();
    for (let i = 0; i < 200; i++) {
      renderer.renderSystemMessage(`msg ${i}`);
    }
    renderer.renderSystemMessage("extra 1");
    renderer.renderSystemMessage("extra 2");
    const msgs = getState().messages;
    const notices = msgs.filter(
      (m) => m.kind === "system" && "text" in m && (m as { text: string }).text.includes("Historial truncado")
    );
    // Solo debe haber un aviso visible (el más reciente)
    expect(notices.length).toBe(1);
  });
});

// ─── M4: updateSpinnerLabel ───────────────────────────────────────────────────

describe("InkRenderer — M4: updateSpinnerLabel", () => {
  it("updateSpinnerLabel actualiza spinnerLabel en el estado", () => {
    const { renderer, getState } = createRenderer();
    renderer.updateSpinnerLabel("Pensando... (30s)");
    expect(getState().spinnerLabel).toBe("Pensando... (30s)");
  });

  it("updateSpinnerLabel existe como método en InkRenderer", () => {
    const { renderer } = createRenderer();
    expect(typeof renderer.updateSpinnerLabel).toBe("function");
  });
});
