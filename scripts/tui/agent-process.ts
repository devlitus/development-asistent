/**
 * AgentProcess — TUI-02
 *
 * Encapsulates the lifecycle of the agent child process:
 *   - spawn with stdio pipes
 *   - NDJSON framing on stdout
 *   - message/exit event handlers
 *   - graceful kill (SIGTERM → SIGKILL after 2s)
 *
 * Also exports `parseNdjsonChunk` as a pure function for unit testing.
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import type { AgentMessage } from "./types.ts";

// ─── LLM env var names ────────────────────────────────────────────────────────

export const LLM_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LM_STUDIO_HOST",
  "LLAMACPP_HOST",
  "OLLAMA_HOST",
] as const;

// ─── parseNdjsonChunk ─────────────────────────────────────────────────────────

const MAX_LINE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Pure function: given a new `chunk` of text and the current `buffer` (partial
 * line from previous call), returns:
 *   - `messages`: all successfully parsed JSON objects from complete lines
 *   - `remaining`: the leftover partial line (no trailing newline yet)
 *
 * Non-JSON lines and empty lines are silently ignored.
 * Non-JSON lines are logged to stderr with the `[tui]` prefix.
 */
export function parseNdjsonChunk(
  chunk: string,
  buffer: string,
): { messages: unknown[]; remaining: string } {
  const combined = (buffer ?? "") + chunk;

  // Guard OOM: si el buffer sin newline supera el límite, descartarlo
  if (combined.length > MAX_LINE_BYTES && !combined.includes("\n")) {
    process.stderr.write(`[tui] WARN: NDJSON buffer exceeded ${MAX_LINE_BYTES} bytes, discarding\n`);
    return { messages: [], remaining: "" };
  }

  const lines = combined.split("\n");

  // The last element is either "" (if chunk ended with \n) or a partial line
  const remaining = lines.pop() ?? "";

  const messages: unknown[] = [];

  for (const line of lines) {
    // Skip empty lines silently
    if (line.trim() === "") continue;

    try {
      messages.push(JSON.parse(line));
    } catch {
      // Non-JSON line: log to stderr and ignore
      process.stderr.write(`[tui] Non-JSON line from agent: ${line}\n`);
    }
  }

  return { messages, remaining };
}

// ─── AgentProcess ─────────────────────────────────────────────────────────────

/**
 * Type guard: validates that an unknown value has the shape of an AgentMessage.
 */
function isAgentMessage(val: unknown): val is AgentMessage {
  if (typeof val !== "object" || val === null) return false;
  const v = val as Record<string, unknown>;
  if (v["jsonrpc"] !== "2.0") return false;
  // Response with id
  if (typeof v["id"] === "number") {
    if ("result" in v) return true;
    // Verify error has message: string to avoid runtime TypeError on error.message access (TS-NEW-2)
    if ("error" in v && typeof v["error"] === "object" && v["error"] !== null) {
      return typeof (v["error"] as Record<string, unknown>)["message"] === "string";
    }
    return false;
  }
  // Notification without id
  return typeof v["method"] === "string";
}

/**
 * Manages the agent child process lifecycle.
 *
 * Usage:
 *   const agent = new AgentProcess();
 *   agent.onMessage((msg) => { ... });
 *   agent.onExit((code) => { ... });
 *   agent.spawn();
 *   agent.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
 *   agent.kill();
 */
export class AgentProcess {
  #child: ChildProcess | null = null;
  #messageHandlers: Array<(msg: AgentMessage) => void> = [];
  #exitHandlers: Array<(code: number | null) => void> = [];
  #ndjsonBuffer: string = "";

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Spawn the agent child process.
   *
   * Throws if no LLM provider env var is configured.
   */
  spawn(): void {
    this.#assertLlmConfigured();

    // Build minimal child environment (FIX-1: SEC-A1)
    const childEnv: Record<string, string> = {};

    // Only LLM vars that are defined
    for (const key of LLM_ENV_VARS) {
      if (process.env[key]) childEnv[key] = process.env[key]!;
    }

    // System variables needed for Bun/Node to run
    for (const sysKey of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "USERPROFILE", "USERNAME"]) {
      if (process.env[sysKey]) childEnv[sysKey] = process.env[sysKey]!;
    }

    const child = spawn("bun", ["run", "src/index.ts"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: childEnv,
    });

    this.#child = child;
    this.#ndjsonBuffer = "";

    child.stdout!.on("data", (data: Buffer) => {
      const chunk = data.toString("utf-8");
      const { messages, remaining } = parseNdjsonChunk(chunk, this.#ndjsonBuffer);
      this.#ndjsonBuffer = remaining;

      for (const msg of messages) {
        if (isAgentMessage(msg)) {
          for (const handler of this.#messageHandlers) handler(msg);
        } else {
          process.stderr.write(`[tui] Unexpected message shape: ${JSON.stringify(msg)}\n`);
        }
      }
    });

    child.on("exit", (code) => {
      for (const handler of this.#exitHandlers) {
        handler(code);
      }
    });
  }

  /**
   * Send a JSON-RPC message to the agent via stdin.
   * Serializes to JSON + newline (NDJSON framing).
   */
  send(msg: object): void {
    if (!this.#child || !this.#child.stdin) {
      throw new Error("AgentProcess: cannot send — process not running");
    }
    this.#child.stdin.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Register a handler for incoming agent messages.
   * Multiple handlers can be registered; all are called in order.
   */
  onMessage(handler: (msg: AgentMessage) => void): void {
    this.#messageHandlers.push(handler);
  }

  /**
   * Register a handler for the process exit event.
   */
  onExit(handler: (code: number | null) => void): void {
    this.#exitHandlers.push(handler);
  }

  /**
   * Gracefully terminate the child process:
   *   1. Send SIGTERM
   *   2. If still alive after 2s, send SIGKILL
   */
  kill(): void {
    if (!this.#child) return;

    this.#child.kill("SIGTERM");

    const child = this.#child;
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 2000);

    // Clear the timer if the process exits on its own
    child.once("exit", () => clearTimeout(killTimer));
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Throws a descriptive error if no LLM provider env var is set.
   */
  #assertLlmConfigured(): void {
    const hasProvider = LLM_ENV_VARS.some((key) => Boolean(process.env[key]));
    if (!hasProvider) {
      throw new Error(
        "No LLM provider configured. Set one of the following environment variables:\n" +
          "  ANTHROPIC_API_KEY  — Anthropic Claude (cloud)\n" +
          "  OPENAI_API_KEY     — OpenAI GPT (cloud)\n" +
          "  LM_STUDIO_HOST     — LM Studio local (e.g. http://localhost:1234)\n" +
          "  LLAMACPP_HOST      — llama.cpp server (e.g. http://localhost:8080)\n" +
          "  OLLAMA_HOST        — Ollama (e.g. http://localhost:11434)",
      );
    }
  }
}
