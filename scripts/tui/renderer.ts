/**
 * TuiRenderer — TUI-04
 *
 * Gestiona toda la salida a process.stdout usando ANSI escape codes manuales.
 * Sin dependencias externas. Anti-flickering: nunca usa clear screen ni cursor up.
 *
 * Estrategia anti-flickering:
 *   - NO usa \x1b[2J (clear screen)
 *   - NO usa \x1b[H (cursor home)
 *   - NO usa \x1b[A (cursor up) excepto en clearLine
 *   - Streaming: chunks directos sin newline
 *   - Status bar: línea nueva (no sobreescribe)
 */

import type { TuiStatus, PermissionRequest } from "./types.ts";

// ─── ANSI palette ─────────────────────────────────────────────────────────────

const ANSI = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  italic:    "\x1b[3m",
  cyan:      "\x1b[36m",
  green:     "\x1b[32m",
  yellow:    "\x1b[33m",
  red:       "\x1b[31m",
  blue:      "\x1b[34m",
  gray:      "\x1b[90m",
  bgRed:     "\x1b[41m",
  clearLine: "\x1b[2K\r",  // borra línea actual y vuelve al inicio
} as const;

// ─── Writer interface ─────────────────────────────────────────────────────────

/** Minimal writer interface — injectable for testing. */
export interface Writer {
  write(s: string): void;
}

// ─── ANSI sanitization ────────────────────────────────────────────────────────

/**
 * Removes dangerous ANSI escape sequences from text.
 * Allows only SGR sequences (colors/styles: \x1b[...m).
 * Strips OSC (window title, hyperlinks, clipboard), DCS, APC, PM sequences.
 */
function sanitizeAnsiOsc(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b[P_^][^\x1b]*\x1b\\/g, "")           // DCS, APC, PM
    .replace(/\x1b\[[\d;?>=<!]*[A-LN-Za-ln-z]/g, "");   // CSI non-SGR (keep only \x1b[...m)
}

// ─── TuiRenderer ─────────────────────────────────────────────────────────────

