/**
 * Tests para ARCH-05: MCPHttpClient para servidores SSE/HTTP.
 *
 * Verifica:
 * - Config transport: 'stdio' → usa MCPServerProcess
 * - Config transport: 'http' → usa MCPHttpClient
 * - Auth headers
 * - Protección SSRF
 * - Integración con mock HTTP server (Bun.serve)
 *
 * NOTE: Each test creates its own server on port 0 (OS-assigned random port).
 * Servers are registered in a cleanup list and stopped in afterEach.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { MCPToolRegistry } from "../../src/mcp/tool-registry.ts";
import { MCPHttpClient } from "../../src/mcp/http-client.ts";
import type { MCPServerConfig } from "../../src/mcp/server-process.ts";
import type { McpServerConfigUnion } from "../../src/mcp/types.ts";

const MOCK_SERVER_PATH = join(import.meta.dir, "mock-server.ts");

// Restore the real fetch before each test to avoid interference from
// other test files that mock globalThis.fetch (e.g. local-providers.test.ts).
const REAL_FETCH = globalThis.fetch;

// ─── Helpers ──────────────────────────────────────────────────────

const ECHO_TOOLS = [
  {
    name: "echo",
    description: "Echoes input back with ' world'",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
];

/** Creates a minimal mock HTTP MCP server on a random port. */
function createEchoServer() {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/initialize") {
        return Response.json({
          serverInfo: { name: "mock-http-server", version: "1.0.0" },
          capabilities: {},
        });
      }
      if (req.method === "GET" && url.pathname === "/tools") {
        return Response.json({ tools: ECHO_TOOLS });
      }
      if (req.method === "POST" && url.pathname === "/tools/call") {
        return req.json().then((body: unknown) => {
          const b = body as { name?: string; arguments?: Record<string, unknown> };
          if (b.name === "echo") {
            const input = b.arguments?.input ?? "";
            return Response.json({ content: [{ type: "text", text: `${input} world` }] });
          }
          return Response.json({ error: `Tool not found: ${b.name}` }, { status: 404 });
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return { srv, port: srv.port };
}

/** Creates a server that captures request headers. */
function createHeaderCaptureServer(headers: Record<string, string>) {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      if (req.method === "POST" && url.pathname === "/initialize") {
        return Response.json({ serverInfo: { name: "test", version: "1.0.0" }, capabilities: {} });
      }
      return new Response("OK");
    },
  });
  return { srv, port: srv.port };
}

/** Creates a server with a single http_tool. */
function createHttpToolServer() {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/initialize") {
        return Response.json({ serverInfo: { name: "http-server", version: "1.0.0" }, capabilities: {} });
      }
      if (req.method === "GET" && url.pathname === "/tools") {
        return Response.json({
          tools: [{
            name: "http_tool",
            description: "A tool from HTTP server",
            inputSchema: { type: "object", properties: {}, required: [] },
          }],
        });
      }
      if (req.method === "POST" && url.pathname === "/tools/call") {
        return req.json().then(() =>
          Response.json({ content: [{ type: "text", text: "http result" }] }),
        );
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return { srv, port: srv.port };
}

// ─── MCPHttpClient unit tests ─────────────────────────────────────

