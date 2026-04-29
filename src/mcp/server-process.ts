/**
 * MCPServerProcess — manages a single MCP server subprocess.
 *
 * Spawns the MCP server as a child process with stdio pipes,
 * handles NDJSON framing over stdin/stdout, and manages pending
 * JSON-RPC requests with timeout support.
 *
 * SECURITY NOTE: MCP servers run with the same privileges as this process.
 * Only configure servers from trusted sources. The subprocess receives a
 * minimal environment (PATH, HOME, TMPDIR, TEMP, TMP) — NOT the full
 * parent environment — to avoid leaking API keys and secrets.
 *
 * IMPORTANT: The child process stdout is piped (not inherited) to prevent
 * contamination of the parent process stdout, which is reserved for ACP
 * JSON-RPC communication with the editor.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { redactSensitiveData } from "../agents/os/tools.ts";

// ─── Security constants ───────────────────────────────────────────

/**
 * SEC-07: Maximum size in bytes for a single NDJSON line from an MCP server.
 * Lines exceeding this limit are discarded gracefully (non-fatal).
 * Default: 1 MB.
 */
export const MAX_LINE_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * SEC-09: Maximum bytes to retain from a child process stderr stream.
 * Excess bytes are truncated and a marker is appended.
 * Default: 4 KB.
 */
export const MAX_STDERR_BYTES = 4096; // 4 KB

/**
 * PERF-07: Maximum number of concurrent pending JSON-RPC requests.
 * When this limit is reached, new requests are rejected immediately with
 * a MAX_REQUESTS_EXCEEDED error to prevent unbounded Map growth under load.
 */
export const MAX_PENDING_REQUESTS = 100;

// ─── Types ────────────────────────────────────────────────────────

/**
 * Configuration for a single MCP server.
 * Exported here so consumers can import from server-process or client.
 */
export interface MCPServerConfig {
  /** Unique identifier for this server. */
  readonly name: string;
  /** Executable to run (e.g. "node", "bun", "npx"). */
  readonly command: string;
  /** Arguments to pass to the executable. */
  readonly args: readonly string[];
  /**
   * Additional environment variables for the subprocess.
   * These are merged into the minimal safe environment.
   * Do NOT pass API keys here unless the MCP server explicitly needs them.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Request timeout in milliseconds. Default: 5000. */
  readonly timeout?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── MCPServerProcess ─────────────────────────────────────────────

/**
 * Manages the lifecycle of a single MCP server subprocess.
 *
 * Handles:
 * - Spawning the process with piped stdio
 * - NDJSON framing (one JSON object per line)
 * - Correlating JSON-RPC responses to pending requests
 * - Timeout handling per request
 * - Clean shutdown
 */
export class MCPServerProcess {
  private process: ChildProcess | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private running = false;
  /** SEC-07: Buffer for accumulating the current NDJSON line from stdout. */
  private lineBuffer = "";
  /** SEC-07: Accumulated byte length of lineBuffer (O(1) incremental counter). */
  private lineBufferByteLen = 0;
  /** SEC-07: Flag set when lineBuffer was discarded mid-line due to exceeding MAX_LINE_BYTES. */
  private lineBufferOversized = false;
  /** SEC-09: Accumulated stderr bytes (capped at MAX_STDERR_BYTES). */
  private stderrBuffer = "";

  constructor(private readonly config: MCPServerConfig) {}

  /** Returns true if the subprocess is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * PERF-07: Returns the number of currently pending JSON-RPC requests.
   * Useful for monitoring and tests.
   */
  pendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Starts the MCP server subprocess and sets up stdio piping.
   *
   * Waits for the "spawn" event before resolving, so callers can be
   * confident the process is actually running when this resolves.
   *
   * @throws {Error} if the process fails to start (e.g. executable not found)
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error(`MCPServerProcess(${this.config.name}): already running`);
    }

