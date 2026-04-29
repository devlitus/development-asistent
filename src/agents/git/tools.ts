/**
 * Git Agent tools: git_status, git_diff, git_log, git_commit, git_branch, git_push.
 *
 * All operations use spawn with shell:false for security.
 * All operations validate that the working directory is a git repo first.
 *
 * Security fixes (R1):
 * - SEC-A1: remote name validation in git_push
 * - SEC-A2: branch name validation in git_push
 * - SEC-A3: file path validation in git_diff and git_commit
 * - SEC-M2: no silent escalation from git branch -d to -D
 * - SEC-M3: credential redaction in git_push output
 *
 * Bug fixes (R1):
 * - BUG-C1: use \x1f separator in git_log to avoid | in commit messages
 * - BUG-M1: clamp negative limit in git_log
 * - BUG-M2: unquote git paths with spaces in git_status
 * - BUG-M3: stricter branch name validation
 *
 * Performance fixes (R1):
 * - PERF-C1: buffer limit during accumulation in execGitCommand
 * - PERF-C2: parallelize git status + rev-list
 * - PERF-M2: cache isGitRepo results per workspacePath
 */

import { execCommand, MAX_BUFFER_BYTES } from "./exec.ts";
export { MAX_BUFFER_BYTES } from "./exec.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitStatus {
  modified: string[];
  staged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  branch: string;
  detached: boolean;
}

export interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
  refs: string;
}

export interface LogOptions {
  limit?: number;
  since?: string;
  author?: string;
  path?: string;
}

export interface GitToolResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  confirmationRequired?: {
    reason: string;
    risk: "sensitive" | "destructive";
  };
}

export interface GitBranchArgs {
  action: "create" | "switch" | "list" | "delete";
  name?: string;
}

export interface GitPushArgs {
  force?: boolean;
  remote?: string;
  branch?: string;
}

export interface GitCommitArgs {
  message: string;
  files?: string[];
}

export interface GitDiffArgs {
  files?: string[];
  staged?: boolean;
}

export interface GitToolOptions {
  dangerousAutoApprove?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum diff output size before truncation */
const MAX_DIFF_BYTES = 50_000; // 50KB

/**
 * PERF-10: TTL in milliseconds for the isGitRepo cache.
 * Each cached entry expires after this duration to avoid stale results
 * when the user changes directories or initializes a new git repo.
 */
export const ISGITREPO_CACHE_TTL_MS = 30_000; // 30 seconds

/** PERF-10: Cache for isGitRepo results with TTL — PERF-M2 + PERF-10 */
const _gitRepoCache = new Map<string, { result: boolean; ts: number }>();

/**
 * Verify that the given directory is a git repository.
 * Results are cached per workspacePath with a TTL of ISGITREPO_CACHE_TTL_MS
 * to avoid stale results when the user changes directories (PERF-10).
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  const cached = _gitRepoCache.get(cwd);
  if (cached !== undefined) {
    if (Date.now() - cached.ts < ISGITREPO_CACHE_TTL_MS) {
      return cached.result;
    }
    // TTL expired — remove stale entry and re-check
    _gitRepoCache.delete(cwd);
  }
  const result = await execCommand("git", ["rev-parse", "--git-dir"], cwd);
  const isRepo = result.exitCode === 0;
  _gitRepoCache.set(cwd, { result: isRepo, ts: Date.now() });
  return isRepo;
}

/**
 * Validate a branch name — BUG-M3: stricter rules.
 * Rejects: starts with '-', starts with '.', ends with '.lock',
 * starts/ends with '/', contains '..', contains '//', invalid chars.
 */
function validateBranchName(name: string): string | null {
  if (!name || name.trim().length === 0) return "Branch name cannot be empty";
  if (name.length > 255) return "Branch name too long (max 255 chars)";
  if (name.startsWith("-")) return "Branch name cannot start with '-'";
  if (name.startsWith(".")) return "Branch name cannot start with '.'";
  if (name.endsWith(".lock")) return "Branch name cannot end with '.lock'";
  if (name.startsWith("/") || name.endsWith("/")) return "Branch name cannot start or end with '/'";
  if (name.includes("..")) return "Branch name cannot contain '..'";
  if (name.includes("//")) return "Branch name cannot contain '//'";
  if (!/^[a-zA-Z0-9._\-/]+$/.test(name)) return "Branch name contains invalid characters (only a-zA-Z0-9._-/ allowed)";
  return null;
}

/**
 * Validate a remote name — SEC-A1.
 * Allows simple names [a-zA-Z0-9._-] or https:// or git@ URLs.
 * Rejects names starting with '-'.
 */
function validateRemoteName(remote: string): string | null {
  if (!remote || remote.trim().length === 0) return "Remote name cannot be empty";
  if (remote.startsWith("-")) return "Remote name cannot start with '-'";
  const isSimpleName = /^[a-zA-Z0-9._\-]+$/.test(remote);
  const isHttpsUrl = remote.startsWith("https://");
  const isGitSsh = remote.startsWith("git@");
  if (!isSimpleName && !isHttpsUrl && !isGitSsh) {
    return `Invalid remote name: "${remote}". Use a simple name (e.g. 'origin') or a URL (https:// or git@).`;
  }
  return null;
}

/**
 * Validate a file path for use in git commands — SEC-A3.
 * Rejects path traversal, absolute paths, and paths starting with '-'.
 */
function validateFilePath(p: string): string | null {
  if (typeof p !== "string" || p.trim().length === 0) return "Path must be a non-empty string";
  if (p.includes("..")) return `Path traversal detected: "${p}"`;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return `Absolute paths not allowed: "${p}"`;
  if (p.startsWith("-")) return `Path cannot start with '-': "${p}"`;
  return null;
}

/**
 * Unquote a git path — BUG-M2.
 * Git porcelain v1 quotes filenames with spaces: `?? "file with spaces.txt"`.
 */
function unquoteGitPath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1);
  }
  return p;
}