describe("MCPHttpClient", () => {
  // Track servers to stop in afterEach
  const servers: ReturnType<typeof Bun.serve>[] = [];

  beforeEach(() => {
    // Restore real fetch in case another test file mocked it
    globalThis.fetch = REAL_FETCH;
  });

  afterEach(() => {
    for (const srv of servers.splice(0)) {
      try { srv.stop(); } catch { /* ignore */ }
    }
  });

  it("initialize() → conecta al servidor HTTP y retorna serverInfo", async () => {
    const { srv, port } = createEchoServer();
    servers.push(srv);
    const client = new MCPHttpClient({ url: `http://127.0.0.1:${port}`, _allowPrivateUrls: true });
    const info = await client.initialize();
    expect(info.name).toBe("mock-http-server");
    expect(info.version).toBe("1.0.0");
  });

  it("listTools() → retorna herramientas del servidor HTTP", async () => {
    const { srv, port } = createEchoServer();
    servers.push(srv);
    const client = new MCPHttpClient({ url: `http://127.0.0.1:${port}`, _allowPrivateUrls: true });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("echo");
  });

  it("callTool() → invoca herramienta y retorna resultado", async () => {
    const { srv, port } = createEchoServer();
    servers.push(srv);
    const client = new MCPHttpClient({ url: `http://127.0.0.1:${port}`, _allowPrivateUrls: true });
    await client.initialize();
    const result = await client.callTool("echo", { input: "hello" });
    expect(result).toBe("hello world");
  });

  it("sin apiKey → no incluye header Authorization", async () => {
    const receivedHeaders: Record<string, string> = {};
    const { srv, port } = createHeaderCaptureServer(receivedHeaders);
    servers.push(srv);
    const client = new MCPHttpClient({ url: `http://127.0.0.1:${port}`, _allowPrivateUrls: true });
    await client.initialize();
    expect(receivedHeaders["authorization"]).toBeUndefined();
  });

  it("con apiKey → incluye header Authorization: Bearer {apiKey}", async () => {
    const receivedHeaders: Record<string, string> = {};
    const { srv, port } = createHeaderCaptureServer(receivedHeaders);
    servers.push(srv);
    const client = new MCPHttpClient({
      url: `http://127.0.0.1:${port}`,
      apiKey: "my-secret-key",
      _allowPrivateUrls: true,
    });
    await client.initialize();
    expect(receivedHeaders["authorization"]).toBe("Bearer my-secret-key");
  });

  it("URL con IP privada → rechazado por SSRF (10.x.x.x)", async () => {
    const client = new MCPHttpClient({ url: "http://10.0.0.1/mcp" });
    await expect(client.initialize()).rejects.toThrow(/ssrf|private|blocked/i);
  });

  it("URL con IP privada → rechazado por SSRF (192.168.x.x)", async () => {
    const client = new MCPHttpClient({ url: "http://192.168.1.1/mcp" });
    await expect(client.initialize()).rejects.toThrow(/ssrf|private|blocked/i);
  });

  it("stop() no lanza error", () => {
    const client = new MCPHttpClient({ url: "http://127.0.0.1:9999" });
    expect(() => client.stop()).not.toThrow();
  });
});

// ─── MCPToolRegistry con transport: 'http' ────────────────────────

describe("MCPToolRegistry con transport: http", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const registries: MCPToolRegistry[] = [];

  beforeEach(() => {
    // Restore real fetch in case another test file mocked it
    globalThis.fetch = REAL_FETCH;
  });

  afterEach(async () => {
    for (const reg of registries.splice(0)) {
      try { await reg.stop(); } catch { /* ignore */ }
    }
    for (const srv of servers.splice(0)) {
      try { srv.stop(); } catch { /* ignore */ }
    }
  });

  it("config transport: 'http' → registry usa MCPHttpClient y registra tools", async () => {
    const { srv, port } = createHttpToolServer();
    servers.push(srv);
    const registry = new MCPToolRegistry();
    registries.push(registry);

    const config = {
      name: "remote",
      transport: "http" as const,
      url: `http://127.0.0.1:${port}`,
      _allowPrivateUrls: true,
    };

    await registry.start([config]);
    const tools = registry.getTools();
    expect(tools.length).toBeGreaterThan(0);
    const httpTool = tools.find((t) => t.name === "remote__http_tool");
    expect(httpTool).toBeDefined();
  });

  it("config transport: 'http' → callTool funciona", async () => {
    const { srv, port } = createHttpToolServer();
    servers.push(srv);
    const registry = new MCPToolRegistry();
    registries.push(registry);

    const config = {
      name: "remote2",
      transport: "http" as const,
      url: `http://127.0.0.1:${port}`,
      _allowPrivateUrls: true,
    };

    await registry.start([config]);
    const result = await registry.callTool("remote2__http_tool", {});
    expect(result).toBe("http result");
  });

  it("config transport: 'stdio' → registry usa MCPServerProcess (backward compat)", async () => {
    const registry = new MCPToolRegistry();
    registries.push(registry);

    const config: McpServerConfigUnion = {
      name: "stdio-server",
      transport: "stdio",
      command: "bun",
      args: [MOCK_SERVER_PATH],
      timeout: 5000,
    };

    await registry.start([config]);
    const tools = registry.getTools();
    expect(tools.length).toBeGreaterThan(0);
    const echo = tools.find((t) => t.name === "stdio-server__echo");
    expect(echo).toBeDefined();
  });

  it("config sin transport → asume 'stdio' (backward compat)", async () => {
    const registry = new MCPToolRegistry();
    registries.push(registry);

    const config = {
      name: "legacy",
      command: "bun",
      args: [MOCK_SERVER_PATH],
      timeout: 5000,
    } as MCPServerConfig;

    await registry.start([config]);
    const tools = registry.getTools();
    expect(tools.length).toBeGreaterThan(0);
  });
});

