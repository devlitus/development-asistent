/**
 * MCPToolRegistry — manages multiple MCP servers and exposes their
 * tools as ToolDefinition[] for the orchestrator and sub-agents.
 *
 * Usage:
 *   const registry = new MCPToolRegistry();
 *   await registry.start(configs);
 *   const tools = registry.getTools();  // inject into availableTools
 *   // Tools are namespaced: "serverName__toolName"
 *   const result = await registry.callTool("mock__echo", { input: "hello" });
 *   await registry.stop();
 *
 * SECURITY NOTE: MCP servers run as subprocesses with the same privileges
 * as this process. Only configure servers from trusted sources.
 *
 * NAMESPACING: Tool names are prefixed with the server name to prevent
 * collisions between MCP tools and internal agent tools (e.g. a MCP server
 * cannot shadow the built-in "read_file" tool).
 * Format: "<serverName>__<toolName>"
 *
 * ARCH-04: Servers are started in parallel using Promise.allSettled.
 * Partial failures are graceful — failed servers are logged as warnings
 * and the registry continues with the available servers.
 * Only if ALL servers fail is a fatal error thrown.
 *
 * ARCH-05: Supports both stdio (MCPServerProcess) and HTTP (MCPHttpClient)
 * transports, selected by the 'transport' field in the config.
 */

import { MCPServerProcess } from "./server-process.ts";
import { MCPClient } from "./client.ts";
import { MCPHttpClient } from "./http-client.ts";
import type { MCPServerConfig } from "./server-process.ts";
import type { MCPTransport, McpServerConfigUnion } from "./types.ts";
import type { ToolDefinition } from "../orchestrator/types.ts";

// ─── Security constants ───────────────────────────────────────────

/**
 * SEC-08: Maximum number of tools a single MCP server may register.
 * If a server returns more tools, only the first MAX_TOOLS_PER_SERVER
 * are registered (graceful truncation, non-fatal).
 */
export const MAX_TOOLS_PER_SERVER = 256;

// ─── Internal transport wrapper ───────────────────────────────────

/**
 * Wraps a transport (stdio or HTTP) with a unified interface
 * matching what MCPClient provides for stdio.
 */
interface TransportHandle {
  transport: MCPTransport;
  /** For stdio: the MCPServerProcess to stop. For HTTP: null. */
  process: MCPServerProcess | null;
}

/**
 * Manages multiple MCP server connections and aggregates their tools.
 *
 * Provides a unified interface for the orchestrator to:
 * - Discover all available MCP tools (namespaced as serverName__toolName)
 * - Invoke any MCP tool by qualified name
 */
export class MCPToolRegistry {
  /** Maps server name → transport handle */
  private readonly handles = new Map<string, TransportHandle>();
  /** Maps qualified tool name (serverName__toolName) → server name */
  private readonly toolToServer = new Map<string, string>();
  /** Maps qualified tool name → original tool name (for MCP invocation) */
  private readonly toolToOriginalName = new Map<string, string>();
  private readonly toolList: ToolDefinition[] = [];

