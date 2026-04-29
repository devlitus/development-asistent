/**
 * Sub-agent and orchestrator types.
 */

import type { SessionId } from "./persistence.ts";
import type { ChatMessage, ToolResult } from "./llm.ts";

export const AGENT_TYPES = {
  CODE: "code",
  OS: "os",
  DOCS: "docs",
  GIT: "git",
} as const;

export type AgentType = (typeof AGENT_TYPES)[keyof typeof AGENT_TYPES];

export interface AgentContext {
  readonly sessionId: SessionId;
  readonly prompt: string;
  readonly workingDir: string;
  readonly sessionHistory?: readonly ChatMessage[];
}

export type AgentResult =
  | { readonly success: true; readonly output: string; readonly toolCalls?: readonly ToolResult[] }
  | { readonly success: false; readonly output: string; readonly error: string; readonly toolCalls?: readonly ToolResult[] };

export interface Agent {
  readonly name: string;
  readonly type: AgentType;
  readonly systemPrompt: string;
  execute(context: AgentContext): Promise<AgentResult>;
}
