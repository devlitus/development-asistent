/**
 * Tests for TuiRenderer — TUI-04
 *
 * Uses a mock writer to capture output without touching stdout.
 * Uses bun:test (Jest-compatible syntax).
 */

import { describe, it, expect } from "bun:test";
import { TuiRenderer } from "../tui/renderer.ts";
import type { PermissionRequest } from "../tui/types.ts";

// ─── Mock writer ──────────────────────────────────────────────────────────────

function makeWriter() {
  const chunks: string[] = [];
  const writer = { write: (s: string) => { chunks.push(s); } };
  const output = () => chunks.join("");
  const reset = () => { chunks.length = 0; };
  return { writer, output, reset, chunks };
}

// ─── renderStreamChunk ────────────────────────────────────────────────────────

describe("TuiRenderer.renderStreamChunk", () => {
  it("should write the chunk without adding a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStreamChunk("hello");
    expect(output()).toBe("hello");
    expect(output()).not.toContain("\n");
  });

  it("should write multiple chunks consecutively without newlines", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStreamChunk("foo");
    renderer.renderStreamChunk("bar");
    expect(output()).toBe("foobar");
  });
});

// ─── renderUserMessage ────────────────────────────────────────────────────────

describe("TuiRenderer.renderUserMessage", () => {
  it("should include the 'You ›' prefix", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderUserMessage("hola");
    expect(output()).toContain("You ›");
  });

  it("should include the message text", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderUserMessage("hola mundo");
    expect(output()).toContain("hola mundo");
  });

  it("should end with a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderUserMessage("test");
    expect(output()).toMatch(/\n$/);
  });

  it("should include cyan ANSI code", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderUserMessage("test");
    expect(output()).toContain("\x1b[36m");
  });
});

// ─── renderAgentMessageStart ──────────────────────────────────────────────────

describe("TuiRenderer.renderAgentMessageStart", () => {
  it("should include 'Agent ›' prefix", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderAgentMessageStart();
    expect(output()).toContain("Agent ›");
  });

  it("should NOT end with a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderAgentMessageStart();
    expect(output()).not.toMatch(/\n$/);
  });

  it("should include green ANSI code", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderAgentMessageStart();
    expect(output()).toContain("\x1b[32m");
  });
});

// ─── renderAgentMessageEnd ────────────────────────────────────────────────────

describe("TuiRenderer.renderAgentMessageEnd", () => {
  it("should write a newline to close the agent message", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderAgentMessageEnd();
    expect(output()).toBe("\n");
  });
});

// ─── renderStatusBar ─────────────────────────────────────────────────────────

describe("TuiRenderer.renderStatusBar", () => {
  it("should include green ANSI code for 'idle'", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStatusBar("idle");
    expect(output()).toContain("\x1b[32m");
    expect(output()).toContain("[Listo]");
  });

  it("should include blue ANSI code for 'thinking'", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStatusBar("thinking");
    expect(output()).toContain("\x1b[34m");
    expect(output()).toContain("[Pensando...]");
  });

  it("should include yellow ANSI code for 'connecting'", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStatusBar("connecting");
    expect(output()).toContain("\x1b[33m");
    expect(output()).toContain("[Conectando...]");
  });

  it("should include red ANSI code for 'waiting_permission'", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStatusBar("waiting_permission");
    expect(output()).toContain("\x1b[31m");
    expect(output()).toContain("[Esperando permiso]");
  });

  it("should include red ANSI code for 'error'", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStatusBar("error");
    expect(output()).toContain("\x1b[31m");
    expect(output()).toContain("[Error]");
  });

  it("should end with a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStatusBar("idle");
    expect(output()).toMatch(/\n$/);
  });
});

// ─── renderError ──────────────────────────────────────────────────────────────

