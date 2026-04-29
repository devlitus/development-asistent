/**
 * TuiInput — TUI-05
 *
 * Manages user input via readline. Handles:
 *   - Special commands: /quit, /exit, /clear, /new, /help
 *   - Normal prompt text dispatch
 *   - Permission flow via askPermission()
 *   - Ctrl+C double-press to quit
 *
 * The `parseInputLine` function is exported as a pure function for easy testing.
 *
 * Design note: readline is created lazily in `start()` to avoid keeping the
 * event loop alive during tests. `processLine` and `askPermission` work
 * independently of readline when `_mockQuestionAnswer` is set.
 */

import * as readline from "readline";
import { Readable, Writable } from "stream";
import type { PermissionRequest } from "./types.ts";
import type { TuiState } from "./state.ts";
import { TuiRenderer } from "./renderer.ts";

// ─── parseInputLine ───────────────────────────────────────────────────────────

/** Result of parsing a single input line. */
export type ParsedLine =
  | { type: "command"; command: string }
  | { type: "prompt"; text: string }
  | { type: "empty" };

/**
 * Pure function: parses a raw input line into a structured result.
 *
 * Rules:
 *   - Empty / whitespace-only → { type: "empty" }
 *   - /quit, /exit → { type: "command", command: "quit" }
 *   - /clear       → { type: "command", command: "clear" }
 *   - /new         → { type: "command", command: "new-session" }
 *   - /help        → { type: "command", command: "help" }
 *   - Unknown /cmd → { type: "prompt", text: line }
 *   - Normal text  → { type: "prompt", text: trimmed }
 */
export function parseInputLine(line: string): ParsedLine {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return { type: "empty" };
  }

  const lower = trimmed.toLowerCase();

  switch (lower) {
    case "/quit":
    case "/exit":
      return { type: "command", command: "quit" };
    case "/clear":
      return { type: "command", command: "clear" };
    case "/new":
      return { type: "command", command: "new-session" };
    case "/help":
      return { type: "command", command: "help" };
    case "/status":
      return { type: "command", command: "status" };
    default:
      return { type: "prompt", text: trimmed };
  }
}

// ─── TuiInput ─────────────────────────────────────────────────────────────────

const HELP_TEXT = `
Comandos disponibles:
  /help   — muestra esta ayuda
  /status — muestra el estado de la sesión actual
  /clear  — limpia la pantalla
  /new    — inicia una nueva sesión
  /quit   — sale del programa
  /exit   — alias de /quit
`;

/** Options for constructing a TuiInput — allows stream injection for testing. */
export interface TuiInputOptions {
  /** Override readline input stream (for testing). Defaults to process.stdin. */
  input?: Readable;
  /** Override readline output stream (for testing). Defaults to process.stdout. */
  output?: Writable;
  /** If true, disables terminal mode (useful for tests). Defaults to false. */
  terminal?: boolean;
}

export class TuiInput {
  /** Readline interface — created lazily in start() or close(). */
  private rl: readline.Interface | null = null;

  private readonly promptHandlers: Array<(text: string) => void> = [];
  private readonly commandHandlers: Array<(cmd: string) => void> = [];
  private readonly quitHandlers: Array<() => void> = [];

  /** Stored reference to the SIGINT handler so it can be removed on close. */
  #sigintHandler: (() => void) | null = null;

  /**
   * For testing only: if set, `askPermission` uses this value instead of
   * calling `rl.question()` on a real terminal.
   * @internal
   */
  _mockQuestionAnswer: string | undefined = undefined;

  constructor(
    private readonly renderer: TuiRenderer,
    private readonly _state: TuiState,
    private readonly options?: TuiInputOptions,
  ) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Starts the readline event loop. */
  start(): void {
    // Remove any previous SIGINT handler to avoid duplicates
    if (this.#sigintHandler) {
      process.removeListener("SIGINT", this.#sigintHandler);
      this.#sigintHandler = null;
    }

    this.rl = this._createReadline();
    this.rl.prompt();

    this.rl.on("line", (line: string) => {
      this.processLine(line);
      this.rl?.prompt();
    });

    let ctrlCCount = 0;
    const sigintHandler = () => {
      ctrlCCount++;
      if (ctrlCCount === 1) {
        process.stdout.write("\n(Usa /quit para salir)\n");
        this.rl?.prompt();
        setTimeout(() => {
          ctrlCCount = 0;
        }, 3000);
      } else {
        this.quitHandlers.forEach((h) => h());
      }
    };
    this.#sigintHandler = sigintHandler;
    process.on("SIGINT", sigintHandler);
  }

  /** Pauses readline input (e.g., during streaming or permission flow). */
  pause(): void {
    this.rl?.pause();
  }

  /** Resumes readline input and re-renders the prompt. */
  resume(): void {
    this.rl?.resume();
    this.rl?.prompt();
  }

  /**
   * Asks the user to approve or deny a permission request.
   * Returns `true` for y/yes, `false` for n/no/empty/unknown.
   */
  async askPermission(req: PermissionRequest): Promise<boolean> {
    this.renderer.renderPermissionRequest(req);

    // Testing hook: bypass real readline.question
    if (this._mockQuestionAnswer !== undefined) {
      return this._resolvePermissionAnswer(this._mockQuestionAnswer);
    }

    // Ensure readline is available for question
    if (!this.rl) {
      this.rl = this._createReadline();
    }

    return new Promise<boolean>((resolve) => {
      this.rl!.question("¿Aprobar? [Y/n]: ", (answer: string) => {
        resolve(this._resolvePermissionAnswer(answer));
      });
    });
  }

  /** Closes the readline interface cleanly. */
  close(): void {
    if (this.#sigintHandler) {
      process.removeListener("SIGINT", this.#sigintHandler);
      this.#sigintHandler = null;
    }
    this.rl?.close();
    this.rl = null;
  }

  // ─── Handler registration ────────────────────────────────────────────────────

  /** Register a handler called when the user types a normal prompt. */
  onPrompt(handler: (text: string) => void): void {
    this.promptHandlers.push(handler);
  }

  /** Register a handler called when the user types a special command. */
  onCommand(handler: (cmd: string) => void): void {
    this.commandHandlers.push(handler);
  }

  /** Register a handler called when the user requests to quit. */
  onQuit(handler: () => void): void {
    this.quitHandlers.push(handler);
  }

  // ─── Internal line dispatch ──────────────────────────────────────────────────

  /**
   * Processes a single input line and dispatches to the appropriate handlers.
   * Exposed as a public method to allow unit testing without real I/O.
   */
  processLine(line: string): void {
    const parsed = parseInputLine(line);

    switch (parsed.type) {
      case "empty":
        // Ignore empty lines
        break;

      case "command":
        this._handleCommand(parsed.command);
        break;

      case "prompt":
        this.promptHandlers.forEach((h) => h(parsed.text));
        break;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _createReadline(): readline.Interface {
    const opts = this.options ?? {};
    return readline.createInterface({
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout,
      terminal: opts.terminal ?? true,
      prompt: "❯ ",
    });
  }

  private _handleCommand(command: string): void {
    switch (command) {
      case "quit":
        this.quitHandlers.forEach((h) => h());
        break;

      case "help":
        this.renderer.renderSystemMessage(HELP_TEXT);
        this.commandHandlers.forEach((h) => h("help"));
        break;

      case "clear":
      case "new-session":
      case "status":
        this.commandHandlers.forEach((h) => h(command));
        break;
    }
  }

  private _resolvePermissionAnswer(answer: string): boolean {
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  }
}
