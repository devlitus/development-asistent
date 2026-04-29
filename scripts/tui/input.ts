/**
 * input.ts — TUI-05 (parseInputLine)
 *
 * Exporta `parseInputLine`, función pura para parsear líneas de input del usuario.
 * La clase TuiInput (readline) fue eliminada en INK-06; el input ahora lo gestiona
 * InkInput vía Ink/React (ink-input.ts).
 */

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
    case "/sessions":
      return { type: "command", command: "sessions" };
    default: {
      // /resume <id> — el ID va en minúsculas concatenado con ":"
      if (lower.startsWith("/resume ")) {
        const id = lower.slice("/resume ".length).trim();
        if (id.length > 0) {
          return { type: "command", command: `resume:${id}` };
        }
      }
      return { type: "prompt", text: trimmed };
    }
  }
}