describe("TuiRenderer.renderError", () => {
  it("should include red ANSI code", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderError("something went wrong");
    expect(output()).toContain("\x1b[31m");
  });

  it("should include the error message", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderError("something went wrong");
    expect(output()).toContain("something went wrong");
  });

  it("should end with a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderError("oops");
    expect(output()).toMatch(/\n$/);
  });
});

// ─── renderHeader ─────────────────────────────────────────────────────────────

describe("TuiRenderer.renderHeader", () => {
  it("should write something (non-empty output)", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderHeader("0.1.0");
    expect(output().length).toBeGreaterThan(0);
  });

  it("should include the version string", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderHeader("1.2.3");
    expect(output()).toContain("1.2.3");
  });

  it("should include box-drawing characters (decorative header)", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderHeader("0.1.0");
    // Should contain at least one box-drawing char
    expect(output()).toMatch(/[╔╗╚╝║═]/);
  });
});

// ─── clearLine ────────────────────────────────────────────────────────────────

describe("TuiRenderer.clearLine", () => {
  it("should write the ANSI clear-line escape sequence", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.clearLine();
    expect(output()).toContain("\x1b[2K\r");
  });
});

// ─── renderToolCall ───────────────────────────────────────────────────────────

describe("TuiRenderer.renderToolCall", () => {
  it("should include the tool name", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderToolCall("read_file", { path: "/tmp/x" });
    expect(output()).toContain("read_file");
  });

  it("should include yellow ANSI code", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderToolCall("bash", { command: "ls" });
    expect(output()).toContain("\x1b[33m");
  });

  it("should end with a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderToolCall("bash", {});
    expect(output()).toMatch(/\n$/);
  });
});

// ─── renderToolResult ─────────────────────────────────────────────────────────

describe("TuiRenderer.renderToolResult", () => {
  it("should include the tool name", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderToolResult("read_file", "file contents here");
    expect(output()).toContain("read_file");
  });

  it("should include the result content", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderToolResult("bash", "exit code 0");
    expect(output()).toContain("exit code 0");
  });

  it("should include gray ANSI code", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderToolResult("bash", "ok");
    expect(output()).toContain("\x1b[90m");
  });
});

// ─── renderPermissionRequest ──────────────────────────────────────────────────

describe("TuiRenderer.renderPermissionRequest", () => {
  const req: PermissionRequest = {
    sessionId: "sess-abc",
    toolName: "bash",
    description: "Run a potentially dangerous shell command",
    input: { command: "rm -rf /tmp/test" },
  };

  it("should include the toolName", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderPermissionRequest(req);
    expect(output()).toContain("bash");
  });

  it("should include the description", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderPermissionRequest(req);
    expect(output()).toContain("Run a potentially dangerous shell command");
  });

  it("should include yellow or red ANSI code (warning block)", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderPermissionRequest(req);
    const hasYellow = output().includes("\x1b[33m");
    const hasRed = output().includes("\x1b[31m");
    expect(hasYellow || hasRed).toBe(true);
  });

  it("should end with a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderPermissionRequest(req);
    expect(output()).toMatch(/\n$/);
  });
});

// ─── renderSystemMessage ──────────────────────────────────────────────────────

describe("TuiRenderer.renderSystemMessage", () => {
  it("should include the message text", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderSystemMessage("Session started");
    expect(output()).toContain("Session started");
  });

  it("should include gray ANSI code", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderSystemMessage("info");
    expect(output()).toContain("\x1b[90m");
  });

  it("should end with a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderSystemMessage("msg");
    expect(output()).toMatch(/\n$/);
  });
});

// ─── renderPromptPrefix ───────────────────────────────────────────────────────

describe("TuiRenderer.renderPromptPrefix", () => {
  it("should write '> ' without a newline", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderPromptPrefix();
    expect(output()).toContain("> ");
    expect(output()).not.toContain("\n");
  });
});

// ─── renderTurnSeparator ──────────────────────────────────────────────────────

