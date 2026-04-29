/**
 * MCPClient — high-level client for the Model Context Protocol.
 *
 * Wraps MCPServerProcess to provide typed methods for the MCP
 * JSON-RPC protocol: initialize, tools/list, tools/call.
 *
 * Usage:
 *   const proc = new MCPServerProcess(config);
 *   await proc.start();
 *   const client = new MCPClient(proc);
 *   const info = await client.initialize();
 *   const tools = await client.listTools();
 *   const result = await client.callTool("echo", { input: "hello" });
 */

import type { MCPServerProcess } from "./server-process.ts";
export type { MCPServerConfig } from "./server-process.ts";

// ─── Types ────────────────────────────────────────────────────────

/** Information about the MCP server returned by initialize. */
export interface MCPServerInfo {
  readonly name: string;
  readonly version: string;
}

/** A single tool as returned by tools/list. */
export interface MCPToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

// ─── MCPClient ────────────────────────────────────────────────────

/**
 * High-level MCP client that communicates with a single MCP server.
 *
 * Must call initialize() before listTools() or callTool().
 */
export class MCPClient {
  private initialized = false;

  constructor(private readonly serverProcess: MCPServerProcess) {}

  /**
   * Performs the MCP initialize handshake.
   *
   * Sends the initialize request and then the notifications/initialized
   * notification. Must be called before any other method.
   *
   * @returns Server information (name, version)
   * @throws {Error} if the handshake fails
   */
  async initialize(): Promise<MCPServerInfo> {
    const result = await this.serverProcess.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "personal-asistent",
        version: "0.1.0",
      },
    });

    // Send the initialized notification (no response expected)
    this.serverProcess.sendNotification("notifications/initialized");

    this.initialized = true;

    const res = result as {
      serverInfo?: { name?: string; version?: string };
    };

    return {
      name: res.serverInfo?.name ?? "unknown",
      version: res.serverInfo?.version ?? "0.0.0",
    };
  }

  /**
   * Lists all tools available on the MCP server.
   *
   * @returns Array of tool definitions
   * @throws {Error} if not initialized or request fails
   */
  async listTools(): Promise<MCPToolInfo[]> {
    this.assertInitialized();

    const result = await this.serverProcess.sendRequest("tools/list", {});
    const res = result as { tools?: unknown[] };

    if (!Array.isArray(res.tools)) {
      return [];
    }

    return res.tools.map((t) => {
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
   * Calls a tool on the MCP server and returns the result as a string.
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns The tool result as a string (concatenated text content)
   * @throws {Error} if not initialized, tool not found, or request fails
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    this.assertInitialized();

    const result = await this.serverProcess.sendRequest("tools/call", {
      name,
      arguments: args,
    });

    const res = result as {
      content?: unknown[];
      isError?: boolean;
    };

    // Validate content is an array
    if (!Array.isArray(res.content)) {
      return "";
    }

    // Concatenate all text content items
    return res.content
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

  // ─── Private ──────────────────────────────────────────────────

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "MCPClient: must call initialize() before using the client",
      );
    }
  }
}