  /**
   * Starts all configured MCP servers in parallel and discovers their tools.
   *
   * ARCH-04: Uses Promise.allSettled so a failing server does not block others.
   * - If some servers fail → log warnings, continue with available servers.
   * - If ALL servers fail → throw fatal error.
   * - If no servers configured → resolve immediately (no-op).
   *
   * ARCH-05: Selects transport based on config.transport field:
   * - 'stdio' (or missing) → MCPServerProcess + MCPClient
   * - 'http' → MCPHttpClient
   *
   * @param configs - Array of MCP server configurations (stdio or HTTP)
   * @throws {Error} if already started or if ALL servers fail
   */
  async start(configs: readonly (MCPServerConfig | McpServerConfigUnion)[]): Promise<void> {
    if (this.handles.size > 0) {
      throw new Error("MCPToolRegistry: already started. Call stop() first.");
    }

    if (configs.length === 0) {
      return;
    }

    // ARCH-04: Start all servers in parallel
    const results = await Promise.allSettled(
      configs.map((config) => this.startOne(config)),
    );

    // Collect failures and successes
    const failures: Array<{ name: string; error: Error }> = [];
    let successCount = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const config = configs[i];
      const name = config.name;

      if (result.status === "rejected") {
        const err = result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason));
        failures.push({ name, error: err });
        process.stderr.write(
          `[mcp:registry] WARN: server "${name}" failed to start: ${err.message}\n`,
        );
      } else {
        successCount++;
      }
    }

    // ARCH-04: If ALL servers failed → fatal error
    if (successCount === 0 && failures.length > 0) {
      const errorMessages = failures.map((f) => `${f.name}: ${f.error.message}`).join("; ");
      throw new Error(
        `MCPToolRegistry: all servers failed to start. Errors: ${errorMessages}`,
      );
    }
  }

  /**
   * Returns all discovered tools as ToolDefinition[].
   * Tool names are namespaced: "<serverName>__<toolName>".
   * Suitable for injection into ExtendedAgentContext.availableTools.
   */
  getTools(): readonly ToolDefinition[] {
    return this.toolList;
  }

  /**
   * Invokes a tool by qualified name and returns the result as a string.
   *
   * @param name - Qualified tool name in format "serverName__toolName"
   * @param args - Tool arguments
   * @returns Tool result as string
   * @throws {Error} if tool not found or invocation fails
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const serverName = this.toolToServer.get(name);
    if (!serverName) {
      throw new Error(`MCPToolRegistry: tool not found: "${name}"`);
    }

    const handle = this.handles.get(serverName);
    if (!handle) {
      throw new Error(
        `MCPToolRegistry: transport not found for server "${serverName}"`,
      );
    }

    // Use the original (un-namespaced) tool name when calling the MCP server
    const originalName = this.toolToOriginalName.get(name) ?? name;
    return handle.transport.callTool(originalName, args);
  }

  /**
   * Stops all MCP server connections and clears the tool registry.
   * Idempotent — safe to call multiple times.
   */
  async stop(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const handle of this.handles.values()) {
      const result = handle.transport.stop();
      if (result instanceof Promise) {
        stopPromises.push(result);
      }
    }

    await Promise.allSettled(stopPromises);

    this.handles.clear();
    this.toolToServer.clear();
    this.toolToOriginalName.clear();
    this.toolList.length = 0;
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Starts a single MCP server and registers its tools.
   * Called in parallel by start() via Promise.allSettled.
   */
  private async startOne(config: MCPServerConfig | McpServerConfigUnion): Promise<void> {
    const transport = await this.createTransport(config);

    const tools = await transport.listTools();

    // SEC-08: Cap tools per server to prevent LLM context saturation.
    let effectiveTools = tools;
    if (tools.length > MAX_TOOLS_PER_SERVER) {
      process.stderr.write(
        `[mcp:${config.name}] Server ${config.name}: ${tools.length} tools registered, truncated to ${MAX_TOOLS_PER_SERVER}\n`,
      );
      effectiveTools = tools.slice(0, MAX_TOOLS_PER_SERVER);
    }

    // Register server
    this.handles.set(config.name, {
      transport,
      process: null, // process reference not needed here; stop() uses transport.stop()
    });

    // S2 FIX: Namespace tool names with server prefix to prevent collision
    for (const tool of effectiveTools) {
      const qualifiedName = `${config.name}__${tool.name}`;
      const toolDef: ToolDefinition = {
        name: qualifiedName,
        description: tool.description,
        parameters: tool.inputSchema,
      };
      this.toolList.push(toolDef);
      this.toolToServer.set(qualifiedName, config.name);
      this.toolToOriginalName.set(qualifiedName, tool.name);
    }
  }

  /**
   * Creates and initializes the appropriate transport for the given config.
   *
   * ARCH-05: Selects transport based on config.transport:
   * - 'http' → MCPHttpClient
   * - 'stdio' or missing → MCPServerProcess + MCPClient (backward compat)
   */
  private async createTransport(
    config: MCPServerConfig | McpServerConfigUnion,
  ): Promise<MCPTransport> {
    // Discriminate on the 'transport' field using type-safe narrowing.
    // MCPServerConfig (legacy) has no 'transport' field → defaults to stdio.
    // McpServerConfigUnion always has 'transport' present (Zod default: 'stdio').
    if ("transport" in config && config.transport === "http") {
      const client = new MCPHttpClient({
        url: config.url,
        apiKey: config.apiKey,
        timeout: config.timeout,
        // Pass through test-only flag if present (not part of McpHttpConfig schema)
        _allowPrivateUrls: ("_allowPrivateUrls" in config)
          ? (config as { _allowPrivateUrls?: boolean })._allowPrivateUrls
          : undefined,
      });
      await client.initialize();
      return client;
    }

    // stdio transport (default) — works for both MCPServerConfig and McpStdioConfig
    const proc = new MCPServerProcess({
      name: config.name,
      command: config.command,
      args: config.args ?? [],
      env: config.env,
      timeout: config.timeout,
    });
    await proc.start();

    const client = new MCPClient(proc);
    await client.initialize();

    // Wrap MCPClient to satisfy MCPTransport interface
    return {
      initialize: () => client.initialize(),
      listTools: () => client.listTools(),
      callTool: (name, args) => client.callTool(name, args),
      stop: () => proc.stop(),
    };
  }
}
