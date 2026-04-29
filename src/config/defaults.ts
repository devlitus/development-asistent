/**
 * Default configuration values for personal-asistent.
 *
 * These are used when no config.toml is found or when the file
 * only partially overrides the configuration.
 */

import type { Config, McpServerConfig } from "./schema.ts";

// MAYOR-2: Use Object.freeze to prevent accidental mutations
export const DEFAULT_CONFIG: Config = Object.freeze({
  agents: Object.freeze({
    orchestrator: Object.freeze({ provider: "anthropic" as const, model: "claude-sonnet-4-5" }),
    code: Object.freeze({ provider: "anthropic" as const, model: "claude-sonnet-4-5" }),
    os: Object.freeze({ provider: "anthropic" as const, model: "claude-sonnet-4-5" }),
    docs: Object.freeze({ provider: "anthropic" as const, model: "claude-sonnet-4-5" }),
    git: Object.freeze({ provider: "anthropic" as const, model: "claude-sonnet-4-5" }),
  }),
  mcp: Object.freeze({ servers: [] as readonly McpServerConfig[] }),
  context: Object.freeze({
    maxTokens: 100000,
    summaryThreshold: 0.7,
  }),
}) as Config;
