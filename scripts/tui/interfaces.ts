/**
 * interfaces.ts — INK-06
 *
 * Interfaces compartidas entre tui-client.tsx e ink-renderer.tsx.
 * Separadas para evitar dependencias circulares.
 */

import type { TuiStatus, PermissionRequest } from "./types.ts";

/** Minimal interface of TuiRenderer used by the orchestrator. */
export interface IRenderer {
  renderHeader(version: string): void;
  renderStatusBar(status: TuiStatus): void;
  renderUserMessage(text: string): void;
  renderAgentMessageStart(agentName?: string): void;
  renderStreamChunk(chunk: string): void;
  renderAgentMessageEnd(): void;
  renderSystemMessage(text: string): void;
  renderError(message: string): void;
  renderPermissionRequest(req: PermissionRequest): void;
  renderTurnSeparator(): void;
  startSpinner(label?: string): void;
  stopSpinner(): void;
  renderRoutingInfo(agentName: string): void;
  renderToolCall(name: string, input: unknown): void;
  renderToolResult(toolName: string, content: string): void;
  /** Clears all messages and stream buffer (used by /clear command). */
  clearMessages(): void;
  /** Resets scroll offset to 0 (bottom of conversation). */
  resetScroll(): void;
  /** M4: actualiza el label del spinner dinámicamente. Opcional para no romper mocks. */
  updateSpinnerLabel?(label: string): void;
}
