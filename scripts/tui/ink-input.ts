/**
 * ink-input.ts — INK-03
 *
 * Implementación de IInput usando el estado React de TuiApp.
 * No usa readline — el input se captura en <InputLine> con useInput de Ink.
 *
 * InkInput inyecta callbacks en TuiAppState para coordinarse con el componente:
 *   - onSubmit: llamado por <InputLine> cuando el usuario pulsa Enter
 *   - onPermissionResponse: llamado por <InputLine> en modo permiso
 *
 * parseInputLine de input.ts se reutiliza sin modificación.
 */

import type { IInput } from "../tui-client.tsx";
import type { SetAppState } from "./ink-renderer.tsx";
import type { PermissionRequest } from "./types.ts";
import { parseInputLine } from "./input.ts";

export class InkInput implements IInput {
  private readonly promptHandlers: Array<(text: string) => void> = [];
  private readonly commandHandlers: Array<(cmd: string) => void> = [];
  private readonly quitHandlers: Array<() => void> = [];

  constructor(private readonly setAppState: SetAppState) {}

  // ─── IInput API ──────────────────────────────────────────────────────────────

  start(): void {
    this.setAppState((s) => ({
      ...s,
      inputEnabled: true,
      onSubmit: (text: string) => this.handleSubmit(text),
      onArrowUp: () => this.handleArrowUp(),
      onArrowDown: () => this.handleArrowDown(),
    }));
  }

  pause(): void {
    this.setAppState((s) => ({ ...s, inputEnabled: false }));
  }

  resume(): void {
    this.setAppState((s) => ({ ...s, inputEnabled: true, inputValue: "" }));
  }

  close(): void {
    this.setAppState((s) => ({
      ...s,
      onSubmit: undefined,
      onPermissionResponse: undefined,
      pendingPermission: undefined,
    }));
  }

  async askPermission(req: PermissionRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.setAppState((s) => ({
        ...s,
        pendingPermission: req,
        onPermissionResponse: (answer: string) => {
          const normalized = answer.trim().toLowerCase();
          const approved = normalized === "y" || normalized === "yes";
          // Limpiar estado de permiso
          this.setAppState((prev) => ({
            ...prev,
            pendingPermission: undefined,
            onPermissionResponse: undefined,
          }));
          resolve(approved);
        },
      }));
    });
  }

  onPrompt(handler: (text: string) => void): void {
    this.promptHandlers.push(handler);
  }

  onCommand(handler: (cmd: string) => void): void {
    this.commandHandlers.push(handler);
  }

  onQuit(handler: () => void): void {
    this.quitHandlers.push(handler);
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private handleSubmit(text: string): void {
    const parsed = parseInputLine(text);

    switch (parsed.type) {
      case "empty":
        break;

      case "command":
        this.dispatchCommand(parsed.command);
        break;

      case "prompt":
        this.promptHandlers.forEach((h) => h(parsed.text));
        break;
    }
  }

  private dispatchCommand(command: string): void {
    switch (command) {
      case "quit":
        this.quitHandlers.forEach((h) => h());
        break;

      case "help":
      case "clear":
      case "new-session":
      case "status":
      case "sessions":
      case "resume-missing-id":
        this.commandHandlers.forEach((h) => h(command));
        break;

      default:
        // resume:<id> — pasa el comando completo a los handlers
        if (command.startsWith("resume:")) {
          this.commandHandlers.forEach((h) => h(command));
        }
        break;
    }
  }

  // ─── Scroll helpers (called by useInput in the Ink component) ────────────────

  handleArrowUp(): void {
    this.setAppState((s) => {
      if (s.pendingPermission) return s;
      // C4: clampar en el setter usando el tamaño actual del array de mensajes
      // visibleCount aproximado: rows - 6 (header + spinner + input + márgenes)
      const rows = process.stdout.rows ?? 24;
      const visibleCount = Math.max(1, rows - 6);
      const maxOffset = Math.max(0, s.messages.length - visibleCount);
      return { ...s, scrollOffset: Math.min(s.scrollOffset + 1, maxOffset) };
    });
  }

  handleArrowDown(): void {
    this.setAppState((s) => {
      if (s.pendingPermission) return s;
      return { ...s, scrollOffset: Math.max(0, s.scrollOffset - 1) };
    });
  }
}
