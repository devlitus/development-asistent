/**
 * Internal types for the Code Agent module.
 *
 * Defines the contracts for tool results, executors, and tool definitions
 * that power the code agent's filesystem operations.
 */

import type { ToolCall } from "../../types/llm.ts";

/** Resultado de ejecutar una herramienta del code agent. */
export interface CodeToolResult {
  /** Contenido del resultado (output de la herramienta). */
  readonly content: string;
  /** Error message si la ejecución falló. */
  readonly error?: string;
  /** Si la ejecución fue exitosa. */
  readonly success: boolean;
}

/** Función que ejecuta una herramienta. */
export type CodeToolExecutor = (
  args: Record<string, unknown>,
  workspacePath: string,
) => Promise<CodeToolResult>;

/** Definición completa de una herramienta (schema + ejecutor). */
export interface CodeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: string[];
  };
  readonly execute: CodeToolExecutor;
}