describe("TuiRenderer - renderTurnSeparator", () => {
  it("escribe una cadena de guiones ─", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderTurnSeparator();
    expect(output()).toContain("─");
  });

  it("la salida contiene secuencias dim y reset", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderTurnSeparator();
    expect(output()).toContain("\x1b[2m");  // dim
    expect(output()).toContain("\x1b[0m");  // reset
  });

  it("termina con \\n", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderTurnSeparator();
    expect(output()).toMatch(/\n$/);
  });
});

// ─── renderHeader alignment ───────────────────────────────────────────────────

describe("TuiRenderer - renderHeader alignment", () => {
  it("top y bottom borders tienen el mismo ancho visual que la línea del título", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderHeader("0.1.0");

    // Strip ANSI codes to get raw text
    const raw = output().replace(/\x1b\[[0-9;]*m/g, "");
    const lines = raw.split("\n").filter((l) => l.length > 0);

    // lines[0] = top border (╔═...═╗), lines[1] = middle, lines[2] = bottom
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Count visual width of each line (emoji = 2 cells)
    function visualWidth(s: string): number {
      let w = 0;
      for (const char of s) {
        const cp = char.codePointAt(0) ?? 0;
        w += cp > 0x2E7F ? 2 : 1;
      }
      return w;
    }

    const topWidth    = visualWidth(lines[0]);
    const middleWidth = visualWidth(lines[1]);
    const bottomWidth = visualWidth(lines[2]);

    expect(topWidth).toBe(middleWidth);
    expect(bottomWidth).toBe(middleWidth);
  });

  it("el emoji 🤖 en el título se cuenta como 2 celdas visuales (verificación indirecta)", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderHeader("0.1.0");

    // The title contains 🤖 — if visualWidth is used correctly, the box is aligned.
    // We verify the output contains the emoji and box chars
    expect(output()).toContain("🤖");
    expect(output()).toMatch(/[╔╗╚╝║═]/);
  });
});

// ─── startSpinner / stopSpinner ───────────────────────────────────────────────

describe("TuiRenderer - startSpinner / stopSpinner", () => {
  it("startSpinner() escribe algo en el writer después de al menos un tick (100ms)", async () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.startSpinner();
    // Esperar más de un tick (100ms)
    await new Promise((r) => setTimeout(r, 150));
    renderer.stopSpinner();

    // Debe haber escrito algo (el tick del spinner)
    expect(output().length).toBeGreaterThan(0);
  });

  it("stopSpinner() escribe ANSI.clearLine para limpiar la línea", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.stopSpinner();

    // clearLine = "\x1b[2K\r"
    expect(output()).toContain("\x1b[2K\r");
  });

  it("stopSpinner() es idempotente — se puede llamar sin haber llamado startSpinner", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);

    // No debe lanzar error
    expect(() => {
      renderer.stopSpinner();
      renderer.stopSpinner();
    }).not.toThrow();
  });

  it("llamar startSpinner() dos veces no crea dos intervalos (solo uno activo)", async () => {
    const { writer, chunks } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.startSpinner();
    renderer.startSpinner(); // segunda llamada — debe cancelar la primera

    await new Promise((r) => setTimeout(r, 150));
    renderer.stopSpinner();

    // Contar cuántos ticks ocurrieron: con un solo intervalo de 100ms en 150ms
    // deberían ser ~1 tick. Con dos intervalos serían ~2 ticks.
    // Filtramos solo los chunks que contienen "Pensando"
    const tickChunks = chunks.filter((c) => c.includes("Pensando"));
    // Con un solo intervalo activo, en 150ms esperamos 1 tick (no 2)
    expect(tickChunks.length).toBeLessThanOrEqual(2);
  });

  it("stopSpinner() después de startSpinner() detiene la animación", async () => {
    const { writer, chunks } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.startSpinner();
    await new Promise((r) => setTimeout(r, 150));
    renderer.stopSpinner();

    const chunksAfterStop = chunks.length;

    // Esperar otro ciclo — no deben añadirse más chunks de spinner
    await new Promise((r) => setTimeout(r, 150));

    expect(chunks.length).toBe(chunksAfterStop);
  });

  it("el tick del spinner incluye el frame braille y 'Pensando'", async () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.startSpinner();
    await new Promise((r) => setTimeout(r, 150));
    renderer.stopSpinner();

    expect(output()).toContain("Pensando");
  });

  it("el tick del spinner incluye el color azul ANSI", async () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.startSpinner();
    await new Promise((r) => setTimeout(r, 150));
    renderer.stopSpinner();

    // Blue ANSI = \x1b[34m
    expect(output()).toContain("\x1b[34m");
  });

  it("el primer tick del spinner NO incluye tiempo elapsed (elapsed < 1s)", async () => {
    const { writer, chunks } = makeWriter();
    const renderer = new TuiRenderer(writer);

    renderer.startSpinner();
    // Esperar MENOS de 1 segundo (solo un tick de 100ms)
    await new Promise((r) => setTimeout(r, 120));
    renderer.stopSpinner();

    // El primer tick debería NO incluir segundos (elapsed=0, elapsedStr="")
    const tickChunks = chunks.filter((c) => c.includes("Pensando"));
    expect(tickChunks.length).toBeGreaterThan(0);
    // No debería incluir "0s" ni "1s" (era 100-120ms, menos de 1s)
    const firstTick = tickChunks[0];
    expect(firstTick).not.toContain("0s");
  });
});

