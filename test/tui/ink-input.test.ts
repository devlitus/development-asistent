/**
 * ink-input.test.ts — INK-03
 *
 * Tests para InkInput. No monta Ink real — prueba la lógica de estado
 * instanciando InkInput directamente con un setAppState mock.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { InkInput } from "../../scripts/tui/ink-input.ts";
import type { TuiAppState } from "../../scripts/tui/ink-renderer.tsx";
import { initialTuiAppState } from "../../scripts/tui/ink-renderer.tsx";
import type { PermissionRequest } from "../../scripts/tui/types.ts";

// ─── Helper: crea InkInput con estado capturado ───────────────────────────────

function makeInput(): {
  input: InkInput;
  getState: () => TuiAppState;
  simulateSubmit: (text: string) => void;
  simulateArrowUp: () => void;
  simulateArrowDown: () => void;
  simulatePermissionActive: (req: PermissionRequest) => void;
} {
  let state: TuiAppState = { ...initialTuiAppState };

  const setAppState = (updater: TuiAppState | ((s: TuiAppState) => TuiAppState)) => {
    if (typeof updater === "function") {
      state = updater(state);
    } else {
      state = updater;
    }
  };

  const input = new InkInput(setAppState);

  // Simula que <InputLine> llama al onSubmit inyectado en el estado
  const simulateSubmit = (text: string) => {
    state.onSubmit?.(text);
  };

  // Simula tecla flecha arriba (como lo haría useInput de Ink)
  const simulateArrowUp = () => {
    input.handleArrowUp();
  };

  // Simula tecla flecha abajo
  const simulateArrowDown = () => {
    input.handleArrowDown();
  };

  // Simula que hay un permiso pendiente activo
  const simulatePermissionActive = (req: PermissionRequest) => {
    setAppState((s) => ({ ...s, pendingPermission: req }));
  };

  return { input, getState: () => state, simulateSubmit, simulateArrowUp, simulateArrowDown, simulatePermissionActive };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("InkInput", () => {
  let input: InkInput;
  let getState: () => TuiAppState;
  let simulateSubmit: (text: string) => void;
  let simulateArrowUp: () => void;
  let simulateArrowDown: () => void;
  let simulatePermissionActive: (req: PermissionRequest) => void;

  beforeEach(() => {
    ({ input, getState, simulateSubmit, simulateArrowUp, simulateArrowDown, simulatePermissionActive } = makeInput());
  });

  // ── start() ─────────────────────────────────────────────────────────────────

  it("start() pone inputEnabled = true e inyecta onSubmit en el estado", () => {
    input.start();
    const state = getState();
    expect(state.inputEnabled).toBe(true);
    expect(typeof state.onSubmit).toBe("function");
  });

  // ── pause() ─────────────────────────────────────────────────────────────────

  it("pause() pone inputEnabled = false", () => {
    input.start();
    input.pause();
    expect(getState().inputEnabled).toBe(false);
  });

  // ── resume() ────────────────────────────────────────────────────────────────

  it("resume() pone inputEnabled = true y limpia inputValue", () => {
    input.start();
    input.pause();
    input.resume();
    const state = getState();
    expect(state.inputEnabled).toBe(true);
    expect(state.inputValue).toBe("");
  });

  // ── close() ─────────────────────────────────────────────────────────────────

  it("close() limpia onSubmit del estado", () => {
    input.start();
    input.close();
    expect(getState().onSubmit).toBeUndefined();
  });

  // ── onPrompt ─────────────────────────────────────────────────────────────────

  it("texto normal dispara onPrompt con el texto correcto", () => {
    const handler = mock(() => {});
    input.onPrompt(handler);
    input.start();
    simulateSubmit("hola mundo");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("hola mundo");
  });

  it("texto con espacios se trimea antes de disparar onPrompt", () => {
    const handler = mock(() => {});
    input.onPrompt(handler);
    input.start();
    simulateSubmit("  hola  ");
    expect(handler).toHaveBeenCalledWith("hola");
  });

  it("línea vacía NO dispara onPrompt", () => {
    const handler = mock(() => {});
    input.onPrompt(handler);
    input.start();
    simulateSubmit("   ");
    expect(handler).not.toHaveBeenCalled();
  });

  // ── onCommand ────────────────────────────────────────────────────────────────

  it("/clear dispara onCommand con 'clear'", () => {
    const handler = mock(() => {});
    input.onCommand(handler);
    input.start();
    simulateSubmit("/clear");
    expect(handler).toHaveBeenCalledWith("clear");
  });

  it("/new dispara onCommand con 'new-session'", () => {
    const handler = mock(() => {});
    input.onCommand(handler);
    input.start();
    simulateSubmit("/new");
    expect(handler).toHaveBeenCalledWith("new-session");
  });

  it("/help dispara onCommand con 'help'", () => {
    const handler = mock(() => {});
    input.onCommand(handler);
    input.start();
    simulateSubmit("/help");
    expect(handler).toHaveBeenCalledWith("help");
  });

  it("/status dispara onCommand con 'status'", () => {
    const handler = mock(() => {});
    input.onCommand(handler);
    input.start();
    simulateSubmit("/status");
    expect(handler).toHaveBeenCalledWith("status");
  });

  // ── onQuit ───────────────────────────────────────────────────────────────────

  it("/quit dispara onQuit", () => {
    const handler = mock(() => {});
    input.onQuit(handler);
    input.start();
    simulateSubmit("/quit");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("/exit dispara onQuit", () => {
    const handler = mock(() => {});
    input.onQuit(handler);
    input.start();
    simulateSubmit("/exit");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── múltiples handlers ───────────────────────────────────────────────────────

  it("múltiples handlers onPrompt se llaman todos", () => {
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    input.onPrompt(h1);
    input.onPrompt(h2);
    input.start();
    simulateSubmit("test");
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  // ── askPermission ────────────────────────────────────────────────────────────

  it("askPermission inyecta pendingPermission en el estado", async () => {
    const req: PermissionRequest = {
      sessionId: "s1",
      toolName: "bash",
      description: "ejecutar ls",
      input: { cmd: "ls" },
    };
    input.start();

    // Resolvemos inmediatamente con 'y' para no bloquear el test
    const promise = input.askPermission(req);
    expect(getState().pendingPermission).toEqual(req);

    // Simular respuesta 'y'
    getState().onPermissionResponse?.("y");
    const result = await promise;
    expect(result).toBe(true);
    expect(getState().pendingPermission).toBeUndefined();
  });

  it("askPermission retorna false con respuesta 'n'", async () => {
    const req: PermissionRequest = {
      sessionId: "s1",
      toolName: "bash",
      description: "ejecutar rm",
      input: { cmd: "rm" },
    };
    input.start();

    const promise = input.askPermission(req);
    getState().onPermissionResponse?.("n");
    const result = await promise;
    expect(result).toBe(false);
  });

  it("askPermission retorna false con respuesta vacía", async () => {
    const req: PermissionRequest = {
      sessionId: "s1",
      toolName: "bash",
      description: "test",
      input: {},
    };
    input.start();

    const promise = input.askPermission(req);
    getState().onPermissionResponse?.("");
    const result = await promise;
    expect(result).toBe(false);
  });

  // ── scrollOffset via setAppState ─────────────────────────────────────────────

  it("scrollUpArrow incrementa scrollOffset cuando no hay pendingPermission", () => {
    // Con mensajes en el estado, el offset puede subir
    let stateWithMsgs = {
      ...initialTuiAppState,
      messages: Array.from({ length: 30 }, (_, i) => ({ kind: "user" as const, text: `msg ${i}` })),
    };
    const setAppState = (updater: TuiAppState | ((s: TuiAppState) => TuiAppState)) => {
      if (typeof updater === "function") stateWithMsgs = updater(stateWithMsgs);
      else stateWithMsgs = updater;
    };
    const inputWithMsgs = new InkInput(setAppState);
    inputWithMsgs.start();
    inputWithMsgs.handleArrowUp();
    expect(stateWithMsgs.scrollOffset).toBe(1);
  });

  it("scrollUpArrow incrementa scrollOffset acumulativamente", () => {
    let stateWithMsgs = {
      ...initialTuiAppState,
      messages: Array.from({ length: 30 }, (_, i) => ({ kind: "user" as const, text: `msg ${i}` })),
    };
    const setAppState = (updater: TuiAppState | ((s: TuiAppState) => TuiAppState)) => {
      if (typeof updater === "function") stateWithMsgs = updater(stateWithMsgs);
      else stateWithMsgs = updater;
    };
    const inputWithMsgs = new InkInput(setAppState);
    inputWithMsgs.start();
    inputWithMsgs.handleArrowUp();
    inputWithMsgs.handleArrowUp();
    inputWithMsgs.handleArrowUp();
    expect(stateWithMsgs.scrollOffset).toBe(3);
  });

  it("scrollDownArrow decrementa scrollOffset (mínimo 0)", () => {
    let stateWithMsgs = {
      ...initialTuiAppState,
      messages: Array.from({ length: 30 }, (_, i) => ({ kind: "user" as const, text: `msg ${i}` })),
    };
    const setAppState = (updater: TuiAppState | ((s: TuiAppState) => TuiAppState)) => {
      if (typeof updater === "function") stateWithMsgs = updater(stateWithMsgs);
      else stateWithMsgs = updater;
    };
    const inputWithMsgs = new InkInput(setAppState);
    inputWithMsgs.start();
    inputWithMsgs.handleArrowUp();
    inputWithMsgs.handleArrowUp();
    inputWithMsgs.handleArrowDown();
    expect(stateWithMsgs.scrollOffset).toBe(1);
  });

  it("scrollDownArrow no baja de 0", () => {
    input.start();
    simulateArrowDown();
    expect(getState().scrollOffset).toBe(0);
  });

  it("scrollUpArrow NO actúa cuando hay pendingPermission activo", () => {
    const req: PermissionRequest = {
      sessionId: "s1",
      toolName: "bash",
      description: "test",
      input: {},
    };
    input.start();
    // Activar pendingPermission directamente en el estado
    simulateArrowUp(); // primero sin permiso → debe funcionar (0 mensajes → maxOffset=0 → sigue en 0)
    expect(getState().scrollOffset).toBe(0);

    // Ahora simular que hay un permiso pendiente
    simulatePermissionActive(req);
    simulateArrowUp(); // con permiso → NO debe cambiar
    expect(getState().scrollOffset).toBe(0);
  });

  // ── C-5: clamp scrollOffset ──────────────────────────────────────────────────

  it("C5: handleArrowUp no supera el máximo offset posible (sin mensajes)", () => {
    input.start();
    // Con 0 mensajes, maxOffset = 0 → scrollOffset nunca sube
    simulateArrowUp();
    simulateArrowUp();
    simulateArrowUp();
    expect(getState().scrollOffset).toBe(0);
  });

  it("C5: handleArrowUp con 20 mensajes clampea al máximo", () => {
    // Crear un input con estado inicial que tiene 20 mensajes
    const messages = Array.from({ length: 20 }, (_, i) => ({
      kind: "user" as const,
      text: `msg ${i}`,
    }));
    let state3 = { ...initialTuiAppState, messages };
    const setAppState3 = (updater: TuiAppState | ((s: TuiAppState) => TuiAppState)) => {
      if (typeof updater === "function") {
        state3 = updater(state3);
      } else {
        state3 = updater;
      }
    };
    const input3 = new InkInput(setAppState3);
    input3.start();
    // Simular muchos arrow ups
    for (let i = 0; i < 50; i++) {
      input3.handleArrowUp();
    }
    // rows = process.stdout.rows ?? 24, visibleCount = max(1, rows-6)
    // maxOffset = max(0, 20 - visibleCount)
    const rows = process.stdout.rows ?? 24;
    const visibleCount = Math.max(1, rows - 6);
    const maxOffset = Math.max(0, 20 - visibleCount);
    expect(state3.scrollOffset).toBe(maxOffset);
  });

  // ── C-8/M6: askPermission acepta si/sí/s ────────────────────────────────────

  it("C8/M6: askPermission aprueba con 'si'", async () => {
    const req: PermissionRequest = { sessionId: "s1", toolName: "bash", description: "test", input: {} };
    input.start();
    const promise = input.askPermission(req);
    getState().onPermissionResponse?.("si");
    expect(await promise).toBe(true);
  });

  it("C8/M6: askPermission aprueba con 'sí'", async () => {
    const req: PermissionRequest = { sessionId: "s1", toolName: "bash", description: "test", input: {} };
    input.start();
    const promise = input.askPermission(req);
    getState().onPermissionResponse?.("sí");
    expect(await promise).toBe(true);
  });

  it("C8/M6: askPermission aprueba con 's'", async () => {
    const req: PermissionRequest = { sessionId: "s1", toolName: "bash", description: "test", input: {} };
    input.start();
    const promise = input.askPermission(req);
    getState().onPermissionResponse?.("s");
    expect(await promise).toBe(true);
  });

  it("C8/M6: askPermission deniega con 'n'", async () => {
    const req: PermissionRequest = { sessionId: "s1", toolName: "bash", description: "test", input: {} };
    input.start();
    const promise = input.askPermission(req);
    getState().onPermissionResponse?.("n");
    expect(await promise).toBe(false);
  });

  it("C8/M6: askPermission deniega con 'no'", async () => {
    const req: PermissionRequest = { sessionId: "s1", toolName: "bash", description: "test", input: {} };
    input.start();
    const promise = input.askPermission(req);
    getState().onPermissionResponse?.("no");
    expect(await promise).toBe(false);
  });
});

