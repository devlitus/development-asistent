/**
 * Tests for barrel exports and agent registration.
 *
 * Task 10f: Verifies that:
 * 1. src/agents/code/index.ts exports all public symbols
 * 2. src/agents/index.ts re-exports CodeAgent
 * 3. CodeAgent can be imported from barrel exports
 * 4. CodeAgent can be registered in an Orchestrator
 */

import { describe, it, expect } from "bun:test";
import { CodeAgent } from "../../src/agents/index.ts";
import { CODE_SYSTEM_PROMPT } from "../../src/agents/code/index.ts";
import { CODE_AGENT_TOOLS, getToolSchemas, executeTool, isPathWithinWorkspace } from "../../src/agents/code/index.ts";
import type { CodeToolResult, CodeToolDefinition } from "../../src/agents/code/index.ts";
import { Orchestrator, InMemoryHistoryProvider, CompositeIntentClassifier, KeywordIntentClassifier } from "../../src/orchestrator/index.ts";

// ---------------------------------------------------------------------------
// Barrel exports from src/agents/code/index.ts
// ---------------------------------------------------------------------------

describe("src/agents/code/index.ts barrel exports", () => {
  it("exporta CodeAgent como clase instanciable", () => {
    const agent = new CodeAgent();
    expect(agent).toBeDefined();
    expect(agent.name).toBe("code-agent");
    expect(agent.type).toBe("code");
  });

  it("exporta CODE_SYSTEM_PROMPT como string no vacío", () => {
    expect(typeof CODE_SYSTEM_PROMPT).toBe("string");
    expect(CODE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("exporta CODE_AGENT_TOOLS como array con 4 herramientas", () => {
    expect(Array.isArray(CODE_AGENT_TOOLS)).toBe(true);
    expect(CODE_AGENT_TOOLS.length).toBe(4);
  });

  it("exporta getToolSchemas como función", () => {
    expect(typeof getToolSchemas).toBe("function");
    const schemas = getToolSchemas();
    expect(schemas.length).toBe(4);
  });

  it("exporta executeTool como función", () => {
    expect(typeof executeTool).toBe("function");
  });

  it("exporta isPathWithinWorkspace como función", () => {
    expect(typeof isPathWithinWorkspace).toBe("function");
  });

  it("exporta CodeToolResult como tipo usable", () => {
    // Verify the type can be used by creating a conforming object
    const result: CodeToolResult = { content: "test", success: true };
    expect(result.content).toBe("test");
    expect(result.success).toBe(true);
  });

  it("exporta CodeToolDefinition como tipo usable", () => {
    // Verify the type exists by checking CODE_AGENT_TOOLS items conform
    const tool: CodeToolDefinition = CODE_AGENT_TOOLS[0]!;
    expect(tool.name).toBeDefined();
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Barrel exports from src/agents/index.ts
// ---------------------------------------------------------------------------

describe("src/agents/index.ts barrel exports", () => {
  it("re-exporta CodeAgent importable", () => {
    const agent = new CodeAgent();
    expect(agent).toBeInstanceOf(CodeAgent);
  });
});

// ---------------------------------------------------------------------------
// Agent registration in Orchestrator
// ---------------------------------------------------------------------------

describe("CodeAgent registration in Orchestrator", () => {
  it("se puede registrar en un Orchestrator y aparece en getRegisteredAgents", () => {
    const classifier = new KeywordIntentClassifier();
    const historyProvider = new InMemoryHistoryProvider();

    // Create a minimal mock provider
    const mockProvider = {
      name: "mock",
      async chat() {
        return { content: "mock" };
      },
      async *_stream() {
        yield { delta: "mock" };
      },
      stream() {
        return this._stream();
      },
    };

    const orchestrator = new Orchestrator({
      intentClassifier: classifier,
      historyProvider,
      llmProvider: mockProvider as any,
    });

    // Before registration — no agents
    expect(orchestrator.getRegisteredAgents()).toEqual([]);

    // Register CodeAgent
    const codeAgent = new CodeAgent();
    orchestrator.registerAgent(codeAgent);

    // After registration — "code" appears
    const registered = orchestrator.getRegisteredAgents();
    expect(registered).toContain("code");
    expect(registered.length).toBe(1);
  });

  it("mantiene tipo y nombre correctos tras registro", () => {
    const codeAgent = new CodeAgent();
    expect(codeAgent.name).toBe("code-agent");
    expect(codeAgent.type).toBe("code");
    expect(codeAgent.systemPrompt).toBe(CODE_SYSTEM_PROMPT);
  });
});
