/**
 * OS Agent tools: execute_command with risk assessment and timeout.
 *
 * Provides a single tool:
 * - execute_command: Run a shell command with safety checks
 *
 * Security features:
 * - Risk assessment before execution (see permissions.ts)
 * - Permission gate for sensitive/destructive commands
 * - CWD path traversal protection: cwd is validated against workspace root
 * - Timeout via setTimeout + proc.kill() (default 30s)
 * - stdout/stderr truncation at 10KB
 * - Sensitive data redaction before returning output
 *
 * Execution strategy:
 * - On Windows: spawn("cmd", ["/c", command], { shell: false }) — avoids
 *   shell injection while supporting CMD builtins (echo, dir, etc.)
 * - On Unix: spawn(bin, args, { shell: false }) — fully shell-free
 *
 * Known limitation: shell operators (|, >, &&, ||) are NOT supported on Unix
 * because shell:false is used. On Windows they work via cmd /c. This is an
 * intentional v1 security trade-off.
 */

import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { platform } from "node:os";
import { assessCommandRisk, COMMAND_CHAIN_RE } from "./permissions.ts";
import type { CommandRisk } from "./permissions.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OsToolResult {
  readonly content: string;
  readonly error?: string;
  readonly success: boolean;
  readonly permissionRequired?: {
    risk: CommandRisk;
    reason: string;
  };
}

export interface OsToolOptions {
  readonly dangerousAutoApprove?: boolean;
  readonly timeoutMs?: number;
}

export interface OsToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  readonly execute: (
    args: Record<string, unknown>,
    cwd: string,
    options?: OsToolOptions,
  ) => Promise<OsToolResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default command timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum output size in bytes before truncation. */
const MAX_OUTPUT_BYTES = 10_240; // 10KB

/**
 * Maximum buffer size to accumulate before discarding further output.
 * Set to 2× MAX_OUTPUT_BYTES to avoid unbounded memory growth.
 */
const MAX_BUFFER_BYTES = MAX_OUTPUT_BYTES * 2;

// ---------------------------------------------------------------------------
// Sensitive data redaction
// ---------------------------------------------------------------------------

/**
 * Patterns for common secret formats.
 * Applied to stdout/stderr before returning to the caller.
 *
 * @remarks Use only with .replace(), not .test() or .exec().
 * Regex with /g flag are stateful (they remember lastIndex), which causes
 * incorrect results when reused across multiple .test() or .exec() calls.
 * These patterns are safe here because they are only used with .replace().
 */
