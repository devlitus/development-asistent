/**
 * MCPHttpClient — HTTP transport for remote MCP servers.
 *
 * Implements the MCPTransport interface for servers accessible via HTTP.
 * Supports optional Bearer token authentication.
 *
 * SECURITY: Validates URLs against private IP ranges (SSRF prevention)
 * using the textual check from validateUrl. Note: DNS pre-resolution
 * is skipped here to avoid requiring Bun.dns in all environments;
 * the textual IP check covers the most common SSRF vectors.
 *
 * Protocol:
 *   - initialize() → POST /initialize
 *   - listTools()  → GET  /tools
 *   - callTool()   → POST /tools/call
 */

import type { MCPTransport } from "./types.ts";
import type { MCPServerInfo, MCPToolInfo } from "./client.ts";

// Use Bun's native fetch to avoid being affected by globalThis.fetch mocks
// in test files (e.g. local-providers.test.ts mocks globalThis.fetch).
// Bun.fetch is the underlying implementation and is not affected by mocks.
const nativeFetch: typeof fetch = (
  (globalThis as Record<string, unknown>)["Bun"] as
    | { fetch?: typeof fetch }
    | undefined
)?.fetch ?? globalThis.fetch;

// ─── Private IP patterns (SSRF prevention) ───────────────────────
// Mirrors the patterns in src/agents/docs/tools/fetch.ts

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^0\./,
  /^169\.254\./,
  /^100\.64\./,
  /^::ffff:/i,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

const PRIVATE_HOSTNAMES = new Set(["localhost", "::1"]);

/**
 * Validates a URL against SSRF patterns (textual check only).
 * Throws if the URL is invalid or points to a private/reserved address.
 */
function assertSafeUrl(urlStr: string): URL {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`MCPHttpClient: invalid URL: ${urlStr}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `MCPHttpClient: SSRF blocked — unsupported protocol: ${url.protocol}`,
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (PRIVATE_HOSTNAMES.has(hostname)) {
    throw new Error(
      `MCPHttpClient: SSRF blocked — private hostname: "${hostname}"`,
    );
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new Error(
        `MCPHttpClient: SSRF blocked — private IP address: "${hostname}"`,
      );
    }
  }

  return url;
}

// ─── MCPHttpClient ────────────────────────────────────────────────

export interface MCPHttpClientConfig {
  /** Base URL of the MCP HTTP server (e.g. "https://mcp.example.com"). */
  readonly url: string;
  /** Optional API key for Bearer token authentication. */
  readonly apiKey?: string;
  /** Request timeout in milliseconds. Default: 10000. */
  readonly timeout?: number;
  /**
   * @internal TEST ONLY — skip SSRF validation.
   * Never set this in production code. Used only for unit tests
   * that spin up local mock servers on 127.0.0.1.
   */
  readonly _allowPrivateUrls?: boolean;
  /**
   * @internal TEST ONLY — injectable fetch function.
   * Allows tests to bypass a mocked globalThis.fetch.
   * Never set this in production code.
   */
  readonly _fetch?: typeof fetch;
}

/**
 * HTTP transport client for remote MCP servers.
 *
 * Implements MCPTransport using simple HTTP REST endpoints.
 * Must call initialize() before listTools() or callTool().
 */
export class MCPHttpClient implements MCPTransport {
  private initialized = false;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly allowPrivateUrls: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(config: MCPHttpClientConfig) {
    this.baseUrl = config.url.replace(/\/$/, ""); // strip trailing slash
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 10_000;
    this.allowPrivateUrls = config._allowPrivateUrls ?? false;
    // Use injected fetch, or Bun's native fetch (not affected by globalThis.fetch mocks)
    this.fetchFn = config._fetch ?? nativeFetch;
  }

  /**
   * Performs the MCP initialize handshake via POST /initialize.
   *
   * @returns Server information (name, version)
   * @throws if URL is private (SSRF) or request fails
   */
  async initialize(): Promise<MCPServerInfo> {
    // SSRF check — throws if URL is private (unless _allowPrivateUrls is set for tests)
    if (!this.allowPrivateUrls) {
      assertSafeUrl(this.baseUrl);
    }

    const result = await this.post<{
      serverInfo?: { name?: string; version?: string };
    }>("/initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "personal-asistent", version: "0.1.0" },
    });

    this.initialized = true;

    return {
      name: result.serverInfo?.name ?? "unknown",
      version: result.serverInfo?.version ?? "0.0.0",
    };
  }

  /**
   * Lists all tools available on the remote MCP server via GET /tools.
   *
   * @returns Array of tool definitions
   * @throws if not initialized or request fails
   */
  async listTools(): Promise<MCPToolInfo[]> {
    this.assertInitialized();

    const result = await this.get<{ tools?: unknown[] }>("/tools");

    if (!Array.isArray(result.tools)) {
      return [];
    }

    return result.tools.map((t) => {
      const tool = t as {
        name?: string;
        description?: string;
        inputSchema?: unknown;
      };
      return {
        name: tool.name ?? "",
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? {},
      };
    });
  }

  /**
   * Calls a tool on the remote MCP server via POST /tools/call.
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Tool result as string
   * @throws if not initialized or request fails
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.assertInitialized();

    const result = await this.post<{
      content?: unknown[];
      error?: string;
    }>("/tools/call", { name, arguments: args });

    if (result.error) {
      throw new Error(`MCPHttpClient: tool error: ${result.error}`);
    }

    if (!Array.isArray(result.content)) {
      return "";
    }

    return result.content
      .filter(
        (item): item is { type: string; text: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string",
      )
      .map((item) => item.text)
      .join("\n");
  }

  /**
   * No-op for HTTP transport (no persistent connection to close).
   */
  stop(): void {
    // HTTP is stateless — nothing to close
  }

  // ─── Private helpers ──────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MCPHttpClient: POST ${path} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `MCPHttpClient: POST ${path} → HTTP ${response.status}: ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MCPHttpClient: GET ${path} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `MCPHttpClient: GET ${path} → HTTP ${response.status}: ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "MCPHttpClient: must call initialize() before using the client",
      );
    }
  }
}
