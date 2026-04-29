/**
 * CodeAgent — Sub-agent that handles code-related tasks.
 *
 * Implements the Agent interface with a tool calling loop:
 * LLM → tool_calls → execute tool → feed result → repeat.
 *
 * Accesses LLMProvider and workspacePath via ExtendedAgentContext
 * (validated with an explicit type guard, since the Orchestrator
 * always passes the extended version).
 */

import type { Agent, AgentContext, AgentResult } from "../../types/agent.ts";
import { AGENT_TYPES } from "../../types/agent.ts";
import type { ChatMessage, ToolResult } from "../../types/llm.ts";
import { CODE_SYSTEM_PROMPT } from "./prompts.ts";
import { CODE_AGENT_TOOLS, getToolSchemas, executeTool } from "./tools.ts";
import { isExtendedContext, parseToolArguments, truncateContent } from "../shared/index.ts";

/** Maximum number of tool calling iterations before forcing a stop. */
const MAX_TOOL_ITERATIONS = 10;

/** Maximum bytes for tool result content before truncation. Exported for tests. */
export const MAX_TOOL_RESULT_BYTES = 10_240;

/** Set of tool names that are read-only (safe to run in parallel). Exported for tests. */
export const READONLY_TOOLS = new Set(['read_file', 'list_directory', 'search_code']);

/** Whitelist of allowed tool names — defence in depth. */
const ALLOWED_TOOL_NAMES = new Set(CODE_AGENT_TOOLS.map((t) => t.name));

/**
 * CodeAgent handles code-related tasks with filesystem tools.
 *
 * Tool calling loop:
 * 1. Compose messages: [system] + sessionHistory + [user prompt]
 * 2. Call LLM with tools
 * 3. If tool_calls → execute each → feed results → repeat
 * 4. Stop when no more tool_calls or max iterations reached
 */
export class CodeAgent implements Agent {
  readonly name = "code-agent";
  readonly type = AGENT_TYPES.CODE;
  readonly systemPrompt = CODE_SYSTEM_PROMPT;

  async execute(context: AgentContext): Promise<AgentResult> {
    // Validate that the context is an ExtendedAgentContext
    if (!isExtendedContext(context)) {
      return {
        success: false,
        output:
          "CodeAgent requires ExtendedAgentContext with llmProvider and workspacePath.",
        error: "Missing ExtendedAgentContext",
      };
    }
    const provider = context.llmProvider;
    const workspacePath = context.workspacePath;

    // 1. Compose messages
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...(context.sessionHistory ?? []),
      { role: "user", content: context.prompt },
    ];

    // Collect all tool results across iterations
    const allToolResults: ToolResult[] = [];
    const tools = getToolSchemas();

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
          toolCalls:
            allToolResults.length > 0 ? allToolResults : undefined,
        };
      }

      // If no tool calls, we're done — return the final content
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          success: true,
          output: response.content,
          toolCalls:
            allToolResults.length > 0 ? allToolResults : undefined,
        };
      }

      // Add assistant message with tool_calls to conversation
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // PERF-03: Determine if all tool calls are readonly → run in parallel
      const allReadonly = response.tool_calls.every((tc) => READONLY_TOOLS.has(tc.name));

      // Helper: execute a single tool call and return its result with index
      const executeOne = async (tc: typeof response.tool_calls[number], index: number) => {
        // Whitelist check — defence in depth
        if (!ALLOWED_TOOL_NAMES.has(tc.name)) {
          const errorMsg = `Unknown tool: "${tc.name}"`;
          return {
            index,
            tc,
            toolResult: { id: tc.id, content: errorMsg, status: "failed" as const },
            messageContent: `Error: ${errorMsg}`,
          };
        }

        const args = parseToolArguments(tc.arguments, "code-agent");
        let result;
        try {
          result = await executeTool(tc.name, args, workspacePath);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          result = { content: "", error: errorMsg, success: false };
        }

        const rawContent = result.error ? `Error: ${result.error}` : result.content;
        return {
          index,
          tc,
          toolResult: {
            id: tc.id,
            content: result.content,
            status: result.success ? "completed" as const : "failed" as const,
          },
          // PERF-02: truncate before adding to history
          messageContent: truncateContent(rawContent, MAX_TOOL_RESULT_BYTES),
        };
      };

      // Execute: parallel if all readonly, serial otherwise
      let execResults: Awaited<ReturnType<typeof executeOne>>[];
      if (allReadonly) {
        execResults = await Promise.all(
          response.tool_calls.map((tc, i) => executeOne(tc, i)),
        );
        // Preserve original order
        execResults.sort((a, b) => a.index - b.index);
      } else {
        execResults = [];
        for (let i = 0; i < response.tool_calls.length; i++) {
          execResults.push(await executeOne(response.tool_calls[i]!, i));
        }
      }

      // Collect results and feed back to LLM
      for (const { toolResult, tc, messageContent } of execResults) {
        allToolResults.push(toolResult);
        messages.push({
          role: "tool",
          content: messageContent,
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
