/**
 * Zod schema for personal-asistent configuration (config.toml).
 *
 * Validates:
 * - agents: map of agent name → { provider, model }
 * - mcp.servers: array of MCP server configs
 * - context: context window parameters
 */

import { z } from "zod";

export const AgentConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "ollama", "llamacpp", "lmstudio"]),
  model: z.string().min(1),
});

export const McpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
});

/**
 * Schema for stdio MCP server (local subprocess).
 * Backward-compatible: transport defaults to 'stdio' if omitted.
 */
export const McpStdioSchema = z.object({
  name: z.string().min(1),
  transport: z.literal("stdio").optional().default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
  timeout: z.number().int().positive().optional(),
});

/**
 * Schema for HTTP/SSE MCP server (remote).
 *
 * Security (SEC-SSRF): Only http: and https: protocols are allowed.
 * Cloud metadata endpoints (169.254.169.254, metadata.google.internal) are blocked.
 */
export const McpHttpSchema = z.object({
  name: z.string().min(1),
  transport: z.literal("http"),
  url: z.string().url().refine((url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") return false;
      return true;
    } catch { return false; }
  }, { message: "MCP HTTP URL must use http:// or https:// and not target cloud metadata endpoints" }),
  apiKey: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});

/**
 * Union schema for all supported MCP server configurations.
 * Discriminated by the 'transport' field (default: 'stdio').
 */
export const McpServerSchemaUnion = z.union([McpHttpSchema, McpStdioSchema]);

export const ConfigSchema = z.object({
  agents: z.record(z.string(), AgentConfigSchema).optional().default({}),
  mcp: z
    .object({
      servers: z.array(McpServerSchemaUnion).optional().default([]),
    })
    .optional()
    .default({ servers: [] }),
  context: z
    .object({
      maxTokens: z.number().int().positive().default(100000),
      summaryThreshold: z.number().min(0).max(1).default(0.7),
    })
    .optional()
    .default({}),
  /**
   * HTTP User-Agent header used by the DocsAgent when making web requests.
   * Defaults to a generic agent string to avoid revealing implementation details.
   * Set this to a custom value if you need to identify your agent to web services.
   */
  userAgent: z.string().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type McpStdioConfig = z.infer<typeof McpStdioSchema>;
export type McpHttpConfig = z.infer<typeof McpHttpSchema>;
export type McpServerConfigUnion = z.infer<typeof McpServerSchemaUnion>;
export type ContextConfig = z.infer<typeof ConfigSchema>["context"];
export type Config = z.infer<typeof ConfigSchema>;
