import { describe, it, expect } from "bun:test";
import { parseInputLine } from "../../scripts/tui/input.ts";

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

  // ─── /sessions ───────────────────────────────────────────────────────────────

  it("devuelve command sessions para /sessions", () => {
    expect(parseInputLine("/sessions")).toEqual({ type: "command", command: "sessions" });
  });

  it("devuelve command sessions para /SESSIONS (normalización a lowercase)", () => {
    expect(parseInputLine("/SESSIONS")).toEqual({ type: "command", command: "sessions" });
  });

  // ─── /resume ─────────────────────────────────────────────────────────────────

  it("devuelve command resume:abc12345 para /resume abc12345", () => {
    expect(parseInputLine("/resume abc12345")).toEqual({ type: "command", command: "resume:abc12345" });
  });

  it("devuelve command resume con ID en minúsculas para /resume ABC12345", () => {
    expect(parseInputLine("/resume ABC12345")).toEqual({ type: "command", command: "resume:abc12345" });
  });

  it("devuelve command resume-missing-id para /resume sin argumento (A-3)", () => {
    expect(parseInputLine("/resume")).toEqual({ type: "command", command: "resume-missing-id" });
  });

  it("devuelve command resume-missing-id para /resume con solo espacios (A-3)", () => {
    expect(parseInputLine("/resume   ")).toEqual({ type: "command", command: "resume-missing-id" });
  });
});
