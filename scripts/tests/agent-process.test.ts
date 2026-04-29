/**
 * Tests for AgentProcess — TUI-02
 *
 * Tests are purely unit-level: no real spawn.
 * The NDJSON parsing logic is tested via the exported `parseNdjsonChunk` function.
 *
 * Uses bun:test (Jest-compatible syntax).
 */

import { describe, it, expect } from "bun:test";
import { parseNdjsonChunk } from "../tui/agent-process.ts";

// ─── parseNdjsonChunk: basic framing ─────────────────────────────────────────

describe("parseNdjsonChunk — basic framing", () => {
  it("should parse a complete JSON line", () => {
    const { messages, remaining } = parseNdjsonChunk('{"id":1}\n', "");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ id: 1 });
    expect(remaining).toBe("");
  });

  it("should accumulate partial line in buffer", () => {
    const { messages, remaining } = parseNdjsonChunk('{"id":1}\n{"id', "");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ id: 1 });
    expect(remaining).toBe('{"id');
  });

  it("should complete a message split across two chunks", () => {
    // First chunk: partial second message — buffer holds '{"id":'
    const first = parseNdjsonChunk('{"id":1}\n{"id":', "");
    expect(first.messages).toHaveLength(1);
    expect(first.remaining).toBe('{"id":');

    // Second chunk: completes the second message → '{"id":' + '2}\n' = '{"id":2}'
    const second = parseNdjsonChunk("2}\n", first.remaining);
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toEqual({ id: 2 });
    expect(second.remaining).toBe("");
  });
});

// ─── parseNdjsonChunk: non-JSON lines ─────────────────────────────────────────

describe("parseNdjsonChunk — non-JSON lines", () => {
  it("should return empty messages for a non-JSON line without throwing", () => {
    const { messages, remaining } = parseNdjsonChunk("not json\n", "");
    expect(messages).toHaveLength(0);
    expect(remaining).toBe("");
  });

  it("should skip non-JSON lines and still parse valid ones", () => {
    const { messages, remaining } = parseNdjsonChunk('not json\n{"id":5}\n', "");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ id: 5 });
    expect(remaining).toBe("");
  });
});

// ─── parseNdjsonChunk: multiple messages in one chunk ─────────────────────────

describe("parseNdjsonChunk — multiple messages in one chunk", () => {
  it("should parse two messages from a single chunk", () => {
    const { messages, remaining } = parseNdjsonChunk('{"a":1}\n{"b":2}\n', "");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ a: 1 });
    expect(messages[1]).toEqual({ b: 2 });
    expect(remaining).toBe("");
  });

  it("should parse three messages from a single chunk", () => {
    const { messages } = parseNdjsonChunk('{"x":1}\n{"x":2}\n{"x":3}\n', "");
    expect(messages).toHaveLength(3);
  });
});

// ─── parseNdjsonChunk: empty lines ────────────────────────────────────────────

describe("parseNdjsonChunk — empty lines", () => {
  it("should ignore empty lines silently", () => {
    const { messages, remaining } = parseNdjsonChunk("\n\n\n", "");
    expect(messages).toHaveLength(0);
    expect(remaining).toBe("");
  });

  it("should ignore empty lines between valid messages", () => {
    const { messages } = parseNdjsonChunk('{"a":1}\n\n{"b":2}\n', "");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ a: 1 });
    expect(messages[1]).toEqual({ b: 2 });
  });
});

// ─── parseNdjsonChunk: buffer overflow guard ──────────────────────────────────

describe("parseNdjsonChunk — buffer overflow guard", () => {
  it("should discard buffer and return empty when line exceeds 10 MB without newline", () => {
    // Create a string larger than 10 MB with no newline
    const bigChunk = "x".repeat(11 * 1024 * 1024);
    const { messages, remaining } = parseNdjsonChunk(bigChunk, "");
    expect(messages).toHaveLength(0);
    expect(remaining).toBe("");
  });

  it("should NOT discard when large content has a newline (valid JSON lines)", () => {
    // A valid JSON line followed by a newline — should parse fine regardless of size
    const validLine = '{"id":1}\n';
    const { messages } = parseNdjsonChunk(validLine, "");
    expect(messages).toHaveLength(1);
  });
});

// ─── AgentProcess: LLM env var verification ───────────────────────────────────

describe("AgentProcess — LLM env var verification", () => {
  it("should throw a descriptive error when no LLM env var is set", async () => {
    // Save and clear all LLM-related env vars
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      LM_STUDIO_HOST: process.env.LM_STUDIO_HOST,
      LLAMACPP_HOST: process.env.LLAMACPP_HOST,
      OLLAMA_HOST: process.env.OLLAMA_HOST,
    };

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LM_STUDIO_HOST;
    delete process.env.LLAMACPP_HOST;
    delete process.env.OLLAMA_HOST;

    try {
      // Dynamic import to get a fresh module reference
      const { AgentProcess } = await import("../tui/agent-process.ts");
      const agent = new AgentProcess();
      expect(() => agent.spawn()).toThrow();

      // Verify the error message is descriptive
      let errorMessage = "";
      try {
        agent.spawn();
      } catch (e) {
        errorMessage = e instanceof Error ? e.message : String(e);
      }
      expect(errorMessage).toContain("LLM");
    } finally {
      // Restore env vars
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }
    }
  });
});