// ─── Config schema union type ─────────────────────────────────────

describe("McpServerSchemaUnion schema", () => {
  it("acepta config stdio con transport explícito", async () => {
    const { McpServerSchemaUnion } = await import("../../src/config/schema.ts");
    const result = McpServerSchemaUnion.safeParse({
      name: "my-server",
      transport: "stdio",
      command: "bun",
      args: ["server.ts"],
    });
    expect(result.success).toBe(true);
  });

  it("acepta config http con url", async () => {
    const { McpServerSchemaUnion } = await import("../../src/config/schema.ts");
    const result = McpServerSchemaUnion.safeParse({
      name: "remote",
      transport: "http",
      url: "https://mcp.example.com",
    });
    expect(result.success).toBe(true);
  });

  it("acepta config legacy sin transport (backward compat → stdio)", async () => {
    const { McpServerSchemaUnion } = await import("../../src/config/schema.ts");
    const result = McpServerSchemaUnion.safeParse({
      name: "legacy",
      command: "bun",
      args: [],
    });
    expect(result.success).toBe(true);
  });

  it("rechaza config http sin url", async () => {
    const { McpServerSchemaUnion } = await import("../../src/config/schema.ts");
    const result = McpServerSchemaUnion.safeParse({
      name: "bad",
      transport: "http",
    });
    expect(result.success).toBe(false);
  });
});

// ─── McpHttpSchema SSRF validation (SEC-SSRF) ─────────────────────

describe("McpHttpSchema — validación SSRF (SEC-SSRF)", () => {
  it("rechaza URL de metadata AWS/GCP/Azure (169.254.169.254)", async () => {
    const { McpHttpSchema } = await import("../../src/config/schema.ts");
    const result = McpHttpSchema.safeParse({
      name: "evil",
      transport: "http",
      url: "http://169.254.169.254/mcp",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(
        /http.*https.*cloud metadata/i,
      );
    }
  });

  it("rechaza URL con protocolo file:// (path traversal)", async () => {
    const { McpHttpSchema } = await import("../../src/config/schema.ts");
    const result = McpHttpSchema.safeParse({
      name: "evil",
      transport: "http",
      url: "file:///etc/passwd",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza URL con protocolo ftp://", async () => {
    const { McpHttpSchema } = await import("../../src/config/schema.ts");
    const result = McpHttpSchema.safeParse({
      name: "evil",
      transport: "http",
      url: "ftp://files.example.com/mcp",
    });
    expect(result.success).toBe(false);
  });

  it("rechaza URL de metadata Google (metadata.google.internal)", async () => {
    const { McpHttpSchema } = await import("../../src/config/schema.ts");
    const result = McpHttpSchema.safeParse({
      name: "evil",
      transport: "http",
      url: "http://metadata.google.internal/computeMetadata/v1/",
    });
    expect(result.success).toBe(false);
  });

  it("acepta URL https:// válida de servidor externo", async () => {
    const { McpHttpSchema } = await import("../../src/config/schema.ts");
    const result = McpHttpSchema.safeParse({
      name: "valid",
      transport: "http",
      url: "https://valid-server.example.com/mcp",
    });
    expect(result.success).toBe(true);
  });

  it("acepta URL http:// de red LAN (192.168.x.x intencional)", async () => {
    const { McpHttpSchema } = await import("../../src/config/schema.ts");
    const result = McpHttpSchema.safeParse({
      name: "lan",
      transport: "http",
      url: "http://192.168.1.10:8080/mcp",
    });
    expect(result.success).toBe(true);
  });
});
