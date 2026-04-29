/**
 * Integration tests for MCP client, server process, and tool registry.
 *
 * Uses a real mock MCP server (test/mcp/mock-server.ts) spawned as a
 * subprocess to test the full stdio JSON-RPC flow.
 *
 * Test structure:
 *   - MCPServerProcess: spawn/stop lifecycle, idempotence, error guards
 *   - MCPClient: initialize, tools/list, tools/call, error handling
 *   - MCPToolRegistry: start, getTools, callTool, stop, namespacing, cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { MCPServerProcess, MAX_PENDING_REQUESTS } from "../../src/mcp/server-process.ts";
import { MCPClient } from "../../src/mcp/client.ts";
import { MCPToolRegistry } from "../../src/mcp/tool-registry.ts";
import type { MCPServerConfig } from "../../src/mcp/client.ts";

// Path to the mock server script
const MOCK_SERVER_PATH = join(import.meta.dir, "mock-server.ts");

/** Build a MCPServerConfig pointing to the mock server. */
function mockServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "mock",
    command: "bun",
    args: [MOCK_SERVER_PATH],
    timeout: 3000,
    ...overrides,
  };
}

// ─── MCPServerProcess ─────────────────────────────────────────────

describe("MCPServerProcess", () => {
  let serverProcess: MCPServerProcess;

  afterEach(async () => {
    // Ensure cleanup even if test fails
    try {
      await serverProcess?.stop();
    } catch {
      // ignore
    }
  });

  it("arranca y se conecta al mock server", async () => {
    serverProcess = new MCPServerProcess(mockServerConfig());
    await serverProcess.start();
    // If start() resolves without throwing, the process is running
    expect(serverProcess.isRunning()).toBe(true);
  });

  it("detiene el proceso limpiamente", async () => {
    serverProcess = new MCPServerProcess(mockServerConfig());
    await serverProcess.start();
    expect(serverProcess.isRunning()).toBe(true);

    await serverProcess.stop();
    expect(serverProcess.isRunning()).toBe(false);
  });

  it("stop() antes de start() no lanza error (idempotencia)", async () => {
    serverProcess = new MCPServerProcess(mockServerConfig());
    // stop() before start() should be a no-op, not throw
    await expect(serverProcess.stop()).resolves.toBeUndefined();
    expect(serverProcess.isRunning()).toBe(false);
  });

  it("stop() múltiples veces no lanza error (idempotencia)", async () => {
    serverProcess = new MCPServerProcess(mockServerConfig());
    await serverProcess.start();
    await serverProcess.stop();
    // Second stop should be a no-op
    await expect(serverProcess.stop()).resolves.toBeUndefined();
    expect(serverProcess.isRunning()).toBe(false);
  });

  it("sendRequest() antes de start() lanza error", async () => {
    serverProcess = new MCPServerProcess(mockServerConfig());
    await expect(
      serverProcess.sendRequest("initialize", {}),
    ).rejects.toThrow(/not running/i);
  });

  it("start() con ejecutable inexistente lanza error (TS4)", async () => {
    serverProcess = new MCPServerProcess(
      mockServerConfig({ command: "nonexistent-binary-xyz", args: [] }),
    );
    await expect(serverProcess.start()).rejects.toThrow();
    expect(serverProcess.isRunning()).toBe(false);
  });
});

// ─── MCPClient ────────────────────────────────────────────────────

describe("MCPClient", () => {
  let serverProcess: MCPServerProcess;
  let client: MCPClient;

  beforeEach(async () => {
    serverProcess = new MCPServerProcess(mockServerConfig());
    await serverProcess.start();
    client = new MCPClient(serverProcess);
  });

  afterEach(async () => {
    try {
      await serverProcess.stop();
    } catch {
      // ignore
    }
  });

  it("initialize handshake", async () => {
    const info = await client.initialize();
    expect(info.name).toBe("mock-mcp-server");
    expect(info.version).toBe("0.1.0");
  });

  it("tools/list devuelve herramientas del mock server", async () => {
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    const echo = tools.find((t) => t.name === "echo");
    expect(echo).toBeDefined();
    expect(echo!.description).toContain("world");
    expect(echo!.inputSchema).toBeDefined();
  });

  it("tools/call ejecuta herramienta y devuelve resultado", async () => {
    await client.initialize();
    const result = await client.callTool("echo", { input: "hello" });
    expect(result).toBe("hello world");
  });

  it("tools/call herramienta inexistente devuelve error", async () => {
    await client.initialize();
    await expect(
      client.callTool("nonexistent_tool", {}),
    ).rejects.toThrow();
  }, 8000);

  it("callTool() antes de initialize() lanza error", async () => {
    // client was created but initialize() not called
    await expect(
      client.callTool("echo", { input: "test" }),
    ).rejects.toThrow(/initialize/i);
  });

  it("timeout cuando el server no responde", async () => {
    // Use a short timeout to trigger timeout on slow_tool, but large enough
    // for the initialize handshake to complete even on slow CI (BUG-NEW-1).
    const shortTimeoutProcess = new MCPServerProcess(
      mockServerConfig({ name: "mock-timeout", timeout: 1500 }),
    );
    await shortTimeoutProcess.start();
    const timeoutClient = new MCPClient(shortTimeoutProcess);
    await timeoutClient.initialize();

    try {
      await expect(
        timeoutClient.callTool("slow_tool", { input: "test" }),
      ).rejects.toThrow(/timeout/i);
    } finally {
      await shortTimeoutProcess.stop();
    }
  });

  it("múltiples callTool() concurrentes retornan resultados correctos", async () => {
    await client.initialize();
    // Fire 5 concurrent calls with different inputs
    const inputs = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const results = await Promise.all(
      inputs.map((input) => client.callTool("echo", { input })),
    );
    for (let i = 0; i < inputs.length; i++) {
      expect(results[i]).toBe(`${inputs[i]} world`);
    }
  });
});

