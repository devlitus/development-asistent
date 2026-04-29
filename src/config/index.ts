/**
 * Public API for the config module.
 *
 * Usage:
 *   import { getConfig, resetConfigCache } from "./config/index.ts";
 *
 *   const config = getConfig();
 *   // config.agents.orchestrator.provider → "anthropic"
 */

import { loadConfig } from "./loader.ts";
import type { Config } from "./schema.ts";

export { loadConfig } from "./loader.ts";
export { DEFAULT_CONFIG } from "./defaults.ts";
export type { Config, AgentConfig, McpServerConfig, ContextConfig } from "./schema.ts";

let cachedConfig: Config | null = null;

/**
 * Returns the application configuration, loading and caching it on first call.
 *
 * @param configPath - Optional explicit path to config.toml (useful in tests).
 *   Only used on the first call (before the cache is populated).
 */
export function getConfig(configPath?: string): Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = loadConfig(configPath);
  return cachedConfig;
}

/**
 * Resets the configuration cache.
 * Intended for use in tests to avoid cross-test contamination.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
