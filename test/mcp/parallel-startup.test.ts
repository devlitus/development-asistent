/**
 * Tests para ARCH-04: Arranque paralelo de servidores MCP.
 *
 * Verifica que MCPToolRegistry.start() arranca los servidores en paralelo
 * usando Promise.allSettled, con manejo graceful de fallos parciales.
 */

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { MCPToolRegistry } from "../../src/mcp/tool-registry.ts";
import type { MCPServerConfig } from "../../src/mcp/server-process.ts";

const MOCK_SERVER_PATH = join(import.meta.dir, "mock-server.ts");
const SLOW_SERVER_PATH = join(import.meta.dir, "slow-start-mock-server.ts");

function mockConfig(overrides: Partial<MCPServerConfig> & { name: string }): MCPServerConfig {
  return {
    command: "bun",
    args: [MOCK_SERVER_PATH],
    timeout: 5000,
    ...overrides,
  };
}

function slowConfig(name: string, delayMs: number): MCPServerConfig {
  return {
    name,
    command: "bun",
    args: [SLOW_SERVER_PATH, String(delayMs)],
    timeout: 10000,
  };
}

// ─── 28a: Arranque paralelo ───────────────────────────────────────

describe("ARCH-04: MCPToolRegistry startup paralelo", () => {
  let registry: MCPToolRegistry;

  afterEach(async () => {
    try {
      await registry?.stop();
    } catch {
      // ignore
    }
  });

  it("sin servidores configurados → start() OK sin error", async () => {
    registry = new MCPToolRegistry();
    await expect(registry.start([])).resolves.toBeUndefined();
    expect(registry.getTools().length).toBe(0);
  });

  it("3 servidores arrancan en paralelo (elapsed < sum_individual * 0.8)", async () => {
    // Each slow server delays 300ms before being ready.
    // Serial: ~900ms. Parallel: ~300ms.
    registry = new MCPToolRegistry();
    const configs = [
      slowConfig("slow1", 300),
      slowConfig("slow2", 300),
      slowConfig("slow3", 300),
    ];

    const t0 = Date.now();
    await registry.start(configs);
    const elapsed = Date.now() - t0;

    // Serial would be ~900ms. Parallel should be ~300ms.
    // Allow generous margin for CI: elapsed < 900 * 0.8 = 720ms
    const sumIndividual = 300 * 3;
    expect(elapsed).toBeLessThan(sumIndividual * 0.8);
    expect(registry.getTools().length).toBeGreaterThan(0);
  });

  it("un servidor falla → los otros disponibles, warning en stderr", async () => {
    const stderrWrites: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    registry = new MCPToolRegistry();
    const configs: MCPServerConfig[] = [
      mockConfig({ name: "good1" }),
      mockConfig({ name: "bad", command: "nonexistent-binary-xyz", args: [] }),
      mockConfig({ name: "good2" }),
    ];

    // Should NOT throw — partial failure is graceful
    await expect(registry.start(configs)).resolves.toBeUndefined();

    // good1 and good2 tools should be available
    const tools = registry.getTools();
    expect(tools.length).toBeGreaterThan(0);
    const hasGood1 = tools.some((t) => t.name.startsWith("good1__"));
    const hasGood2 = tools.some((t) => t.name.startsWith("good2__"));
    expect(hasGood1).toBe(true);
    expect(hasGood2).toBe(true);

    // Warning should have been logged
    const hasWarning = stderrWrites.some((w) =>
      w.toLowerCase().includes("warn") ||
      w.toLowerCase().includes("failed") ||
      w.toLowerCase().includes("bad"),
    );
    expect(hasWarning).toBe(true);

    spy.mockRestore();
  });

  it("todos los servidores fallan → error fatal", async () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

    registry = new MCPToolRegistry();
    const configs: MCPServerConfig[] = [
      mockConfig({ name: "bad1", command: "nonexistent-binary-xyz", args: [] }),
      mockConfig({ name: "bad2", command: "nonexistent-binary-xyz", args: [] }),
    ];

    await expect(registry.start(configs)).rejects.toThrow();

    spy.mockRestore();
  });

  it("fallo parcial → registry limpia (no tools de servidores fallidos)", async () => {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);

    registry = new MCPToolRegistry();
    const configs: MCPServerConfig[] = [
      mockConfig({ name: "ok" }),
      mockConfig({ name: "fail", command: "nonexistent-binary-xyz", args: [] }),
    ];

    await registry.start(configs);
    const tools = registry.getTools();

    // Only tools from "ok" server should be present
    const hasFail = tools.some((t) => t.name.startsWith("fail__"));
    expect(hasFail).toBe(false);

    spy.mockRestore();
  });
});