    // S1 FIX: Use a minimal safe environment instead of inheriting all of
    // process.env. This prevents leaking API keys (ANTHROPIC_API_KEY,
    // OPENAI_API_KEY, etc.) to untrusted MCP server subprocesses.
    const safeEnv: Record<string, string> = {
      ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.TEMP !== undefined ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP !== undefined ? { TMP: process.env.TMP } : {}),
      ...(process.env.USERPROFILE !== undefined ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}),
      // Only add vars explicitly configured by the user
      ...(this.config.env ?? {}),
    };

    this.process = spawn(this.config.command, [...this.config.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: safeEnv,
    });

    // TS4 FIX: Wait for the "spawn" event before marking as running.
    // If the executable doesn't exist, the "error" event fires before "spawn"
    // and we reject here instead of resolving with running = true.
    //
    // TS-NEW-1 FIX: Capture local reference before the Promise to avoid
    // non-null assertions inside the closure (same pattern as stop()).
    const spawnProc = this.process;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.process = null;
        reject(err);
      };
      const onSpawn = () => {
        spawnProc.removeListener("error", onError);
        resolve();
      };
      spawnProc.once("error", onError);
      spawnProc.once("spawn", onSpawn);
    });

    // SEC-09: Pipe child stderr to parent stderr with truncation and redaction.
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();

      // Determine what portion of this chunk to log (respecting the cap)
      let toLog: string;
      if (this.stderrBuffer.length >= MAX_STDERR_BYTES) {
        // Already truncated — don't log any more raw content
        return;
      }

      const remaining = MAX_STDERR_BYTES - this.stderrBuffer.length;
      if (text.length <= remaining) {
        // Fits entirely within the cap
        this.stderrBuffer += text;
        toLog = text;
      } else {
        // Exceeds cap — truncate and append marker
        const truncated = text.slice(0, remaining);
        this.stderrBuffer += truncated + "[...stderr truncated at 4096 bytes]";
        toLog = truncated + "[...stderr truncated at 4096 bytes]";
      }

      // Redact sensitive data before writing to parent stderr
      process.stderr.write(
        `[mcp:${this.config.name}] ${redactSensitiveData(toLog)}`,
      );
    });

    // SEC-07: Manual NDJSON line buffering with MAX_LINE_BYTES enforcement.
    // We read raw data chunks instead of using readline so we can measure
    // byte size before processing each line.
    //
    // SECURITY FIX (early-discard): When the buffer exceeds MAX_LINE_BYTES
    // mid-line, we immediately discard it and set lineBufferOversized=true.
    // Subsequent chars are ignored (not accumulated) until the next '\n',
    // preventing unbounded memory growth from a malicious server that never
    // sends a newline.
    this.process.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\n") {
          if (this.lineBufferOversized) {
            // Oversized line ended — emit warning, reset flag, skip handleLine
            process.stderr.write(
              `[mcp:${this.config.name}] OVERSIZED_MESSAGE: line discarded (exceeded ${MAX_LINE_BYTES} bytes limit)\n`,
            );
            this.lineBufferOversized = false;
          } else {
            // Normal line — process it
            const line = this.lineBuffer;
            this.lineBuffer = "";
            this.lineBufferByteLen = 0;
            this.handleLine(line);
          }
          this.lineBuffer = "";
          this.lineBufferByteLen = 0;
        } else {
          if (this.lineBufferOversized) {
            // Already oversized — ignore chars until next '\n'
          } else {
            // O(1): measure only this single char, not the whole buffer
            const charByteLen = Buffer.byteLength(char, "utf8");
            if (this.lineBufferByteLen + charByteLen > MAX_LINE_BYTES) {
              // Early-discard: liberar memoria ahora, marcar como oversized
              process.stderr.write(
                `[mcp:${this.config.name}] OVERSIZED_MESSAGE: line buffer exceeded ${MAX_LINE_BYTES} bytes, discarding\n`,
              );
              this.lineBuffer = "";
              this.lineBufferByteLen = 0;
              this.lineBufferOversized = true;
            } else {
              this.lineBuffer += char;
              this.lineBufferByteLen += charByteLen;
            }
          }
        }
      }
    });

    // Handle process exit — reject all pending requests immediately
    this.process.on("exit", (code) => {
      this.running = false;
      process.stderr.write(
        `[mcp:${this.config.name}] process exited with code ${code}\n`,
      );
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `MCPServerProcess(${this.config.name}): process exited (code ${code})`,
          ),
        );
        this.pendingRequests.delete(id);
      }
    });

    // P1 FIX: Reject all pending requests on process error (not just on exit).
    this.process.on("error", (err) => {
      this.running = false;
      process.stderr.write(
        `[mcp:${this.config.name}] process error: ${err.message}\n`,
      );
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `MCPServerProcess(${this.config.name}): process error: ${err.message}`,
          ),
        );
        this.pendingRequests.delete(id);
      }
      this.process = null;
    });

    this.running = true;
  }

  /**
   * Sends a JSON-RPC request and waits for the response.
   *
   * @param method - The JSON-RPC method name
   * @param params - The method parameters
   * @returns The result field of the JSON-RPC response
   * @throws {Error} on timeout, process exit, or JSON-RPC error
   */
  async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.running || !this.process?.stdin) {
      throw new Error(
        `MCPServerProcess(${this.config.name}): not running`,
      );
    }

    // PERF-07: Semaphore — reject if too many concurrent requests.
    // TOCTOU FIX: The check and the slot reservation (pendingRequests.set) must
    // happen in the same synchronous microtask with no await in between.
    // In JS single-threaded execution, this guarantees atomicity: no other
    // coroutine can interleave between the size check and the set call.
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      throw new Error(
        `MCPServerProcess(${this.config.name}): MAX_REQUESTS_EXCEEDED — too many concurrent requests (limit: ${MAX_PENDING_REQUESTS})`,
      );
    }

    // TS1 FIX: Capture local references BEFORE creating the Promise.
    // Non-null assertions inside async closures don't provide narrowing —
    // if stop() is called concurrently, this.process could be null at write time.
    const stdin = this.process.stdin;
    // Reserve the ID slot synchronously — BEFORE the Promise constructor.
    // The Promise constructor executor runs synchronously, so the set() call
    // below is still in the same microtask as the check above (no await between them).
    const id = this.nextId++;
    const timeout = this.config.timeout ?? 5000;

    const request = {
      jsonrpc: "2.0" as const,
      id,
      method,
      params,
    };

    // The Promise constructor executor is synchronous: resolve/reject/timer are
    // captured and pendingRequests.set() is called before any await can yield.
    // This ensures the slot is reserved atomically with respect to the size check above.
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `MCPServerProcess(${this.config.name}): timeout after ${timeout}ms for method "${method}"`,
          ),
        );
      }, timeout);

      // Slot reserved here — synchronously within the Promise constructor executor.
      this.pendingRequests.set(id, { resolve, reject, timer });

      const line = JSON.stringify(request) + "\n";
      // Use captured local `stdin` reference — safe even if this.process becomes null
      stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(
            new Error(
              `MCPServerProcess(${this.config.name}): write error: ${err.message}`,
            ),
          );
        }
      });
    });
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   *
   * @param method - The notification method name
   * @param params - Optional parameters
   */
  sendNotification(method: string, params?: unknown): void {
    if (!this.running || !this.process?.stdin) {
      return;
    }

    const notification: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) {
      notification.params = params;
    }

    const line = JSON.stringify(notification) + "\n";
    this.process.stdin.write(line);
  }

  /**
   * Stops the MCP server subprocess gracefully.
   *
   * Sends SIGTERM, waits up to 1 second, then SIGKILL.
   * Rejects all pending requests immediately.
   * Idempotent — safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.running || !this.process) {
      this.running = false;
      return;
    }

    this.running = false;

    // TS2 FIX: Capture local reference BEFORE the async Promise block.
    const proc = this.process;
    this.process = null;

    // Reset buffers
    this.lineBuffer = "";
    this.lineBufferByteLen = 0;
    this.lineBufferOversized = false;
    this.stderrBuffer = "";

    // Reject all pending requests immediately
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`MCPServerProcess(${this.config.name}): process stopped`),
      );
      this.pendingRequests.delete(id);
    }

    // Close stdin to signal EOF to the server
    proc.stdin?.end();

    // Wait for graceful exit, then SIGKILL
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 1000);

      // Use captured local `proc` reference — safe even if this.process is null
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      proc.kill("SIGTERM");
    });
  }

  // ─── Private ────────────────────────────────────────────────────

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // SEC-ANSI FIX: Sanitize the raw line before writing to stderr to prevent
      // ANSI escape injection from a malicious MCP server. Control characters
      // (0x00–0x1f, 0x7f) are replaced with their hex escape representation.
      const safeLine = trimmed.replace(
        /[\x00-\x1f\x7f]/g,
        (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      process.stderr.write(
        `[mcp:${this.config.name}] failed to parse line: ${safeLine}\n`,
      );
      return;
    }

    // Only handle responses (messages with an id and result/error)
    const id = msg.id;
    if (typeof id !== "number") return;

    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if ("error" in msg && msg.error !== undefined) {
      // TS3 FIX: Validate error shape before accessing fields.
      // A malformed MCP server could return an error without code/message,
      // causing undefined values if we cast blindly.
      const rawErr = msg.error;
      const errCode =
        typeof rawErr === "object" &&
        rawErr !== null &&
        "code" in rawErr
          ? (rawErr as Record<string, unknown>).code
          : undefined;
      const errMsg =
        typeof rawErr === "object" &&
        rawErr !== null &&
        "message" in rawErr
          ? String((rawErr as Record<string, unknown>).message)
          : "unknown MCP error";

      pending.reject(
        new Error(`MCP error ${String(errCode ?? "?")}: ${errMsg}`),
      );
    } else {
      pending.resolve(msg.result);
    }
  }
}
