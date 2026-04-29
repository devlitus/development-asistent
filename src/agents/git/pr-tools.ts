/**
 * Git Agent PR tools: create_pull_request via gh or glab CLI.
 */

import type { GitToolResult } from "./tools.ts";
import { redactCredentials } from "./tools.ts";
import { execCommand } from "./exec.ts";

export type PRUrl = string;

export interface CreatePRArgs {
  title: string;
  body: string;
  base?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** PERF-08: Promise-cache for CLI availability — prevents double spawn under concurrency */
const _cliCache = new Map<string, Promise<boolean>>();

async function isCLIAvailable(bin: string): Promise<boolean> {
  const cached = _cliCache.get(bin);
  if (cached !== undefined) {
    return cached;
  }
  // PERF-08: Store the Promise itself (not the resolved boolean) so concurrent
  // callers awaiting the same bin reuse the same in-flight Promise.
  const p = execCommand(bin, ["--version"], process.cwd())
    .then((result) => result.exitCode === 0)
    .catch(() => false);
  _cliCache.set(bin, p);
  return p;
}

// ---------------------------------------------------------------------------
// Tool: create_pull_request
// ---------------------------------------------------------------------------

export async function createPullRequest(
  args: CreatePRArgs,
  workspacePath: string,
): Promise<GitToolResult<PRUrl>> {
  if (!args.title || args.title.trim().length === 0) {
    return { success: false, error: "PR title cannot be empty" };
  }

  const base = args.base ?? "main";

  // Detect available CLI
  const ghAvailable = await isCLIAvailable("gh");
  if (ghAvailable) {
    const result = await execCommand(
      "gh",
      ["pr", "create", "--title", args.title, "--body", args.body, "--base", base],
      workspacePath,
    );

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || result.stdout.trim() || "gh pr create failed",
      };
    }

    const url = redactCredentials(result.stdout.trim());
    return { success: true, data: url };
  }

  const glabAvailable = await isCLIAvailable("glab");
  if (glabAvailable) {
    const result = await execCommand(
      "glab",
      ["mr", "create", "--title", args.title, "--description", args.body, "--target-branch", base],
      workspacePath,
    );

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || result.stdout.trim() || "glab mr create failed",
      };
    }

    const url = redactCredentials(result.stdout.trim());
    return { success: true, data: url };
  }

  return {
    success: false,
    error:
      "Neither 'gh' (GitHub CLI) nor 'glab' (GitLab CLI) is available. " +
      "Install gh from https://cli.github.com/ or glab from https://gitlab.com/gitlab-org/cli.",
  };
}

// ---------------------------------------------------------------------------
// Tool schema for LLM
// ---------------------------------------------------------------------------

export const PR_TOOL_SCHEMA = {
  name: "create_pull_request",
  description:
    "Create a pull request (GitHub) or merge request (GitLab) using the gh or glab CLI.",
  parameters: {
    type: "object" as const,
    properties: {
      title: {
        type: "string",
        description: "The PR/MR title (required).",
      },
      body: {
        type: "string",
        description: "The PR/MR description body.",
      },
      base: {
        type: "string",
        description: "The base branch to merge into (default: 'main').",
      },
    },
    required: ["title", "body"],
  },
} as const;
