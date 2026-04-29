/**
 * Security hardening tests for MCP layer.
 *
 * Covers:
 *   - 21a SEC-07: MAX_LINE_BYTES — oversized NDJSON lines are discarded gracefully
 *   - 21b SEC-08: MAX_TOOLS_PER_SERVER — tool list is capped at 256
 *   - 21c SEC-09: MAX_STDERR_BYTES — stderr is truncated and redacted
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { MCPServerProcess, MAX_LINE_BYTES, MAX_STDERR_BYTES } from "../../src/mcp/server-process.ts";
import { MCPToolRegistry, MAX_TOOLS_PER_SERVER } from "../../src/mcp/tool-registry.ts";
import { MCPClient } from "../../src/mcp/client.ts";
import type { MCPServerConfig } from "../../src/mcp/server-process.ts";

const MOCK_SERVER_PATH = join(import.meta.dir, "mock-server.ts");
const OVERSIZED_SERVER_PATH = join(import.meta.dir, "oversized-mock-server.ts");
const MANY_TOOLS_SERVER_PATH = join(import.meta.dir, "many-tools-mock-server.ts");
const STDERR_SERVER_PATH = join(import.meta.dir, "stderr-mock-server.ts");

function mockConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "mock",
    command: "bun",
    args: [MOCK_SERVER_PATH],
    timeout: 5000,
    ...overrides,
  };
}

// ─── 21a: MAX_LINE_BYTES ──────────────────────────────────────────

describe("SEC-07: MAX_LINE_BYTES", () => {
  it("MAX_LINE_BYTES está exportado y vale 1 MB", () => {
    expect(MAX_LINE_BYTES).toBe(1 * 1024 * 1024);
  });

  it("línea NDJSON de 500KB es procesada normalmente", async () => {
    const proc = new MCPServerProcess(
      mockConfig({ name: "oversized", args: [OVERSIZED_SERVER_PATH, "500"] }),
    );
    await proc.start();
    const client = new MCPClient(proc);
    await client.initialize();

    // The oversized server sends a valid 500KB response for "echo"
    const result = await client.callTool("echo", { input: "hello" });
    expect(result).toBe("hello world");

    await proc.stop();
  });

  it("línea NDJSON de 1.5MB es descartada, buffer reseteado, mensajes posteriores funcionan", async () => {
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const proc = new MCPServerProcess(
      mockConfig({ name: "oversized-big", args: [OVERSIZED_SERVER_PATH, "1500"] }),
    );
    await proc.start();
    const client = new MCPClient(proc);
    await client.initialize();

    // The oversized server first sends a 1.5MB line (discarded), then a valid response
    const result = await client.callTool("echo", { input: "after-oversized" });
    expect(result).toBe("after-oversized world");

    // Should have logged a warning about the oversized line
    const hasOversizedWarning = stderrWrites.some((w) =>
      w.toLowerCase().includes("oversized") || w.toLowerCase().includes("line too large") || w.toLowerCase().includes("discarded"),
    );
    expect(hasOversizedWarning).toBe(true);

    spy.mockRestore();
    await proc.stop();
  });

  it("múltiples mensajes después de oversized siguen funcionando", async () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

    const proc = new MCPServerProcess(
      mockConfig({ name: "oversized-multi", args: [OVERSIZED_SERVER_PATH, "1500"] }),
    );
    await proc.start();
    const client = new MCPClient(proc);
    await client.initialize();

    // Multiple calls after the oversized line should all work
    const r1 = await client.callTool("echo", { input: "first" });
    const r2 = await client.callTool("echo", { input: "second" });
    expect(r1).toBe("first world");
    expect(r2).toBe("second world");

    spy.mockRestore();
    await proc.stop();
  });

  it("early-discard: buffer no crece más allá de MAX_LINE_BYTES sin newline", () => {
    // Simulate the char-by-char loop logic directly to verify the early-discard
    // invariant: lineBuffer never exceeds MAX_LINE_BYTES bytes at any point.
    // Uses O(n) incremental byte counter — NOT Buffer.byteLength(lineBuffer) in the loop.
    const MAX = MAX_LINE_BYTES;
    let lineBuffer = "";
    let lineBufferByteLen = 0;
    let lineBufferOversized = false;
    let maxBytesSeen = 0;

    // Generate 2MB of 'a' chars without any newline
    const bigChunk = "a".repeat(2 * 1024 * 1024);

    for (const char of bigChunk) {
      if (char === "\n") {
        lineBuffer = "";
        lineBufferByteLen = 0;
        lineBufferOversized = false;
      } else {
        if (!lineBufferOversized) {
          const charBytes = Buffer.byteLength(char, "utf8"); // O(1) — single char
          if (lineBufferByteLen + charBytes > MAX) {
            lineBuffer = "";
            lineBufferByteLen = 0;
            lineBufferOversized = true;
          } else {
            lineBuffer += char;
            lineBufferByteLen += charBytes;
          }
        }
      }
      if (lineBufferByteLen > maxBytesSeen) maxBytesSeen = lineBufferByteLen;
    }

    // The buffer should never have grown beyond MAX_LINE_BYTES
    expect(maxBytesSeen).toBeLessThanOrEqual(MAX);
    // And the oversized flag should be set (we never saw a newline)
    expect(lineBufferOversized).toBe(true);
    // Buffer itself should be empty (was discarded)
    expect(lineBuffer).toBe("");
  });
});

// ─── 21b: MAX_TOOLS_PER_SERVER ────────────────────────────────────

describe("SEC-08: MAX_TOOLS_PER_SERVER", () => {
  it("MAX_TOOLS_PER_SERVER está exportado y vale 256", () => {
    expect(MAX_TOOLS_PER_SERVER).toBe(256);
  });

  it("servidor con 10 tools → todas registradas", async () => {
    const registry = new MCPToolRegistry();
    await registry.start([
      mockConfig({ name: "few", args: [MANY_TOOLS_SERVER_PATH, "10"] }),
    ]);
    const tools = registry.getTools();
    expect(tools.length).toBe(10);
    await registry.stop();
  });

  it("servidor con 300 tools → solo 256 registradas, warning en stderr", async () => {
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const registry = new MCPToolRegistry();
    await registry.start([
      mockConfig({ name: "many", args: [MANY_TOOLS_SERVER_PATH, "300"] }),
    ]);
    const tools = registry.getTools();
    expect(tools.length).toBe(256);

    const hasWarning = stderrWrites.some((w) =>
      w.includes("256") || w.toLowerCase().includes("truncated"),
    );
    expect(hasWarning).toBe(true);

    spy.mockRestore();
    await registry.stop();
  });

  it("exactamente 256 tools → todas registradas sin warning", async () => {
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const registry = new MCPToolRegistry();
    await registry.start([
      mockConfig({ name: "exact", args: [MANY_TOOLS_SERVER_PATH, "256"] }),
    ]);
    const tools = registry.getTools();
    expect(tools.length).toBe(256);

    const hasTruncatedWarning = stderrWrites.some((w) =>
      w.toLowerCase().includes("truncated"),
    );
    expect(hasTruncatedWarning).toBe(false);

    spy.mockRestore();
    await registry.stop();
  });
});

// ─── 21c: MAX_STDERR_BYTES ────────────────────────────────────────

describe("SEC-09: MAX_STDERR_BYTES", () => {
  it("MAX_STDERR_BYTES está exportado y vale 4096", () => {
    expect(MAX_STDERR_BYTES).toBe(4096);
  });

  it("stderr de 1KB → incluido completo en log", async () => {
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const proc = new MCPServerProcess(
      mockConfig({ name: "stderr-small", args: [STDERR_SERVER_PATH, "1024"] }),
    );
    await proc.start();
    // Wait briefly for stderr to flush
    await new Promise((r) => setTimeout(r, 300));

    const combined = stderrWrites.join("");
    // Should NOT contain truncation marker for 1KB
    expect(combined).not.toContain("[...stderr truncated");

    spy.mockRestore();
    await proc.stop();
  });

  it("stderr de 10KB → truncado a 4KB + marker", async () => {
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const proc = new MCPServerProcess(
      mockConfig({ name: "stderr-large", args: [STDERR_SERVER_PATH, "10240"] }),
    );
    await proc.start();
    await new Promise((r) => setTimeout(r, 300));

    const combined = stderrWrites.join("");
    expect(combined).toContain("[...stderr truncated at 4096 bytes]");

    spy.mockRestore();
    await proc.stop();
  });

  it("stderr con API key → redactada antes de loguear", async () => {
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const proc = new MCPServerProcess(
      mockConfig({ name: "stderr-secret", args: [STDERR_SERVER_PATH, "secret"] }),
    );
    await proc.start();
    await new Promise((r) => setTimeout(r, 300));

    const combined = stderrWrites.join("");
    // The raw API key should NOT appear in logs
    expect(combined).not.toContain("sk-ant-api03-supersecretkey1234567890");
    // But [REDACTED] should appear
    expect(combined).toContain("[REDACTED]");

    spy.mockRestore();
    await proc.stop();
  });
});