// ─── MCPToolRegistry ─────────────────────────────────────────────

describe("MCPToolRegistry", () => {
  let registry: MCPToolRegistry;

  afterEach(async () => {
    try {
      await registry?.stop();
    } catch {
      // ignore
    }
  });

  it("start() arranca los servers configurados", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig()]);
    // No error means servers started successfully
    expect(registry.getTools().length).toBeGreaterThan(0);
  });

  it("getTools() devuelve ToolDefinition[] con todas las herramientas", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig()]);
    const tools = registry.getTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(1);

    // Each tool should have name, description, parameters
    // S2: names are namespaced as "mock__echo"
    const echo = tools.find((t) => t.name === "mock__echo");
    expect(echo).toBeDefined();
    expect(typeof echo!.name).toBe("string");
    expect(typeof echo!.description).toBe("string");
    expect(echo!.parameters).toBeDefined();
  });

  it("las herramientas tienen el prefijo serverName__ en su nombre (S2)", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig({ name: "myserver" })]);
    const tools = registry.getTools();
    // All tool names must start with "myserver__"
    for (const tool of tools) {
      expect(tool.name).toMatch(/^myserver__/);
    }
  });

  it("callTool() invoca herramienta con nombre namespaceado y devuelve string", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig()]);
    // S2: use qualified name "mock__echo"
    const result = await registry.callTool("mock__echo", { input: "hello" });
    expect(typeof result).toBe("string");
    expect(result).toBe("hello world");
  });

  it("callTool() herramienta inexistente lanza error", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig()]);
    await expect(
      registry.callTool("nonexistent_tool", {}),
    ).rejects.toThrow();
  });

  it("callTool() con nombre sin prefijo lanza error (S2 enforcement)", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig()]);
    // "echo" without prefix should not be found — must use "mock__echo"
    await expect(
      registry.callTool("echo", { input: "hello" }),
    ).rejects.toThrow(/not found/i);
  });

  it("stop() detiene todos los servers", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig()]);
    await registry.stop();
    // After stop, getTools should return empty
    expect(registry.getTools().length).toBe(0);
  });

  it("start() ya iniciado lanza error (guard)", async () => {
    registry = new MCPToolRegistry();
    await registry.start([mockServerConfig()]);
    await expect(
      registry.start([mockServerConfig({ name: "mock2" })]),
    ).rejects.toThrow(/already started/i);
  });

  it("start() con server que falla → continúa con los disponibles (ARCH-04 graceful)", async () => {
    registry = new MCPToolRegistry();
    // First config is valid, second has a bad command
    const configs: MCPServerConfig[] = [
      mockServerConfig({ name: "good" }),
      mockServerConfig({ name: "bad", command: "nonexistent-binary-xyz", args: [] }),
    ];
    // ARCH-04: partial failure is graceful — does NOT throw
    await expect(registry.start(configs)).resolves.toBeUndefined();
    // The "good" server's tools should be available
    const tools = registry.getTools();
    expect(tools.some((t) => t.name.startsWith("good__"))).toBe(true);
    // The "bad" server's tools should NOT be present
    expect(tools.some((t) => t.name.startsWith("bad__"))).toBe(false);
  });
});

// ─── PERF-07: Semáforo en pendingRequests ─────────────────────────

