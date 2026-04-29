/**
 * Shared utilities for all agent implementations.
 *
 * Extracted from code-agent.ts, os-agent.ts, docs-agent.ts, and git-agent.ts
 * to eliminate duplication (ARCH-01).
 */

import type { AgentContext } from "../../types/agent.ts";
import type { ExtendedAgentContext } from "../../orchestrator/types.ts";

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Type guard: verify that an AgentContext is actually an ExtendedAgentContext.
 *
 * Checks for the presence and type of `llmProvider`, `workspacePath`, and
 * `availableTools`, which are the fields that all agents require beyond the
 * base context. Without validating `availableTools`, a context missing that
 * field would pass the guard and cause a runtime `undefined` access.
 */
export function isExtendedContext(ctx: AgentContext): ctx is ExtendedAgentContext {
  const c = ctx as Record<string, unknown>;
  return (
    "llmProvider" in ctx &&
    "workspacePath" in ctx &&
    "availableTools" in ctx &&
    typeof c.llmProvider === "object" &&
    c.llmProvider !== null &&
    typeof c.workspacePath === "string" &&
    Array.isArray(c.availableTools)
  );
}

// ---------------------------------------------------------------------------
// Tool argument parser
// ---------------------------------------------------------------------------

/**
 * Parse tool arguments from a JSON string.
 * Returns an empty object if parsing fails or if the result is not a plain object.
 * Logs parse errors to stderr for debugging.
 *
 * @param argsStr - Raw JSON string from the LLM tool call
 * @param agentName - Agent name prefix for log messages (e.g. "code-agent")
 */
export function parseToolArguments(
  argsStr: string,
  agentName = "agent",
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsStr);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    console.error(
      `[${agentName}] parseToolArguments: expected object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
    return {};
  } catch (e) {
    console.error(
      `[${agentName}] Failed to parse tool arguments: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// Content truncation
// ---------------------------------------------------------------------------

/**
 * Truncate content to maxBytes, appending an unambiguous truncation notice.
 *
 * SEC FIX: The truncation marker uses unambiguous system delimiters so the LLM
 * cannot mistake it for file content, preventing prompt injection via crafted files.
 *
 * @param content  - The string to truncate
 * @param maxBytes - Maximum byte length before truncation
 */
export function truncateContent(content: string, maxBytes: number): string {
  if (content.length <= maxBytes) return content;
  return (
    content.slice(0, maxBytes) +
    `\n\n--- TOOL OUTPUT TRUNCATED ---\n[Output truncated at ${maxBytes} bytes. Use more specific parameters to retrieve less data.]\n--- END TRUNCATION NOTICE ---`
  );
}
