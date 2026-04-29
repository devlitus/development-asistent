/**
 * MCP module barrel export.
 *
 * Exports all public types and classes for the MCP integration:
 * - MCPServerProcess: manages a single MCP server subprocess
 * - MCPClient: high-level MCP protocol client
 * - MCPHttpClient: HTTP/SSE transport for remote MCP servers
 * - MCPToolRegistry: aggregates tools from multiple MCP servers
 * - MCPTransport: common interface for all transport implementations
 */

export { MCPServerProcess } from "./server-process.ts";
export type { MCPServerConfig } from "./server-process.ts";

export { MCPClient } from "./client.ts";
export type { MCPServerInfo, MCPToolInfo } from "./client.ts";

export { MCPHttpClient } from "./http-client.ts";

export { MCPToolRegistry } from "./tool-registry.ts";

export type { MCPTransport, McpServerConfigUnion, McpStdioConfig, McpHttpConfig } from "./types.ts";
