/**
 * Config loader for personal-asistent.
 *
 * Reads config.toml from disk, validates with Zod, and merges with defaults.
 *
 * Priority: overridePath > ASISTENTE_CONFIG_PATH env var > OS default path
 * If the file doesn't exist, returns DEFAULT_CONFIG.
 */

import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { readFileSync, existsSync, realpathSync } from "fs";
import { parse as parseTOML } from "toml";

// MENOR-1: Consolidated import from schema.ts
import { ConfigSchema, type Config } from "./schema.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";

/**
 * Returns the OS-appropriate default config path.
 * - Windows: %APPDATA%\personal-asistent\config.toml
 * - Linux/macOS: ~/.config/personal-asistent/config.toml
 */
function getDefaultConfigPath(): string {
  const appName = "personal-asistent";
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, appName, "config.toml");
  }
  return join(homedir(), ".config", appName, "config.toml");
}

/**
 * Returns the list of allowed directories for config files.
 * Used to prevent path traversal via ASISTENTE_CONFIG_PATH.
 */
function getAllowedConfigDirs(): string[] {
  const dirs: string[] = [];
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    dirs.push(join(appData, "personal-asistent"));
  } else {
    dirs.push(join(homedir(), ".config", "personal-asistent"));
  }
  // Only allow tmpdir in test environments (NODE_ENV=test or BUN_ENV=test)
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    dirs.push(tmpdir());
  }
  return dirs;
}

/**
 * ALTO-1: Sanitizes a config path from external input (env var).
 * Ensures the resolved path is within allowed directories.
 */
function sanitizeConfigPath(rawPath: string): string {
  const resolved = resolve(rawPath);

  // SEC-06 / FIX-3: Use realpathSync directly with ENOENT handling to avoid TOCTOU.
  // If the file doesn't exist yet (first run), keep the lexical resolved path.
  let canonicalPath = resolved;
  try {
    canonicalPath = realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error("Config path cannot be accessed. Use the default config location.");
    }
    // File doesn't exist yet (first run) — keep resolved path; validation applies lexically
  }

  const allowedDirs = getAllowedConfigDirs();
  const normalize = (p: string): string =>
    process.platform === "win32" ? p.toLowerCase() : p;
  const normalizedResolved = normalize(canonicalPath);
  const isAllowed = allowedDirs.some((dir) => {
    const normalizedDir = normalize(dir);
    return (
      normalizedResolved.startsWith(normalizedDir + "/") ||
      normalizedResolved.startsWith(normalizedDir + "\\") ||
      normalizedResolved === normalizedDir
    );
  });
  if (!isAllowed) {
    // Don't expose the resolved path in the error message
    throw new Error("Config path is outside allowed directories. Use the default config location.");
  }
  return canonicalPath;
}

/**
 * CRÍTICO-2 + MAYOR-1: Deep-merges parsed TOML data with DEFAULT_CONFIG.
 * Works directly with domain types instead of Record<string, unknown>.
 * The parsed data takes precedence; missing keys fall back to defaults.
 */
function mergeWithDefaults(parsed: Record<string, unknown>): Config {
  // Extract typed sections from parsed TOML
  const parsedAgents = (parsed.agents ?? {}) as Record<string, unknown>;
  const parsedContext = (parsed.context ?? {}) as Partial<
    typeof DEFAULT_CONFIG.context
  >;
  const parsedMcp = (parsed.mcp ?? {}) as Partial<typeof DEFAULT_CONFIG.mcp>;

  // Deep merge agents: per-agent deep merge (allows partial agent overrides)
  const mergedAgents: Record<string, unknown> = { ...DEFAULT_CONFIG.agents };
  for (const [key, value] of Object.entries(parsedAgents)) {
    const defaultAgent =
      DEFAULT_CONFIG.agents[key] ?? DEFAULT_CONFIG.agents.orchestrator;
    mergedAgents[key] = { ...defaultAgent, ...(value as Record<string, unknown>) };
  }

  // Deep merge context: defaults + parsed overrides
  const mergedContext = { ...DEFAULT_CONFIG.context, ...parsedContext };

  // Deep merge mcp: merge servers array (use parsed if present, else default)
  const mergedMcp = {
    ...DEFAULT_CONFIG.mcp,
    ...parsedMcp,
  };

  return {
    agents: mergedAgents,
    context: mergedContext,
    mcp: mergedMcp,
  } as Config;
}

/**
 * Loads and validates the configuration from disk.
 *
 * @param overridePath - Optional explicit path to config.toml. Takes priority
 *   over ASISTENTE_CONFIG_PATH env var and the OS default path.
 * @returns Validated Config object (merged with defaults).
 * @throws Error with descriptive message if the file exists but is invalid.
 */
export function loadConfig(overridePath?: string): Config {
  // ALTO-1: Only sanitize ASISTENTE_CONFIG_PATH (external input).
  // overridePath is a programmatic internal interface, not external input.
  let configPath: string;
  if (overridePath !== undefined) {
    configPath = overridePath;
  } else if (process.env.ASISTENTE_CONFIG_PATH !== undefined) {
    configPath = sanitizeConfigPath(process.env.ASISTENTE_CONFIG_PATH);
  } else {
    configPath = getDefaultConfigPath();
  }

  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  // MENOR-2: Limit config file size to 1 MB (read first to avoid TOCTOU)
  const MAX_CONFIG_SIZE_BYTES = 1 * 1024 * 1024;
  const raw = readFileSync(configPath, "utf-8");
  if (Buffer.byteLength(raw, "utf-8") > MAX_CONFIG_SIZE_BYTES) {
    throw new Error("Config file exceeds maximum allowed size (1 MB)");
  }

  const parsed = parseTOML(raw) as Record<string, unknown>;

  const merged = mergeWithDefaults(parsed);

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    // ALTO-2: Replace homedir with ~ to avoid exposing absolute paths
    const safePath = configPath.replace(homedir(), "~");
    throw new Error(`Invalid config at ${safePath}:\n${errors}`);
  }

  // CRÍTICO-1: Removed redundant `as Config` cast — Zod already infers the correct type
  return result.data;
}
