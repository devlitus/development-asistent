/**
 * Shared types for the MCP transport layer.
 *
 * Defines the MCPTransport interface implemented by both
 * MCPServerProcess (stdio) and MCPHttpClient (HTTP/SSE).
 */

import type { MCPToolInfo, MCPServerInfo } from "./client.ts";

// ─── MCPTransport interface ───────────────────────────────────────

/**
 * Common interface for MCP transport implementations.
 * Both stdio (MCPServerProcess + MCPClient) and HTTP (MCPHttpClient)
 * must satisfy this contract.
 */
export interface MCPTransport {
  initialize(): Promise<MCPServerInfo>;
  listTools(): Promise<MCPToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  stop(): void | Promise<void>;
}

// ─── Config union types ───────────────────────────────────────────
// Single source of truth: Zod-inferred types from config/schema.ts.
// Re-exported here for backward compatibility with existing imports.

export type { McpStdioConfig, McpHttpConfig, McpServerConfigUnion } from "../config/schema.js";
