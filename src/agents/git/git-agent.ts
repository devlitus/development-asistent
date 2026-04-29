/**
 * GitAgent — Sub-agent that handles Git/VCS tasks.
 *
 * Implements the Agent interface with a tool calling loop:
 * LLM → tool_calls → execute tool → feed result → repeat.
 *
 * Security features:
 * - Confirmation required for destructive operations (force push, branch delete)
 * - dangerousAutoApprove option for automated testing
 * - shell:false for all git commands
 */

import type { Agent, AgentContext, AgentResult } from "../../types/agent.ts";
import { AGENT_TYPES } from "../../types/agent.ts";
import type { ChatMessage, ToolResult } from "../../types/llm.ts";
import { GIT_SYSTEM_PROMPT } from "./prompts.ts";
import { GIT_TOOL_SCHEMAS, gitStatus, gitDiff, gitLog, gitCommit, gitBranch, gitPush } from "./tools.ts";
import type { GitToolOptions } from "./tools.ts";
import { PR_TOOL_SCHEMA, createPullRequest } from "./pr-tools.ts";
import { isExtendedContext, parseToolArguments, truncateContent } from "../shared/index.ts";

/** Maximum number of tool calling iterations before forcing a stop. */
const MAX_TOOL_ITERATIONS = 10;

/** Maximum length for tool result content before truncation. */
const MAX_TOOL_RESULT_LENGTH = 10_000; // 10KB

/** Whitelist of allowed tool names — defence in depth. */
const ALLOWED_TOOL_NAMES = new Set([
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_branch",
  "git_push",
  "create_pull_request",
]);

/** All tool schemas combined. */
const ALL_TOOL_SCHEMAS = [...GIT_TOOL_SCHEMAS, PR_TOOL_SCHEMA];

/** Valid branch actions — TS-C2 */
const VALID_BRANCH_ACTIONS = ["create", "switch", "list", "delete"] as const;
type BranchAction = typeof VALID_BRANCH_ACTIONS[number];

export interface GitAgentOptions {
  dangerousAutoApprove?: boolean;
}

/**
 * GitAgent handles Git/VCS tasks.
 *
 * Tool calling loop:
 * 1. Compose messages: [system] + sessionHistory + [user prompt]
 * 2. Call LLM with tools
 * 3. If tool_calls → execute each → feed results → repeat
 * 4. Stop when no more tool_calls or max iterations reached
 */
export class GitAgent implements Agent {
  readonly name = "git-agent";
  readonly type = AGENT_TYPES.GIT;
  readonly systemPrompt = GIT_SYSTEM_PROMPT;

  private readonly toolOptions: GitToolOptions;

  constructor(options?: GitAgentOptions) {
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
          "GitAgent requires ExtendedAgentContext with llmProvider and workspacePath.",
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
    const tools = [...ALL_TOOL_SCHEMAS];

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

        const args = parseToolArguments(tc.arguments, "git-agent");

        let toolResultContent: string;
        let toolSuccess: boolean;

        try {
          const result = await this.executeTool(tc.name, args, workingDir);

          if (result.confirmationRequired) {
            toolResultContent = JSON.stringify({
              confirmation_required: true,
              risk: result.confirmationRequired.risk,
              reason: result.confirmationRequired.reason,
            });
            toolSuccess = false;
          } else if (result.success) {
            toolResultContent =
              typeof result.data === "string"
                ? result.data
                : JSON.stringify(result.data, null, 2);
            toolSuccess = true;
          } else {
            toolResultContent = result.error ?? "Tool execution failed";
            toolSuccess = false;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          toolResultContent = `Tool execution error: ${errorMsg}`;
          toolSuccess = false;
        }

        // Collect the tool result
        allToolResults.push({
          id: tc.id,
          content: toolResultContent,
          status: toolSuccess ? "completed" : "failed",
        });

        // Feed the tool result back to the LLM (truncated if too long)
        messages.push({
          role: "tool",
          content: truncateContent(
            toolSuccess ? toolResultContent : `Error: ${toolResultContent}`,
            MAX_TOOL_RESULT_LENGTH,
          ),
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

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    workspacePath: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string; confirmationRequired?: { reason: string; risk: "sensitive" | "destructive" } }> {
    switch (name) {
      case "git_status":
        return gitStatus(workspacePath);

      case "git_diff":
        return gitDiff(
          {
            staged: typeof args.staged === "boolean" ? args.staged : undefined,
            files: Array.isArray(args.files) ? (args.files as string[]) : undefined,
          },
          workspacePath,
        );

      case "git_log":
        return gitLog(
          {
            limit: typeof args.limit === "number" ? args.limit : undefined,
            since: typeof args.since === "string" ? args.since : undefined,
            author: typeof args.author === "string" ? args.author : undefined,
            path: typeof args.path === "string" ? args.path : undefined,
          },
          workspacePath,
        );

      case "git_commit":
        return gitCommit(
          {
            message: typeof args.message === "string" ? args.message : "",
            files: Array.isArray(args.files) ? (args.files as string[]) : undefined,
          },
          workspacePath,
        );

      case "git_branch": {
        // TS-C2: Validate action before cast
        const action =
          typeof args.action === "string" &&
          VALID_BRANCH_ACTIONS.includes(args.action as BranchAction)
            ? (args.action as BranchAction)
            : null;

        if (action === null) {
          return {
            success: false,
            error: `Invalid branch action: "${String(args.action)}". Must be one of: create, switch, list, delete`,
          };
        }

        return gitBranch(
          {
            action,
            name: typeof args.name === "string" ? args.name : undefined,
          },
          workspacePath,
          this.toolOptions,
        );
      }

      case "git_push":
        return gitPush(
          {
            force: typeof args.force === "boolean" ? args.force : undefined,
            remote: typeof args.remote === "string" ? args.remote : undefined,
            branch: typeof args.branch === "string" ? args.branch : undefined,
          },
          workspacePath,
          this.toolOptions,
        );

      case "create_pull_request":
        return createPullRequest(
          {
            title: typeof args.title === "string" ? args.title : "",
            body: typeof args.body === "string" ? args.body : "",
            base: typeof args.base === "string" ? args.base : undefined,
          },
          workspacePath,
        );

      default:
        return { success: false, error: `Unknown tool: "${name}"` };
    }
  }
}
