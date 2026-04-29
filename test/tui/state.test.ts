import { describe, it, expect } from "bun:test";
import { TuiState } from "../../scripts/tui/state.ts";

describe("TuiState", () => {
  it("inicia con status 'connecting'", () => {
    const state = new TuiState();
    expect(state.status).toBe("connecting");
  });

  it("inicia con messages vacío", () => {
    const state = new TuiState();
    expect(state.messages).toHaveLength(0);
  });

  it("messageCount es 0 inicialmente", () => {
    const state = new TuiState();
    expect(state.messageCount).toBe(0);
  });

  it("messageCount es 1 después de addMessage", () => {
    const state = new TuiState();
    state.addMessage({ role: "user", content: "hola", timestamp: Date.now() });
    expect(state.messageCount).toBe(1);
  });

  it("messageCount refleja múltiples mensajes", () => {
    const state = new TuiState();
    state.addMessage({ role: "user", content: "uno", timestamp: Date.now() });
    state.addMessage({ role: "agent", content: "dos", timestamp: Date.now() });
    state.addMessage({ role: "user", content: "tres", timestamp: Date.now() });
    expect(state.messageCount).toBe(3);
  });

  it("messageCount incluye mensajes flusheados del stream", () => {
    const state = new TuiState();
    state.appendStream("chunk1");
    state.appendStream("chunk2");
    state.flushStream();
    expect(state.messageCount).toBe(1);
  });

  it("setStatus cambia el status", () => {
    const state = new TuiState();
    state.setStatus("idle");
    expect(state.status).toBe("idle");
  });

  it("currentStreamBuffer acumula chunks", () => {
    const state = new TuiState();
    state.appendStream("hola ");
    state.appendStream("mundo");
    expect(state.currentStreamBuffer).toBe("hola mundo");
  });

  it("flushStream limpia el buffer", () => {
    const state = new TuiState();
    state.appendStream("texto");
    state.flushStream();
    expect(state.currentStreamBuffer).toBe("");
  });

  it("flushStream no añade mensaje si buffer vacío", () => {
    const state = new TuiState();
    state.flushStream();
    expect(state.messageCount).toBe(0);
  });
});
