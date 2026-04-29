/**
 * conversation-area.test.tsx — INK2-03
 *
 * Tests para renderMarkdown helper en ConversationArea.
 * No monta Ink real — prueba la lógica de parsing de markdown directamente.
 */

import { describe, it, expect } from "bun:test";
import { parseMarkdownLines } from "../../scripts/tui/components/ConversationArea.tsx";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("parseMarkdownLines", () => {
  it("debería retornar array de líneas para texto plano", () => {
    const result = parseMarkdownLines("hola mundo");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "hola mundo", style: "normal" });
  });

  it("debería detectar headers H1 con # ", () => {
    const result = parseMarkdownLines("# Título principal");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "Título principal", style: "h1" });
  });

  it("debería detectar headers H2 con ## ", () => {
    const result = parseMarkdownLines("## Subtítulo");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "Subtítulo", style: "h2" });
  });

  it("debería detectar bloques de código con ```", () => {
    const result = parseMarkdownLines("```typescript");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ style: "code" });
  });

  it("debería detectar líneas con indentación de 4 espacios como código", () => {
    const result = parseMarkdownLines("    const x = 1;");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "    const x = 1;", style: "code" });
  });

  it("debería manejar texto multilínea sin crashear", () => {
    const md = "# Título\n\nPárrafo normal\n\n```\ncódigo\n```";
    const result = parseMarkdownLines(md);
    expect(result.length).toBeGreaterThan(0);
    // No debe lanzar
  });

  it("debería manejar markdown incompleto sin crashear (bold sin cerrar)", () => {
    const result = parseMarkdownLines("**sin cerrar");
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("**sin cerrar");
  });

  it("debería manejar string vacío sin crashear", () => {
    const result = parseMarkdownLines("");
    expect(Array.isArray(result)).toBe(true);
  });

  it("debería manejar string con solo saltos de línea", () => {
    const result = parseMarkdownLines("\n\n\n");
    expect(Array.isArray(result)).toBe(true);
    // No debe lanzar
  });

  it("debería preservar líneas de código con contenido original", () => {
    const result = parseMarkdownLines("```\nconst x = 1;\n```");
    const codeLine = result.find((l) => l.text === "const x = 1;");
    expect(codeLine).toBeDefined();
    expect(codeLine?.style).toBe("code");
  });
});