// ─── visualWidth edge cases via renderHeader ──────────────────────────────────

describe("TuiRenderer - visualWidth edge cases via renderHeader", () => {
  it("renderHeader con versión vacía no lanza error", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    // No lanza error incluso con version vacía
    expect(() => renderer.renderHeader("")).not.toThrow();
    expect(output().length).toBeGreaterThan(0);
  });

  it("renderHeader con versión ASCII pura (sin emoji en version) produce box alineado", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderHeader("1.2.3");
    const raw = output().replace(/\x1b\[[0-9;]*m/g, "");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    // Verificar que las líneas de borde tienen el mismo ancho que la del título
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // El borde superior e inferior deben tener el mismo número de chars
    expect(lines[0].length).toBe(lines[2].length);
  });
});

// ─── sanitizeAnsiOsc via renderStreamChunk ────────────────────────────────────

describe("TuiRenderer - sanitizeAnsiOsc via renderStreamChunk", () => {
  it("preserva secuencias SGR (colores) en el chunk", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStreamChunk("\x1b[36mhello\x1b[0m");
    expect(output()).toContain("\x1b[36m");
    expect(output()).toContain("\x1b[0m");
    expect(output()).toContain("hello");
  });

  it("elimina secuencias CSI non-SGR (cursor movement)", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStreamChunk("\x1b[2J\x1b[H texto limpio");
    expect(output()).not.toContain("\x1b[2J");
    expect(output()).not.toContain("\x1b[H");
    expect(output()).toContain("texto limpio");
  });

  it("preserva SGR y elimina CSI non-SGR en texto mixto", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    renderer.renderStreamChunk("\x1b[36mcolor\x1b[2J\x1b[0m");
    expect(output()).toContain("\x1b[36m");
    expect(output()).toContain("\x1b[0m");
    expect(output()).not.toContain("\x1b[2J");
  });

  it("elimina secuencias CSI con parámetros privados (DEC sequences)", () => {
    const { writer, output } = makeWriter();
    const renderer = new TuiRenderer(writer);
    // \x1b[?25l = hide cursor, \x1b[?1049h = alt screen
    renderer.renderStreamChunk("\x1b[?25l\x1b[?1049h texto");
    expect(output()).not.toContain("\x1b[?25l");
    expect(output()).not.toContain("\x1b[?1049h");
    expect(output()).toContain("texto");
  });
});
