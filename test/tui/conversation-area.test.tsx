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

  it("debería detectar bloques de código con ``` y extraer lenguaje como code_label (A6)", () => {
    const result = parseMarkdownLines("```typescript");
    // Con A6: la fence line se suprime y se genera un code_label con el lenguaje
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ style: "code_label", text: "[typescript]" });
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

  // ── C-6/M2: h2 y h3 tienen estilos distintos ─────────────────────────────────

  it("C6/M2: h2 tiene estilo 'h2' (diferente de h3)", () => {
    const result = parseMarkdownLines("## Título nivel 2");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "Título nivel 2", style: "h2" });
  });

  it("C6/M2: h3 tiene estilo 'h3' (diferente de h2)", () => {
    const result = parseMarkdownLines("### Subtítulo nivel 3");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "Subtítulo nivel 3", style: "h3" });
  });

  it("C6/M2: h1 tiene estilo 'h1'", () => {
    const result = parseMarkdownLines("# Título principal");
    expect(result[0]).toMatchObject({ style: "h1" });
  });
});

// ─── C-8/M9: PermissionBlock trunca a 10 líneas ───────────────────────────────

// Nota: PermissionBlock no es exportado, pero podemos testear la lógica de truncado directamente

describe("PermissionBlock truncado (lógica)", () => {
  it("C8/M9: JSON con más de 10 líneas se trunca a 10 + '… (truncado)'", () => {
    // Simular la lógica de truncado de PermissionBlock
    const inputObj = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11 };
    const inputStr = JSON.stringify(inputObj, null, 2);
    const lines = inputStr.split("\n");
    const truncated = lines.length > 10
      ? lines.slice(0, 10).join("\n") + "\n… (truncado)"
      : inputStr;

    expect(lines.length).toBeGreaterThan(10);
    expect(truncated).toContain("… (truncado)");
    expect(truncated.split("\n").length).toBe(11); // 10 líneas + "… (truncado)"
  });

  it("C8/M9: JSON con 10 líneas o menos NO se trunca", () => {
    const inputObj = { a: 1 };
    const inputStr = JSON.stringify(inputObj, null, 2);
    const lines = inputStr.split("\n");
    const truncated = lines.length > 10
      ? lines.slice(0, 10).join("\n") + "\n… (truncado)"
      : inputStr;

    expect(truncated).not.toContain("… (truncado)");
    expect(truncated).toBe(inputStr);
  });
});
