/**
 * Tests for the unified execCommand utility (ARCH-02 + TS-04).
 *
 * Verifies ExecResult type and execCommand function extracted to
 * src/agents/git/exec.ts.
 */

import { describe, it, expect } from "bun:test";
import { execCommand, MAX_BUFFER_BYTES } from "../../../src/agents/git/exec.ts";

// ---------------------------------------------------------------------------
// MAX_BUFFER_BYTES constant
// ---------------------------------------------------------------------------

describe("MAX_BUFFER_BYTES", () => {
  it("is exported and equals 100_000", () => {
    expect(MAX_BUFFER_BYTES).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// execCommand — successful command
// ---------------------------------------------------------------------------

describe("execCommand — successful command", () => {
  it("returns exitCode 0 and stdout for a simple echo command", async () => {
    const result = await execCommand("node", ["-e", "process.stdout.write('hello')"], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toBe("");
  });

  it("captures stdout correctly", async () => {
    const result = await execCommand("node", ["-e", "console.log('test-output')"], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test-output");
  });
});

// ---------------------------------------------------------------------------
// execCommand — failing command
// ---------------------------------------------------------------------------

describe("execCommand — failing command", () => {
  it("returns non-zero exitCode when command fails", async () => {
    const result = await execCommand("node", ["-e", "process.exit(1)"], process.cwd());
    expect(result.exitCode).toBe(1);
  });

  it("captures stderr when command writes to stderr", async () => {
    const result = await execCommand(
      "node",
      ["-e", "process.stderr.write('error-output'); process.exit(1)"],
      process.cwd(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error-output");
  });

  it("returns exitCode 1 and stderr message when binary does not exist", async () => {
    const result = await execCommand("__nonexistent_binary__", [], process.cwd());
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// execCommand — buffer cap
// ---------------------------------------------------------------------------

describe("execCommand — buffer cap", () => {
  it("truncates stdout that exceeds MAX_BUFFER_BYTES and appends marker", async () => {
    // Generate output larger than MAX_BUFFER_BYTES (100KB) using a loop in node
    // We write 1KB chunks in a loop to avoid argument length limits
    const chunkSize = 1024;
    const chunks = Math.ceil((MAX_BUFFER_BYTES + 1000) / chunkSize);
    const script = `
      const chunk = Buffer.alloc(${chunkSize}, 'x');
      for (let i = 0; i < ${chunks}; i++) {
        process.stdout.write(chunk);
      }
    `;
    const result = await execCommand("node", ["-e", script], process.cwd());
    expect(result.exitCode).toBe(0);
    // stdout should be capped — the raw accumulated bytes are capped at MAX_BUFFER_BYTES
    expect(result.stdout).toContain("[...output truncated at");
  });
});
