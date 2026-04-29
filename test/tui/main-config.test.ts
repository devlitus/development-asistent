import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { Config } from "../../src/config/schema.ts";

// We import detectProvider after mocking — using dynamic import to allow mock injection.
// Since bun:test doesn't support module-level mocking of ESM easily, we test
// detectProvider by importing it directly and passing the config argument.
import { detectProvider } from "../../scripts/tui-client.tsx";

// ─── Test 1: detectProvider usa config.toml cuando tiene provider y model ─────

describe("detectProvider", () => {
  it("usa config.toml cuando tiene provider y model", () => {
    const config: Config = {
      agents: {
        orchestrator: { provider: "lmstudio", model: "qwen3-27b" },
      },
      mcp: { servers: [] },
      context: { maxTokens: 100000, summaryThreshold: 0.7 },
    };

    const result = detectProvider(config);

    expect(result).toContain("lmstudio");
    expect(result).toContain("qwen3-27b");
  });

  it("usa env vars como fallback cuando no hay config.toml", () => {
    // Save and clear relevant env vars
    const saved = process.env["LM_STUDIO_HOST"];
    process.env["LM_STUDIO_HOST"] = "http://localhost:1234";

    // Also clear other provider keys that take priority
    const savedAnthropic = process.env["ANTHROPIC_API_KEY"];
    const savedOpenAI = process.env["OPENAI_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];

    try {
      const result = detectProvider(undefined);
      expect(result).toContain("LM Studio");
    } finally {
      if (saved !== undefined) {
        process.env["LM_STUDIO_HOST"] = saved;
      } else {
        delete process.env["LM_STUDIO_HOST"];
      }
      if (savedAnthropic !== undefined) process.env["ANTHROPIC_API_KEY"] = savedAnthropic;
      if (savedOpenAI !== undefined) process.env["OPENAI_API_KEY"] = savedOpenAI;
    }
  });

  it("retorna 'desconocido' sin config ni env vars", () => {
    // Save and clear all relevant env vars
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LM_STUDIO_HOST", "LLAMACPP_HOST", "OLLAMA_HOST"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const result = detectProvider(undefined);
      expect(result).toBe("desconocido");
    } finally {
      for (const key of keys) {
        if (saved[key] !== undefined) {
          process.env[key] = saved[key];
        }
      }
    }
  });
});
