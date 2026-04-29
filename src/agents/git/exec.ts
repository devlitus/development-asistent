/**
 * Unified execCommand utility for git agent tools (ARCH-02 + TS-04).
 *
 * Extracted from tools.ts (execGitCommand) and pr-tools.ts (execCommand)
 * to eliminate duplication. This version is generic (accepts any binary)
 * and includes the buffer cap + truncation marker from tools.ts.
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum buffer size during accumulation — PERF-C1 */
const MAX_DIFF_BYTES = 50_000; // 50KB

/**
 * PERF-09: Exported for tests — buffer cap for execCommand stdout/stderr.
 * Re-exported from this module so tools.ts can import it from here.
 */
export const MAX_BUFFER_BYTES = MAX_DIFF_BYTES * 2; // 100KB buffer cap

// ---------------------------------------------------------------------------
// execCommand
// ---------------------------------------------------------------------------

/**
 * Execute an arbitrary command with shell:false.
 *
 * Features:
 * - Buffer cap during accumulation to prevent OOM (PERF-C1)
 * - Truncation marker appended to stdout when cap is hit (PERF-09)
 * - Error event handled gracefully (binary not found, etc.)
 *
 * @param bin  - The binary to execute (e.g. "git", "gh", "glab")
 * @param args - Arguments to pass to the binary
 * @param cwd  - Working directory for the process
 */
export function execCommand(bin: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { shell: false, cwd });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;

    proc.stdout?.on("data", (chunk: Buffer | Uint8Array) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutLen < MAX_BUFFER_BYTES) {
        stdoutChunks.push(buf);
        stdoutLen += buf.length;
      }
      // If limit exceeded, discard further output (process continues)
    });

    proc.stderr?.on("data", (chunk: Buffer | Uint8Array) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrLen < MAX_BUFFER_BYTES) {
        stderrChunks.push(buf);
        stderrLen += buf.length;
      }
    });

    proc.on("error", (err: Error) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });

    proc.on("close", (code: number | null) => {
      let stdout = Buffer.concat(stdoutChunks).toString();
      // PERF-09: Append truncation marker when output was silently capped
      if (stdoutLen >= MAX_BUFFER_BYTES) {
        stdout += `\n[...output truncated at ${MAX_BUFFER_BYTES} bytes. Use more specific commands to get less output.]`;
      }
      resolve({
        stdout,
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code ?? 1,
      });
    });
  });
}