/**
 * Redact credentials embedded in URLs — SEC-M3.
 * Replaces https://user:token@host with https://[REDACTED]@host.
 */
export function redactCredentials(output: string): string {
  return output.replace(/https?:\/\/[^:@\s]+:[^@\s]+@/g, "https://[REDACTED]@");
}

/**
 * Sanitize a git option value against a whitelist pattern — SEC-12.
 * Throws a descriptive error if the value contains disallowed characters.
 *
 * @param value - The option value to validate
 * @param allowedChars - Regex that the entire value must match
 * @param optionName - Name of the option (for error messages)
 */
export function sanitizeGitOption(value: string, allowedChars: RegExp, optionName: string): string {
  if (!allowedChars.test(value)) {
    throw new Error(
      `Invalid characters in git option "${optionName}": "${value}". ` +
      `Only characters matching ${allowedChars} are allowed.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tool: git_status
// ---------------------------------------------------------------------------

export async function gitStatus(workspacePath: string): Promise<GitToolResult<GitStatus>> {
  if (!(await isGitRepo(workspacePath))) {
    return {
      success: false,
      error: `Not a git repository: ${workspacePath}`,
    };
  }

  // PERF-C2: Parallelize status + rev-list (they are independent after repo check)
  const [statusResult, revListResult] = await Promise.all([
    execCommand("git", ["status", "--porcelain=v1", "-b"], workspacePath),
    execCommand("git", 
      ["rev-list", "--count", "--left-right", "HEAD...@{u}"],
      workspacePath,
    ).catch(() => null),
  ]);

  if (statusResult.exitCode !== 0) {
    return {
      success: false,
      error: statusResult.stderr.trim() || "git status failed",
    };
  }

  const lines = statusResult.stdout.split("\n").filter((l) => l.length > 0);

  const modified: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  let branch = "";
  let detached = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Branch info line
      const branchInfo = line.slice(3);
      if (branchInfo.startsWith("HEAD (no branch)") || branchInfo.startsWith("No commits yet")) {
        detached = branchInfo.startsWith("HEAD (no branch)");
        branch = detached ? "HEAD" : branchInfo.replace("No commits yet on ", "").trim();
      } else {
        // Format: "main...origin/main [ahead N, behind M]" or just "main"
        const branchPart = branchInfo.split("...")[0]!;
        branch = branchPart.trim();
      }
      continue;
    }

    if (line.length < 2) continue;

    const xy = line.slice(0, 2);
    // BUG-M2: unquote filenames with spaces
    const file = unquoteGitPath(line.slice(3).trim());

    const x = xy[0]!; // index (staged)
    const y = xy[1]!; // working tree (unstaged)

    if (xy === "??") {
      untracked.push(file);
    } else {
      // Staged changes (index modified)
      if (x !== " " && x !== "?") {
        staged.push(file);
      }
      // Working tree changes (unstaged)
      if (y !== " " && y !== "?") {
        modified.push(file);
      }
    }
  }

  // Parse ahead/behind from rev-list result
  let ahead = 0;
  let behind = 0;
  if (revListResult && revListResult.exitCode === 0) {
    const parts = revListResult.stdout.trim().split(/\s+/);
    ahead = parseInt(parts[0] ?? "0", 10) || 0;
    behind = parseInt(parts[1] ?? "0", 10) || 0;
  }

  return {
    success: true,
    data: {
      modified,
      staged,
      untracked,
      ahead,
      behind,
      branch,
      detached,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: git_diff
// ---------------------------------------------------------------------------

export async function gitDiff(
  args: GitDiffArgs,
  workspacePath: string,
): Promise<GitToolResult<string>> {
  if (!(await isGitRepo(workspacePath))) {
    return {
      success: false,
      error: `Not a git repository: ${workspacePath}`,
    };
  }

  // SEC-A3: Validate file paths
  if (args.files && args.files.length > 0) {
    for (const p of args.files) {
      const err = validateFilePath(p);
      if (err) {
        return { success: false, error: `Invalid file path: ${err}` };
      }
    }
  }

  const gitArgs = ["diff"];
  if (args.staged) {
    gitArgs.push("--cached");
  }
  if (args.files && args.files.length > 0) {
    gitArgs.push("--", ...args.files);
  }

  const result = await execCommand("git", gitArgs, workspacePath);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: result.stderr.trim() || "git diff failed",
    };
  }

  let output = result.stdout;
  if (output.length > MAX_DIFF_BYTES) {
    output = output.slice(0, MAX_DIFF_BYTES) + `\n... [truncated, ${output.length} total bytes]`;
  }

  return {
    success: true,
    data: output,
  };
}

// ---------------------------------------------------------------------------
// Tool: git_log
// ---------------------------------------------------------------------------

const MAX_LOG_LIMIT = 100;

/** ASCII Unit Separator — safe delimiter for git log format (BUG-C1) */
const LOG_SEP = "\x1f";

/** Allowed characters for git log --author option — SEC-12 */
const AUTHOR_ALLOWED = /^[\w\s@.\-]+$/;

/** Allowed characters for git log --since/--until options — SEC-12 */
const DATE_REF_ALLOWED = /^[\w\-:.@~^{}\/]+$/;

export async function gitLog(
  options: LogOptions,
  workspacePath: string,
): Promise<GitToolResult<Commit[]>> {
  if (!(await isGitRepo(workspacePath))) {
    return {
      success: false,
      error: `Not a git repository: ${workspacePath}`,
    };
  }

  // BUG-M1: clamp negative or zero limit to 1
  const limit = Math.max(1, Math.min(options.limit ?? 10, MAX_LOG_LIMIT));

  // BUG-C1: use \x1f as separator to avoid collision with | in commit messages
  const gitArgs = [
    "log",
    `--format=%H${LOG_SEP}%s${LOG_SEP}%an${LOG_SEP}%ai${LOG_SEP}%D`,
    `-${limit}`,
  ];

  if (options.since) {
    try {
      sanitizeGitOption(options.since, DATE_REF_ALLOWED, "since");
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
    gitArgs.push(`--since=${options.since}`);
  }
  if (options.author) {
    try {
      sanitizeGitOption(options.author, AUTHOR_ALLOWED, "author");
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
    gitArgs.push(`--author=${options.author}`);
  }
  if (options.path !== undefined) {
    // FIX-3: Validate path against traversal before passing to git
    const pathError = validateFilePath(options.path);
    if (pathError) {
      return { success: false, error: `Invalid path: ${pathError}` };
    }
    gitArgs.push("--", options.path);
  }

  const result = await execCommand("git", gitArgs, workspacePath);

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: result.stderr.trim() || "git log failed",
    };
  }

  const commits: Commit[] = [];
  const lines = result.stdout.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    // BUG-C1: split on \x1f, not |
    const parts = line.split(LOG_SEP);
    if (parts.length < 5) continue;
    const [fullHash, message, author, date, ...refParts] = parts;
    commits.push({
      hash: (fullHash ?? "").slice(0, 7),
      message: message ?? "",
      author: author ?? "",
      date: date ?? "",
      refs: refParts.join(LOG_SEP),
    });
  }

  return {
    success: true,
    data: commits,
  };
}

// ---------------------------------------------------------------------------
// Tool: git_commit
// ---------------------------------------------------------------------------

export async function gitCommit(
  args: GitCommitArgs,
  workspacePath: string,
): Promise<GitToolResult<string>> {
  if (!args.message || args.message.trim().length === 0) {
    return {
      success: false,
      error: "Commit message cannot be empty",
    };
  }

  if (!(await isGitRepo(workspacePath))) {
    return {
      success: false,
      error: `Not a git repository: ${workspacePath}`,
    };
  }

  // SEC-A3: Validate file paths before staging
  if (args.files && args.files.length > 0) {
    for (const p of args.files) {
      const err = validateFilePath(p);
      if (err) {
        return { success: false, error: `Invalid file path: ${err}` };
      }
    }

    const addResult = await execCommand("git", 
      ["add", "--", ...args.files],
      workspacePath,
    );
    if (addResult.exitCode !== 0) {
      return {
        success: false,
        error: addResult.stderr.trim() || "git add failed",
      };
    }
  }

  // Commit
  const commitResult = await execCommand("git", 
    ["commit", "-m", args.message.trim()],
    workspacePath,
  );

  if (commitResult.exitCode !== 0) {
    return {
      success: false,
      error: commitResult.stderr.trim() || commitResult.stdout.trim() || "git commit failed",
    };
  }

  // Get the short hash of the new commit
  const hashResult = await execCommand("git", 
    ["rev-parse", "--short", "HEAD"],
    workspacePath,
  );

  const hash = hashResult.stdout.trim();
  return {
    success: true,
    data: hash,
  };
}

// ---------------------------------------------------------------------------
// Tool: git_branch
// ---------------------------------------------------------------------------

export async function gitBranch(
  args: GitBranchArgs,
  workspacePath: string,
  options?: GitToolOptions,
): Promise<GitToolResult<string>> {
  if (!(await isGitRepo(workspacePath))) {
    return {
      success: false,
      error: `Not a git repository: ${workspacePath}`,
    };
  }

  const dangerousAutoApprove = options?.dangerousAutoApprove ?? false;

  switch (args.action) {
    case "list": {
      const result = await execCommand("git", ["branch", "-a"], workspacePath);
      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr.trim() || "git branch -a failed" };
      }
      return { success: true, data: result.stdout };
    }

    case "create": {
      if (!args.name) {
        return { success: false, error: "Branch name is required for 'create' action" };
      }
      const validationError = validateBranchName(args.name);
      if (validationError) {
        return { success: false, error: validationError };
      }
      const result = await execCommand("git", ["branch", args.name], workspacePath);
      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr.trim() || "git branch failed" };
      }
      return { success: true, data: `Branch '${args.name}' created` };
    }

    case "switch": {
      if (!args.name) {
        return { success: false, error: "Branch name is required for 'switch' action" };
      }
      const validationError = validateBranchName(args.name);
      if (validationError) {
        return { success: false, error: validationError };
      }
      const result = await execCommand("git", ["checkout", args.name], workspacePath);
      if (result.exitCode !== 0) {
        return { success: false, error: result.stderr.trim() || "git checkout failed" };
      }
      return { success: true, data: `Switched to branch '${args.name}'` };
    }

    case "delete": {
      if (!args.name) {
        return { success: false, error: "Branch name is required for 'delete' action" };
      }
      const validationError = validateBranchName(args.name);
      if (validationError) {
        return { success: false, error: validationError };
      }

      if (!dangerousAutoApprove) {
        return {
          success: false,
          confirmationRequired: {
            reason: `Deleting branch '${args.name}' is a destructive operation. Confirm to proceed.`,
            risk: "destructive",
          },
        };
      }

      const result = await execCommand("git", ["branch", "-d", args.name], workspacePath);
      if (result.exitCode !== 0) {
        // SEC-M2: Do NOT silently escalate to -D. Return descriptive error.
        return {
          success: false,
          error:
            `Branch '${args.name}' has unmerged changes or could not be deleted. ` +
            "Use force delete explicitly by requesting a separate operation.",
        };
      }
      return { success: true, data: `Branch '${args.name}' deleted` };
    }

    default:
      return { success: false, error: `Unknown action: ${(args as GitBranchArgs).action}` };
  }
}

// ---------------------------------------------------------------------------
// Tool: git_push
// ---------------------------------------------------------------------------

export async function gitPush(
  args: GitPushArgs,
  workspacePath: string,
  options?: GitToolOptions,
): Promise<GitToolResult<string>> {
  if (!(await isGitRepo(workspacePath))) {
    return {
      success: false,
      error: `Not a git repository: ${workspacePath}`,
    };
  }

  const dangerousAutoApprove = options?.dangerousAutoApprove ?? false;

  if (args.force && !dangerousAutoApprove) {
    return {
      success: false,
      confirmationRequired: {
        reason: "Force push is a destructive operation that can overwrite remote history. Confirm to proceed.",
        risk: "destructive",
      },
    };
  }

  // SEC-A1: Validate remote name
  const remote = args.remote ?? "origin";
  const remoteError = validateRemoteName(remote);
  if (remoteError) {
    return { success: false, error: remoteError };
  }

  // SEC-A2: Validate branch name if provided
  if (args.branch) {
    const branchError = validateBranchName(args.branch);
    if (branchError) {
      return { success: false, error: `Invalid branch: ${branchError}` };
    }
  }

  const gitArgs = ["push"];
  if (args.force) {
    gitArgs.push("--force");
  }
  gitArgs.push(remote);

  if (args.branch) {
    gitArgs.push(args.branch);
  }

  const result = await execCommand("git", gitArgs, workspacePath);

  // SEC-M3: Redact credentials from output before returning
  const stdout = redactCredentials(result.stdout.trim());
  const stderr = redactCredentials(result.stderr.trim());

  if (result.exitCode !== 0) {
    return {
      success: false,
      error: stderr || stdout || "git push failed",
    };
  }

  return {
    success: true,
    data: stdout || stderr || "Push successful",
  };
}

// ---------------------------------------------------------------------------
// Tool schemas for LLM
// ---------------------------------------------------------------------------

export const GIT_TOOL_SCHEMAS = [
  {
    name: "git_status",
    description:
      "Get the current git status of the repository. Returns modified, staged, and untracked files, plus branch info.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "git_diff",
    description:
      "Get the diff of the working tree or staged changes.",
    parameters: {
      type: "object" as const,
      properties: {
        staged: {
          type: "boolean",
          description: "If true, show staged diff (--cached). Default: false (working tree diff).",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of file paths to diff.",
        },
      },
      required: [],
    },
  },
  {
    name: "git_log",
    description: "Get the commit history of the repository.",
    parameters: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of commits to return (default: 10, max: 100).",
        },
        since: {
          type: "string",
          description: "Show commits since this date (git format: '2024-01-01').",
        },
        author: {
          type: "string",
          description: "Filter commits by author name.",
        },
        path: {
          type: "string",
          description: "Filter commits that touch this path.",
        },
      },
      required: [],
    },
  },
  {
    name: "git_commit",
    description: "Create a git commit with the given message.",
    parameters: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The commit message (required). Use Conventional Commits format.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of files to stage before committing. If omitted, commits what is already staged.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "git_branch",
    description: "Manage git branches: list, create, switch, or delete.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "switch", "delete"],
          description: "The branch action to perform.",
        },
        name: {
          type: "string",
          description: "Branch name (required for create, switch, delete).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "git_push",
    description: "Push commits to a remote repository.",
    parameters: {
      type: "object" as const,
      properties: {
        force: {
          type: "boolean",
          description: "If true, force push (DESTRUCTIVE — requires confirmation).",
        },
        remote: {
          type: "string",
          description: "Remote name (default: 'origin').",
        },
        branch: {
          type: "string",
          description: "Branch to push (default: current branch).",
        },
      },
      required: [],
    },
  },
] as const;
