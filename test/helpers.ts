/**
 * Test helpers for setting up in-memory agent infrastructure.
 *
 * Provides reusable factories for tests that need Orchestrator,
 * SessionStore, and mock agents without duplicating boilerplate.
 */

import type { Agent, AgentType, AgentResult, AgentContext } from "../src/types/agent.ts";
import type { LLMProvider } from "../src/types/llm.ts";
import { Orchestrator } from "../src/orchestrator/orchestrator.ts";
import { InMemoryHistoryProvider } from "../src/orchestrator/history-provider.ts";
import { KeywordIntentClassifier } from "../src/orchestrator/intent-classifier.ts";
import { SessionStore } from "../src/protocol/session-store.ts";
import { createMockLLMProvider } from "./llm/mock-providers.ts";

// ─── Stream / Output helpers ──────────────────────────────────────

/**
 * Creates a ReadableStream<Uint8Array> that emits the given string and closes.
 */
export function createInputStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

/**
 * Creates a mock output that captures written strings and parses them as JSON.
 */
export function createMockOutput(): {
  write(s: string): void;
  readonly chunks: string[];
  readonly messages: unknown[];
} {
  const chunks: string[] = [];
  return {
    write(s: string) {
      chunks.push(s);
    },
    get chunks() {
      return chunks;
    },
    get messages() {
      return chunks.map((c) => JSON.parse(c.trim()));
    },
  };
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────

/**
 * Builds a JSON-RPC 2.0 request string.
 */
export function jsonrpc(id: number | string, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined && { params }),
  });
}

// ─── Agent mock factories ─────────────────────────────────────────

/**
 * Creates a mock Agent with a configurable result.
 */
export function createMockAgent(type: AgentType, result: AgentResult): Agent {
  return {
    name: `mock-${type}`,
    type,
    systemPrompt: `Mock ${type} agent`,
    execute(_context: AgentContext): Promise<AgentResult> {
      return Promise.resolve(result);
    },
  };
}

/**
 * Creates a mock Agent that throws an error on execute.
 */
export function createThrowingAgent(type: AgentType, errorMsg: string): Agent {
  return {
    name: `mock-${type}`,
    type,
    systemPrompt: `Mock ${type} agent`,
    execute(_context: AgentContext): Promise<AgentResult> {
      return Promise.reject(new Error(errorMsg));
    },
  };
}

// ─── Full in-memory setup ─────────────────────────────────────────

/**
 * Creates a complete in-memory setup: Orchestrator + SessionStore + InMemoryHistoryProvider.
 *
 * Optionally registers mock agents and uses a keyword classifier by default.
 */
export function createInMemorySetup(config?: {
  agents?: Array<{ type: AgentType; result: AgentResult }>;
  llmProvider?: LLMProvider;
}): {
  orchestrator: Orchestrator;
  sessions: SessionStore;
  historyProvider: InMemoryHistoryProvider;
} {
  const historyProvider = new InMemoryHistoryProvider();
  const sessions = new SessionStore();
  const llmProvider = config?.llmProvider ?? createMockLLMProvider();

  const intentClassifier = new KeywordIntentClassifier();

  const orchestrator = new Orchestrator({
    intentClassifier,
    historyProvider,
    llmProvider,
  });

  for (const agentConfig of config?.agents ?? []) {
    orchestrator.registerAgent(createMockAgent(agentConfig.type, agentConfig.result));
  }

  return { orchestrator, sessions, historyProvider };
}