const SENSITIVE_DATA_PATTERNS: readonly RegExp[] = [
  /-----BEGIN\s.*PRIVATE KEY-----[\s\S]*?-----END\s.*PRIVATE KEY-----/,
  /sk-[a-zA-Z0-9]{20,}/,                          // OpenAI API keys
  /sk-ant-[a-zA-Z0-9\-]{20,}/,                    // Anthropic API keys (NEW-M2)
  /AKIA[0-9A-Z]{16}/,                              // AWS access keys
  /ghp_[a-zA-Z0-9]{36}/,                          // GitHub personal access tokens
  /xoxb-[a-zA-Z0-9-]+/,                           // Slack bot tokens
  /postgres:\/\/[^\s"']+/i,                        // PostgreSQL connection strings (NEW-M2)
  /mysql:\/\/[^\s"']+/i,                           // MySQL connection strings (NEW-M2)
];

/**
 * Redact known secret patterns from a string.
 * Replaces ALL matches with "[REDACTED]".
 */
export function redactSensitiveData(content: string): string {
  let result = content;
  for (const pattern of SENSITIVE_DATA_PATTERNS) {
    // Use replaceAll with a new RegExp with /g to replace all occurrences.
    // The stored patterns intentionally omit /g to avoid stateful lastIndex issues
    // when patterns are reused across .test()/.exec() calls.
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const globalPattern = new RegExp(pattern.source, flags);
    result = result.replace(globalPattern, "[REDACTED]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// CWD sanitization
// ---------------------------------------------------------------------------

/**
 * Validate and sanitize a requested working directory against the workspace.
 *
 * If the resolved path escapes the workspace, falls back to the workspace root
 * and logs a warning to stderr. This prevents path traversal via the cwd arg.
 *
 * @param requestedCwd - The cwd requested by the LLM (may be relative or absolute)
 * @param workspacePath - The workspace root (trusted, from ExtendedAgentContext).
 *   **MUST be an absolute path.** Passing a relative path produces undefined behaviour
 *   because `resolve(workspacePath, requestedCwd)` will resolve relative to the
 *   current working directory of the process, not the intended workspace root.
 * @returns A safe absolute path guaranteed to be within the workspace
 */
export function sanitizeCwd(requestedCwd: string, workspacePath: string): string {
  const workspaceResolved = resolve(workspacePath);
  const resolved = resolve(workspacePath, requestedCwd);

  if (
    resolved !== workspaceResolved &&
    !resolved.startsWith(workspaceResolved + sep)
  ) {
    console.error(
      `[os-agent] CWD "${requestedCwd}" resolves outside workspace ("${resolved}"), using workspace root`,
    );
    return workspaceResolved;
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Command string parser
// ---------------------------------------------------------------------------

/**
 * Parse a command string into an array of arguments.
 *
 * Handles:
 * - Simple space-separated tokens
 * - Double-quoted strings: "hello world" → one token
 * - Single-quoted strings: 'hello world' → one token
 * - Backslash escapes: `\"`, `\'`, `\\` → literal character (SEC-15)
 *
 * Note: Shell operators (|, >, &&, ||) are treated as literal tokens.
 * They will NOT be interpreted when shell:false is used.
 *
 * @param command - The command string to parse
 * @returns Array of string tokens
 */
export function parseCommandString(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    // Handle backslash escapes (SEC-15)
    if (ch === "\\" && i + 1 < command.length) {
      const next = command[i + 1]!;
      if (next === '"' || next === "'" || next === "\\") {
        current += next;
        i++; // skip the escaped character
        continue;
      }
      // Non-escape backslash: treat as literal (pass through)
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === " " && !inDouble && !inSingle) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output;
  return (
    output.slice(0, MAX_OUTPUT_BYTES) +
    `\n... [truncated, ${output.length} total bytes]`
  );
}

// ---------------------------------------------------------------------------
// Process execution helper
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const IS_WINDOWS = platform() === "win32";

/**
 * Execute a command with timeout support.
 *
 * On Windows: uses `cmd /c <command>` with shell:false to support CMD builtins
 * while avoiding shell injection via metacharacter expansion in the argv array.
 *
 * On Unix: parses the command string into argv and uses shell:false.
 * Shell operators (|, >, &&) are NOT supported on Unix.
 *
 * Buffers are accumulated as Buffer chunks (O(n) instead of O(n²) string concat).
 * Buffering stops at MAX_BUFFER_BYTES to prevent memory exhaustion.
 */
function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;

    // Build argv: Windows uses cmd /c, Unix parses the command string
    let proc: ReturnType<typeof spawn>;
    if (IS_WINDOWS) {
      proc = spawn("cmd", ["/c", command], {
        shell: false,
        cwd,
        windowsHide: true,
      });
    } else {
      const tokens = parseCommandString(command);
      if (tokens.length === 0) {
        reject(new Error("Empty command after parsing"));
        return;
      }
      const [bin, ...args] = tokens;
      proc = spawn(bin!, args, {
        shell: false,
        cwd,
      });
    }

    // Accumulate output as Buffer chunks (O(n) memory)
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen < MAX_BUFFER_BYTES) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen < MAX_BUFFER_BYTES) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      reject(err);
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code ?? 1,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tool: execute_command
// ---------------------------------------------------------------------------

export const EXECUTE_COMMAND_TOOL: OsToolDefinition = {
  name: "execute_command",
  description:
    "Execute a shell command and return its stdout, stderr, and exit code. " +
    "Commands classified as sensitive or destructive require explicit permission. " +
    "Note: on Unix, shell operators (|, >, &&) are not supported (shell:false). " +
    "On Windows, CMD builtins and operators work via cmd /c.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the command, relative to workspace root. " +
          "Paths outside the workspace are silently clamped to workspace root.",
      },
    },
    required: ["command"],
  },

  async execute(
    args: Record<string, unknown>,
    cwd: string,
    options?: OsToolOptions,
  ): Promise<OsToolResult> {
    const command = args["command"];
    if (typeof command !== "string" || command.trim().length === 0) {
      return {
        content: JSON.stringify({ error: "command is required" }),
        error: "Argument 'command' is required and must be a non-empty string.",
        success: false,
      };
    }

    // ── CWD sanitization (C1: path traversal protection) ────────────────
    const rawCwd = typeof args["cwd"] === "string" ? args["cwd"] : cwd;
    const workingDir = sanitizeCwd(rawCwd, cwd);

    const dangerousAutoApprove = options?.dangerousAutoApprove ?? false;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // ── Metachar check (NEW-A1) ──────────────────────────────────────────
    // On Windows, cmd /c interprets shell metacharacters (;, |, &, etc.).
    // Block commands containing them unless dangerousAutoApprove is set.
    if (!dangerousAutoApprove && COMMAND_CHAIN_RE.test(command)) {
      return {
        content: JSON.stringify({
          permission_required: true,
          risk: "sensitive",
          reason:
            "Command contains shell metacharacters (;, |, &, etc.) that may chain or redirect execution",
        }),
        success: false,
        permissionRequired: {
          risk: "sensitive" as CommandRisk,
          reason:
            "Command contains shell metacharacters (;, |, &, etc.) that may chain or redirect execution",
        },
      };
    }

    // ── Risk assessment ──────────────────────────────────────────────────
    const assessment = assessCommandRisk(command);

    if (
      (assessment.risk === "sensitive" || assessment.risk === "destructive") &&
      !dangerousAutoApprove
    ) {
      return {
        content: JSON.stringify({
          permission_required: true,
          risk: assessment.risk,
          reason: assessment.reason,
        }),
        success: false,
        permissionRequired: {
          risk: assessment.risk,
          reason: assessment.reason,
        },
      };
    }

    // ── Execute with timeout ─────────────────────────────────────────────
    try {
      const result = await execCommand(command.trim(), workingDir, timeoutMs);

      // Redact sensitive data before returning (A3)
      const redactedStdout = redactSensitiveData(result.stdout);
      const redactedStderr = redactSensitiveData(result.stderr);

      const truncatedStdout = truncateOutput(redactedStdout);
      const truncatedStderr = truncateOutput(redactedStderr);
      const success = result.exitCode === 0;

      return {
        content: JSON.stringify({
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          exit_code: result.exitCode,
        }),
        error: success
          ? undefined
          : truncatedStderr || `Exit code: ${result.exitCode}`,
        success,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        errorMsg.toLowerCase().includes("timed out") ||
        errorMsg.toLowerCase().includes("timeout");

      return {
        content: JSON.stringify({ error: errorMsg }),
        error: isTimeout ? `Command timed out after ${timeoutMs}ms` : errorMsg,
        success: false,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Aggregated exports
// ---------------------------------------------------------------------------

export const OS_AGENT_TOOLS: readonly OsToolDefinition[] = [
  EXECUTE_COMMAND_TOOL,
];

const TOOL_MAP = new Map(OS_AGENT_TOOLS.map((t) => [t.name, t]));

/** Pre-computed tool schemas (P2: memoized as module constant). */
const TOOL_SCHEMAS = OS_AGENT_TOOLS.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

export function getOsToolSchemas(): ReadonlyArray<{
  name: string;
  description: string;
  parameters: OsToolDefinition["parameters"];
}> {
  return TOOL_SCHEMAS;
}

export async function executeOsTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  options?: OsToolOptions,
): Promise<OsToolResult> {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    return {
      content: "",
      error: `Unknown tool: "${toolName}"`,
      success: false,
    };
  }
  return tool.execute(args, cwd, options);
}