describe("PERF-07: MCPServerProcess semáforo pendingRequests", () => {
  it("should export MAX_PENDING_REQUESTS = 100", () => {
    expect(MAX_PENDING_REQUESTS).toBe(100);
  });

  it("should expose pendingCount() method returning 0 initially", () => {
    const proc = new MCPServerProcess(mockServerConfig());
    expect(typeof proc.pendingCount).toBe("function");
    expect(proc.pendingCount()).toBe(0);
  });

  it("should reject sendRequest when pendingRequests >= MAX_PENDING_REQUESTS", async () => {
    const proc = new MCPServerProcess(mockServerConfig());
    // Inject fake pending requests directly to simulate saturation
    const procAny = proc as unknown as {
      pendingRequests: Map<number, unknown>;
      running: boolean;
      process: { stdin: { write: (data: string, cb?: (err?: Error | null) => void) => void } } | null;
    };
    procAny.running = true;
    // Create a fake stdin that never errors
    procAny.process = {
      stdin: {
        write: (_data: string, cb?: (err?: Error | null) => void) => {
          cb?.();
        },
      },
    };

    // Fill pendingRequests to MAX_PENDING_REQUESTS
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
      procAny.pendingRequests.set(i, {
        resolve: () => {},
        reject: () => {},
        timer: setTimeout(() => {}, 60_000),
      });
    }

    // Now sendRequest should be rejected
    await expect(proc.sendRequest("test/method", {})).rejects.toThrow("MAX_REQUESTS_EXCEEDED");

    // Cleanup timers
    for (const [, pending] of procAny.pendingRequests) {
      clearTimeout((pending as { timer: ReturnType<typeof setTimeout> }).timer);
    }
    procAny.pendingRequests.clear();
    procAny.running = false;
    procAny.process = null;
  });

  it("pendingCount() reflects actual pending count", async () => {
    const proc = new MCPServerProcess(mockServerConfig());
    const procAny = proc as unknown as {
      pendingRequests: Map<number, unknown>;
    };

    expect(proc.pendingCount()).toBe(0);
    procAny.pendingRequests.set(1, {});
    expect(proc.pendingCount()).toBe(1);
    procAny.pendingRequests.set(2, {});
    expect(proc.pendingCount()).toBe(2);
    procAny.pendingRequests.clear();
    expect(proc.pendingCount()).toBe(0);
  });

  it("TOCTOU: 101 requests concurrentes → exactamente 100 en el mapa, 1 rechazada con MAX_REQUESTS_EXCEEDED", async () => {
    // This test verifies the atomicity of the semaphore check+set.
    // With JS single-threaded execution and no await between check and set,
    // exactly MAX_PENDING_REQUESTS (100) slots should be reserved and
    // the 101st request must be rejected with MAX_REQUESTS_EXCEEDED.
    //
    // Strategy: use a short timeout (1ms) so requests settle quickly,
    // then verify exactly 1 was rejected with MAX_REQUESTS_EXCEEDED and
    // the other 100 were rejected with timeout (not MAX_REQUESTS_EXCEEDED).
    const proc = new MCPServerProcess({
      ...mockServerConfig(),
      timeout: 50, // Very short timeout so pending requests settle quickly
    });
    const procAny = proc as unknown as {
      pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
      running: boolean;
      process: { stdin: { write: (data: string, cb?: (err?: Error | null) => void) => void } } | null;
    };

    // Set up a fake running process with a stdin that never calls the callback.
    procAny.running = true;
    procAny.process = {
      stdin: {
        write: (_data: string, _cb?: (err?: Error | null) => void) => {
          // Never call _cb — requests will timeout after 50ms.
        },
      },
    };

    // Fire 101 requests simultaneously. The semaphore check is synchronous within
    // the async function body, so all 101 checks run before any microtask yields.
    const promises = Array.from({ length: 101 }, () =>
      proc.sendRequest("test/method", {}).then(
        () => ({ ok: true, msg: "" }),
        (err: Error) => ({ ok: false, msg: err.message }),
      ),
    );

    // Wait for all to settle (100 will timeout after 50ms, 1 rejected immediately)
    const results = await Promise.all(promises);

    const maxExceeded = results.filter((r) => r.msg.includes("MAX_REQUESTS_EXCEEDED"));
    const timeouts = results.filter((r) => r.msg.includes("timeout"));

    // Exactly 1 must be rejected with MAX_REQUESTS_EXCEEDED (the semaphore check)
    expect(maxExceeded.length).toBe(1);
    // The other 100 must be rejected with timeout (they were accepted into the map)
    expect(timeouts.length).toBe(100);
    // None should have succeeded
    expect(results.filter((r) => r.ok).length).toBe(0);

    procAny.running = false;
    procAny.process = null;
  });
});
