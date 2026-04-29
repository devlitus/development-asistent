/**
 * Code agent barrel export.
 *
 * Re-exports the CodeAgent class and public types
 * for convenient importing.
 */

export { CodeAgent } from "./code-agent.ts";
export { CODE_SYSTEM_PROMPT } from "./prompts.ts";
export type { CodeToolResult, CodeToolDefinition } from "./types.ts";
export {
  CODE_AGENT_TOOLS,
  getToolSchemas,
  executeTool,
  isPathWithinWorkspace,
} from "./tools.ts";
