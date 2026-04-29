/**
 * Tests for shared agent utilities (ARCH-01).
 *
 * Verifies isExtendedContext, parseToolArguments, and truncateContent
 * extracted to src/agents/shared/agent-utils.ts.
 */

import { describe, it, expect } from "bun:test";
import {
  isExtendedContext,
  parseToolArguments,
  truncateContent,
} from "../../../src/agents/shared/agent-utils.ts";
import type { AgentContext } from "../../../src/types/agent.ts";
import { AGENT_TYPES } from "../../../src/types/agent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseContext(overrides: Record<string, unknown> = {}): AgentContext {
  return {
    sessionId: "test-session" as AgentContext["sessionId"],
    prompt: "test prompt",
    agentType: AGENT_TYPES.CODE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isExtendedContext
// ---------------------------------------------------------------------------

describe("isExtendedContext", () => {
  it("returns true when llmProvider, workspacePath, and availableTools are present", () => {
    const ctx = makeBaseContext({
      llmProvider: { chat: () => {} },
      workspacePath: "/workspace",
      availableTools: [],
    });
    expect(isExtendedContext(ctx)).toBe(true);
  });

  it("returns false when llmProvider is missing", () => {
    const ctx = makeBaseContext({
      workspacePath: "/workspace",
      availableTools: [],
    });
    expect(isExtendedContext(ctx)).toBe(false);
  });

  it("returns false when workspacePath is missing", () => {
    const ctx = makeBaseContext({
      llmProvider: { chat: () => {} },
      availableTools: [],
    });
    expect(isExtendedContext(ctx)).toBe(false);
  });

  it("returns false when availableTools is missing", () => {
    const ctx = makeBaseContext({
      llmProvider: { chat: () => {} },
      workspacePath: "/workspace",
    });
    expect(isExtendedContext(ctx)).toBe(false);
  });

  it("returns false when availableTools is not an array", () => {
    const ctx = makeBaseContext({
      llmProvider: { chat: () => {} },
      workspacePath: "/workspace",
      availableTools: "not-an-array",
    });
    expect(isExtendedContext(ctx)).toBe(false);
  });

  it("returns false when llmProvider is null", () => {
    const ctx = makeBaseContext({
      llmProvider: null,
      workspacePath: "/workspace",
      availableTools: [],
    });
    expect(isExtendedContext(ctx)).toBe(false);
  });

  it("returns false when llmProvider is a string (not an object)", () => {
    const ctx = makeBaseContext({
      llmProvider: "not-an-object",
      workspacePath: "/workspace",
      availableTools: [],
    });
    expect(isExtendedContext(ctx)).toBe(false);
  });

  it("returns false when workspacePath is not a string", () => {
    const ctx = makeBaseContext({
      llmProvider: { chat: () => {} },
      workspacePath: 42,
      availableTools: [],
    });
    expect(isExtendedContext(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseToolArguments
// ---------------------------------------------------------------------------

describe("parseToolArguments", () => {
  it("parses a valid JSON object string", () => {
    const result = parseToolArguments('{"key": "value", "num": 42}');
    expect(result).toEqual({ key: "value", num: 42 });
  });

  it("returns empty object for invalid JSON", () => {
    const result = parseToolArguments("not-json");
    expect(result).toEqual({});
  });

  it("returns empty object when JSON is an array", () => {
    const result = parseToolArguments('["a", "b"]');
    expect(result).toEqual({});
  });

  it("returns empty object when JSON is a primitive string", () => {
    const result = parseToolArguments('"just a string"');
    expect(result).toEqual({});
  });

  it("returns empty object when JSON is a number", () => {
    const result = parseToolArguments("42");
    expect(result).toEqual({});
  });

  it("returns empty object when JSON is null", () => {
    const result = parseToolArguments("null");
    expect(result).toEqual({});
  });

  it("returns empty object for empty string", () => {
    const result = parseToolArguments("");
    expect(result).toEqual({});
  });

  it("accepts nested objects", () => {
    const result = parseToolArguments('{"nested": {"a": 1}}');
    expect(result).toEqual({ nested: { a: 1 } });
  });

  it("uses agentName in log prefix (does not throw)", () => {
    // Just verifies it doesn't throw with a custom agentName
    expect(() => parseToolArguments("bad-json", "my-agent")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// truncateContent
// ---------------------------------------------------------------------------

describe("truncateContent", () => {
  it("returns content unchanged when within limit", () => {
    const content = "hello world";
    expect(truncateContent(content, 100)).toBe(content);
  });

  it("returns content unchanged when exactly at limit", () => {
    const content = "a".repeat(50);
    expect(truncateContent(content, 50)).toBe(content);
  });

  it("truncates content that exceeds the limit", () => {
    const content = "a".repeat(200);
    const result = truncateContent(content, 100);
    expect(result.startsWith("a".repeat(100))).toBe(true);
    expect(result.length).toBeGreaterThan(100); // includes the marker
  });

  it("appends the truncation marker when truncated", () => {
    const content = "x".repeat(200);
    const result = truncateContent(content, 100);
    expect(result).toContain("--- TOOL OUTPUT TRUNCATED ---");
    expect(result).toContain("--- END TRUNCATION NOTICE ---");
  });

  it("includes the byte count in the truncation notice", () => {
    const content = "x".repeat(200);
    const result = truncateContent(content, 100);
    expect(result).toContain("100 bytes");
  });

  it("handles empty string", () => {
    expect(truncateContent("", 10)).toBe("");
  });

  it("handles maxBytes of 0 — truncates everything", () => {
    const result = truncateContent("hello", 0);
    expect(result).toContain("--- TOOL OUTPUT TRUNCATED ---");
    expect(result.startsWith("--- TOOL OUTPUT TRUNCATED ---")).toBe(false); // starts with empty slice
  });
});