/** Returns the visual terminal width of a string (accounts for double-width chars like emoji). */
function visualWidth(s: string): number {
  let width = 0;
  for (const char of s) {
    const cp = char.codePointAt(0) ?? 0;
    // Double-width: CJK Unified Ideographs, emoji, fullwidth forms (cp > 0x2E7F)
    width += cp > 0x2E7F ? 2 : 1;
  }
  return width;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Pre-computed turn separator line (40 em-dashes). */
const TURN_SEPARATOR = "─".repeat(40);

export class TuiRenderer {
  #spinnerTimer: ReturnType<typeof setInterval> | null = null;
  #spinnerFrame = 0;
  #spinnerStart = 0;

  constructor(private readonly writer: Writer = process.stdout) {}

  /** Inicia el spinner animado. Cancela cualquier spinner previo. */
  startSpinner(_label?: string): void {
    if (this.#spinnerTimer !== null) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = null;
    }
    this.#spinnerStart = Date.now();
    this.#spinnerFrame = 0;
    this.#spinnerTimer = setInterval(() => {
      const frame = SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length];
      this.#spinnerFrame++;
      const elapsed = Math.floor((Date.now() - this.#spinnerStart) / 1000);
      const elapsedStr = elapsed >= 1 ? ` ${elapsed}s` : "";
      this.writer.write(
        `${ANSI.clearLine}${ANSI.blue}${frame} Pensando...${elapsedStr}${ANSI.reset}`
      );
    }, 100);
  }

  /** Detiene el spinner y limpia la línea. */
  stopSpinner(): void {
    if (this.#spinnerTimer !== null) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = null;
    }
    this.writer.write(ANSI.clearLine);
  }

  /**
   * Renders a decorative header box — call ONCE at startup.
   *
   * Example output:
   * ╔══════════════════════════════════╗
   * ║  personal-asistent v0.1.0  🤖   ║
   * ╚══════════════════════════════════╝
   */
  renderHeader(version: string): void {
    const title = `  personal-asistent v${version}  🤖  `;
    // Measure visible width (emoji counts as 2 chars visually, but we keep it simple)
    const innerWidth = visualWidth(title); // visual width accounts for double-width chars (emoji)
    const top    = "╔" + "═".repeat(innerWidth) + "╗";
    const middle = "║" + title + "║";
    const bottom = "╚" + "═".repeat(innerWidth) + "╝";

    this.writer.write(
      `${ANSI.cyan}${ANSI.bold}${top}\n${middle}\n${bottom}${ANSI.reset}\n`
    );
  }

  /**
   * Renders the status bar as a new line (no cursor repositioning).
   * Color depends on the current TuiStatus.
   */
  renderStatusBar(status: TuiStatus): void {
    const { text, color } = this._statusStyle(status);
    this.writer.write(`${color}${text}${ANSI.reset}\n`);
  }

  /** Renders a user message with "You ›" prefix in cyan. */
  renderUserMessage(text: string): void {
    this.writer.write(`${ANSI.cyan}You ›${ANSI.reset} ${text}\n`);
  }

  /**
   * Renders the "Agent ›" prefix in green WITHOUT a trailing newline.
   * Subsequent renderStreamChunk calls will append to the same line.
   */
  renderAgentMessageStart(): void {
    this.writer.write(`${ANSI.green}Agent ›${ANSI.reset} `);
  }

  /** Writes a streaming chunk directly — NO newline added. */
  renderStreamChunk(chunk: string): void {
    this.writer.write(sanitizeAnsiOsc(chunk));
  }

  /** Closes the agent message line with a newline. */
  renderAgentMessageEnd(): void {
    this.writer.write("\n");
  }

  /** Renders a tool call notification in yellow. */
  renderToolCall(name: string, input: unknown): void {
    const inputStr = sanitizeAnsiOsc(JSON.stringify(input));
    this.writer.write(
      `${ANSI.yellow}⚙ Tool call: ${sanitizeAnsiOsc(name)}${ANSI.reset} ${ANSI.dim}${inputStr}${ANSI.reset}\n`
    );
  }

  /** Renders a tool result in gray. */
  renderToolResult(toolName: string, content: string): void {
    this.writer.write(
      `${ANSI.gray}↩ ${sanitizeAnsiOsc(toolName)}: ${sanitizeAnsiOsc(content)}${ANSI.reset}\n`
    );
  }

  /** Renders the routing info line (which agent was selected). */
  renderRoutingInfo(agentName: string): void {
    this.writer.write(
      `${ANSI.gray}→ ${sanitizeAnsiOsc(agentName)}${ANSI.reset}\n`
    );
  }

  /**
   * Renders a permission request block in yellow/red.
   * Prompts the user to confirm or deny.
   */
  renderPermissionRequest(req: PermissionRequest): void {
    const inputStr = sanitizeAnsiOsc(JSON.stringify(req.input, null, 2));
    const toolName = sanitizeAnsiOsc(req.toolName);
    const description = sanitizeAnsiOsc(req.description);
    this.writer.write(
      `${ANSI.yellow}${ANSI.bold}┌─ Permission Request ─────────────────────┐${ANSI.reset}\n` +
      `${ANSI.yellow}│ Tool:        ${ANSI.red}${toolName}${ANSI.reset}\n` +
      `${ANSI.yellow}│ Description: ${description}${ANSI.reset}\n` +
      `${ANSI.yellow}│ Input:       ${ANSI.dim}${inputStr}${ANSI.reset}\n` +
      `${ANSI.yellow}└──────────────────────────────────────────┘${ANSI.reset}\n` +
      `${ANSI.yellow}Allow? [Y/n]: ${ANSI.reset}\n`
    );
  }

  /** Renders an error message in red. */
  renderError(message: string): void {
    this.writer.write(`${ANSI.red}✖ Error: ${sanitizeAnsiOsc(message)}${ANSI.reset}\n`);
  }

  /** Renders a system/info message in gray italic. */
  renderSystemMessage(text: string): void {
    this.writer.write(`${ANSI.gray}${ANSI.italic}${text}${ANSI.reset}\n`);
  }

  /** Renders a dim horizontal separator line between conversation turns. */
  renderTurnSeparator(): void {
    this.writer.write(`${ANSI.dim}${TURN_SEPARATOR}${ANSI.reset}\n`);
  }

  /** Renders the prompt prefix "> " without a newline. */
  renderPromptPrefix(): void {
    this.writer.write("> ");
  }

  /** Clears the current terminal line using ANSI escape. */
  clearLine(): void {
    this.writer.write(ANSI.clearLine);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private _statusStyle(status: TuiStatus): { text: string; color: string } {
    switch (status) {
      case "connecting":
        return { text: "[Conectando...]", color: ANSI.yellow };
      case "idle":
        return { text: "[Listo]", color: ANSI.green };
      case "thinking":
        return { text: "[Pensando...]", color: `${ANSI.blue}${ANSI.bold}` };
      case "waiting_permission":
        return { text: "[Esperando permiso]", color: `${ANSI.red}${ANSI.bold}` };
      case "error":
        return { text: "[Error]", color: ANSI.red };
    }
  }
}
