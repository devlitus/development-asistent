/**
 * OSAgent — Sub-agent that handles OS/shell tasks.
 *
 * Implements the Agent interface with a tool calling loop:
 * LLM → tool_calls → execute tool → feed result → repeat.
 *
 * Security features:
 * - Risk assessment for all commands
 * - Permission gate for sensitive/destructive commands
 * - dangerousAutoApprove option for automated testing
 */

import type { Agent, AgentContext, AgentResult } from "../../types/agent.ts";
import { AGENT_TYPES } from "../../types/agent.ts";
import type { ChatMessage, ToolResult } from "../../types/llm.ts";
import { OS_SYSTEM_PROMPT } from "./prompts.ts";
import { OS_AGENT_TOOLS, getOsToolSchemas, executeOsTool, redactSensitiveData } from "./tools.ts";
import type { OsToolOptions } from "./tools.ts";
import { isExtendedContext, parseToolArguments, truncateContent } from "../shared/index.ts";

/** Maximum number of tool calling iterations before forcing a stop. */
const MAX_TOOL_ITERATIONS = 10;

/** Maximum length for tool result content before truncation. */
const MAX_TOOL_RESULT_LENGTH = 10_000; // 10KB

/** Whitelist of allowed tool names — defence in depth. */
const ALLOWED_TOOL_NAMES = new Set(OS_AGENT_TOOLS.map((t) => t.name));

export interface OSAgentOptions {
  dangerousAutoApprove?: boolean;
}

/**
 * OSAgent handles OS/shell tasks with the execute_command tool.
 *
 * Tool calling loop:
 * 1. Compose messages: [system] + sessionHistory + [user prompt]
 * 2. Call LLM with tools
 * 3. If tool_calls → execute each → feed results → repeat
 * 4. Stop when no more tool_calls or max iterations reached
 */
export class OSAgent implements Agent {
  readonly name = "os-agent";
  readonly type = AGENT_TYPES.OS;
  readonly systemPrompt = OS_SYSTEM_PROMPT;

  private readonly toolOptions: OsToolOptions;

  constructor(options?: OSAgentOptions) {
    this.toolOptions = {
      dangerousAutoApprove: options?.dangerousAutoApprove ?? false,
    };
  }

  async execute(context: AgentContext): Promise<AgentResult> {
    // Validate that the context is an ExtendedAgentContext
    if (!isExtendedContext(context)) {
      return {
        success: false,
        output:
          "OSAgent requires ExtendedAgentContext with llmProvider and workspacePath.",
        error: "Missing ExtendedAgentContext",
      };
    }

    const provider = context.llmProvider;
    const workingDir = context.workspacePath;

    // 1. Compose messages
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...(context.sessionHistory ?? []),
      { role: "user", content: context.prompt },
    ];

    // Collect all tool results across iterations
    const allToolResults: ToolResult[] = [];
    const tools = getOsToolSchemas();

    // 2. Tool calling loop
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      let response;

      try {
        response = await provider.chat(messages, { tools });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `LLM provider error: ${errorMsg}`,
          error: errorMsg,
          toolCalls: allToolResults.length > 0 ? allToolResults : undefined,
        };
      }

      // If no tool calls, we're done — return the final content
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          success: true,
          output: response.content,
          toolCalls: allToolResults.length > 0 ? allToolResults : undefined,
        };
      }

      // Add assistant message with tool_calls to conversation
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // Execute each tool call and add results
      for (const tc of response.tool_calls) {
        // Whitelist check — defence in depth
        if (!ALLOWED_TOOL_NAMES.has(tc.name)) {
          const errorMsg = `Unknown tool: "${tc.name}"`;
          allToolResults.push({
            id: tc.id,
            content: errorMsg,
            status: "failed",
          });
          messages.push({
            role: "tool",
            content: `Error: ${errorMsg}`,
            tool_call_id: tc.id,
          });
          continue;
        }

        const args = parseToolArguments(tc.arguments, "os-agent");

        let result;
        try {
          result = await executeOsTool(tc.name, args, workingDir, this.toolOptions);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          result = {
            content: "",
            error: errorMsg,
            success: false,
          };
        }

        // Collect the tool result
        allToolResults.push({
          id: tc.id,
          content: result.content,
          status: result.success ? "completed" : "failed",
        });

        // Build the message content — include permissionRequired info if present
        let toolResultContent: string;
        if (result.permissionRequired) {
          toolResultContent = JSON.stringify({
            permission_required: true,
            risk: result.permissionRequired.risk,
            reason: result.permissionRequired.reason,
          });
        } else {
          toolResultContent = result.error
            ? `Error: ${result.error}`
            : result.content;
        }

        // Redact sensitive data before feeding back to the LLM (A3)
        const safeContent = redactSensitiveData(toolResultContent);

        // Feed the tool result back to the LLM (truncated if too long)
        messages.push({
          role: "tool",
          content: truncateContent(safeContent, MAX_TOOL_RESULT_LENGTH),
          tool_call_id: tc.id,
        });
      }
    }

    // Max iterations reached — return partial output with warning
    return {
      success: true,
      output: `Maximum tool iterations reached. Task may be incomplete.`,
      toolCalls: allToolResults,
    };
  }
}
