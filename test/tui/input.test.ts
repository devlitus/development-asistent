import { describe, it, expect } from "bun:test";
import { parseInputLine, TuiInput } from "../../scripts/tui/input.ts";
import { TuiState } from "../../scripts/tui/state.ts";
import { TuiRenderer } from "../../scripts/tui/renderer.ts";

describe("parseInputLine", () => {
  it("devuelve empty para línea vacía", () => {
    expect(parseInputLine("")).toEqual({ type: "empty" });
    expect(parseInputLine("   ")).toEqual({ type: "empty" });
  });

  it("devuelve command quit para /quit", () => {
    expect(parseInputLine("/quit")).toEqual({ type: "command", command: "quit" });
  });

  it("devuelve command quit para /exit", () => {
    expect(parseInputLine("/exit")).toEqual({ type: "command", command: "quit" });
  });

  it("devuelve command clear para /clear", () => {
    expect(parseInputLine("/clear")).toEqual({ type: "command", command: "clear" });
  });

  it("devuelve command new-session para /new", () => {
    expect(parseInputLine("/new")).toEqual({ type: "command", command: "new-session" });
  });

  it("devuelve command help para /help", () => {
    expect(parseInputLine("/help")).toEqual({ type: "command", command: "help" });
  });

  it("devuelve command status para /status", () => {
    expect(parseInputLine("/status")).toEqual({ type: "command", command: "status" });
  });

  it("devuelve command status para /STATUS (normalización a lowercase)", () => {
    expect(parseInputLine("/STATUS")).toEqual({ type: "command", command: "status" });
  });

  it("devuelve command status para /Status (mixed case)", () => {
    expect(parseInputLine("/Status")).toEqual({ type: "command", command: "status" });
  });

  it("devuelve prompt para texto normal", () => {
    expect(parseInputLine("hola mundo")).toEqual({ type: "prompt", text: "hola mundo" });
  });

  it("devuelve prompt para comando desconocido", () => {
    expect(parseInputLine("/unknown")).toEqual({ type: "prompt", text: "/unknown" });
  });

  it("trimea espacios en texto normal", () => {
    expect(parseInputLine("  hola  ")).toEqual({ type: "prompt", text: "hola" });
  });
});

// ─── Integración: processLine → commandHandlers ───────────────────────────────

describe("TuiInput.processLine integración", () => {
  function makeTestInput() {
    const writer = { write: (_s: string) => {} };
    const renderer = new TuiRenderer(writer);
    const state = new TuiState();
    const input = new TuiInput(renderer, state);
    return { input };
  }

  it("processLine('/status') dispara commandHandlers con 'status'", () => {
    const { input } = makeTestInput();
    const received: string[] = [];
    input.onCommand((cmd) => received.push(cmd));

    input.processLine("/status");

    expect(received).toEqual(["status"]);
  });

  it("processLine('/clear') dispara commandHandlers con 'clear'", () => {
    const { input } = makeTestInput();
    const received: string[] = [];
    input.onCommand((cmd) => received.push(cmd));

    input.processLine("/clear");

    expect(received).toEqual(["clear"]);
  });

  it("processLine('/new') dispara commandHandlers con 'new-session'", () => {
    const { input } = makeTestInput();
    const received: string[] = [];
    input.onCommand((cmd) => received.push(cmd));

    input.processLine("/new");

    expect(received).toEqual(["new-session"]);
  });
});
