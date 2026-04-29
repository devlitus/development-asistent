/**
 * Tests for TuiInput — TUI-05
 *
 * Strategy:
 *   1. `parseInputLine` — pure function, tested in full isolation (no I/O)
 *   2. `TuiInput.processLine` — public dispatch method, no readline needed
 *      (readline is lazy; only created in start())
 *   3. `TuiInput.askPermission` — tested via `_mockQuestionAnswer` bypass
 *   4. Lifecycle methods (pause/resume/close) — safe to call without readline
 *
 * Uses bun:test (Jest-compatible syntax).
 */

import { describe, it, expect, mock } from "bun:test";
import { parseInputLine, TuiInput } from "../tui/input.ts";
import { TuiState } from "../tui/state.ts";
import { TuiRenderer } from "../tui/renderer.ts";
import type { PermissionRequest } from "../tui/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a TuiInput with a mock renderer writer. No readline is created. */
function makeTestInput() {
  const chunks: string[] = [];
  const writer = { write: (s: string) => { chunks.push(s); } };
  const renderer = new TuiRenderer(writer);
  const state = new TuiState();
  // No options → readline is lazy, never created unless start() is called
  const input = new TuiInput(renderer, state);
  return { input, renderer, state, output: () => chunks.join("") };
}

// ─── parseInputLine ───────────────────────────────────────────────────────────

describe("parseInputLine", () => {
  // Empty lines
  it("should return { type: 'empty' } for empty string", () => {
    expect(parseInputLine("")).toEqual({ type: "empty" });
  });

  it("should return { type: 'empty' } for whitespace-only string", () => {
    expect(parseInputLine("   ")).toEqual({ type: "empty" });
  });

  // /quit command
  it("should return { type: 'command', command: 'quit' } for '/quit'", () => {
    expect(parseInputLine("/quit")).toEqual({ type: "command", command: "quit" });
  });

  it("should be case-insensitive: '/QUIT' → quit command", () => {
    expect(parseInputLine("/QUIT")).toEqual({ type: "command", command: "quit" });
  });

  it("should be case-insensitive: '/Quit' → quit command", () => {
    expect(parseInputLine("/Quit")).toEqual({ type: "command", command: "quit" });
  });

  // /exit command (alias for quit)
  it("should return { type: 'command', command: 'quit' } for '/exit'", () => {
    expect(parseInputLine("/exit")).toEqual({ type: "command", command: "quit" });
  });

  it("should be case-insensitive: '/EXIT' → quit command", () => {
    expect(parseInputLine("/EXIT")).toEqual({ type: "command", command: "quit" });
  });

  // /clear command
  it("should return { type: 'command', command: 'clear' } for '/clear'", () => {
    expect(parseInputLine("/clear")).toEqual({ type: "command", command: "clear" });
  });

  it("should be case-insensitive: '/CLEAR' → clear command", () => {
    expect(parseInputLine("/CLEAR")).toEqual({ type: "command", command: "clear" });
  });

  // /new command
  it("should return { type: 'command', command: 'new-session' } for '/new'", () => {
    expect(parseInputLine("/new")).toEqual({ type: "command", command: "new-session" });
  });

  it("should be case-insensitive: '/NEW' → new-session command", () => {
    expect(parseInputLine("/NEW")).toEqual({ type: "command", command: "new-session" });
  });

  // /help command
  it("should return { type: 'command', command: 'help' } for '/help'", () => {
    expect(parseInputLine("/help")).toEqual({ type: "command", command: "help" });
  });

  it("should be case-insensitive: '/HELP' → help command", () => {
    expect(parseInputLine("/HELP")).toEqual({ type: "command", command: "help" });
  });

  // Normal prompt text
  it("should return { type: 'prompt', text: 'hola mundo' } for normal text", () => {
    expect(parseInputLine("hola mundo")).toEqual({ type: "prompt", text: "hola mundo" });
  });

  it("should return { type: 'prompt', text: 'hello' } for 'hello'", () => {
    expect(parseInputLine("hello")).toEqual({ type: "prompt", text: "hello" });
  });

  it("should trim leading/trailing whitespace from prompt text", () => {
    expect(parseInputLine("  hello world  ")).toEqual({ type: "prompt", text: "hello world" });
  });

  // Unknown commands treated as prompt
  it("should return prompt for unknown commands like '/unknown'", () => {
    expect(parseInputLine("/unknown")).toEqual({ type: "prompt", text: "/unknown" });
  });
});

// ─── TuiInput handler registration ───────────────────────────────────────────

describe("TuiInput handler registration", () => {
  it("should register onPrompt handler without throwing", () => {
    const { input } = makeTestInput();
    expect(() => input.onPrompt(() => {})).not.toThrow();
  });

  it("should register onCommand handler without throwing", () => {
    const { input } = makeTestInput();
    expect(() => input.onCommand(() => {})).not.toThrow();
  });

  it("should register onQuit handler without throwing", () => {
    const { input } = makeTestInput();
    expect(() => input.onQuit(() => {})).not.toThrow();
  });
});

// ─── TuiInput.processLine (internal line dispatch) ────────────────────────────

describe("TuiInput.processLine", () => {
  it("empty line → does NOT fire onPrompt", () => {
    const { input } = makeTestInput();
    const handler = mock(() => {});
    input.onPrompt(handler);
    input.processLine("");
    expect(handler).not.toHaveBeenCalled();
  });

  it("whitespace-only line → does NOT fire onPrompt", () => {
    const { input } = makeTestInput();
    const handler = mock(() => {});
    input.onPrompt(handler);
    input.processLine("   ");
    expect(handler).not.toHaveBeenCalled();
  });

  it("normal text → fires onPrompt with the text", () => {
    const { input } = makeTestInput();
    const handler = mock((_text: string) => {});
    input.onPrompt(handler);
    input.processLine("hola mundo");
    expect(handler).toHaveBeenCalledWith("hola mundo");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("normal text → does NOT fire onQuit", () => {
    const { input } = makeTestInput();
    const quitHandler = mock(() => {});
    input.onQuit(quitHandler);
    input.processLine("hola mundo");
    expect(quitHandler).not.toHaveBeenCalled();
  });

  it("/quit → fires onQuit (not onPrompt)", () => {
    const { input } = makeTestInput();
    const promptHandler = mock((_text: string) => {});
    const quitHandler = mock(() => {});
    input.onPrompt(promptHandler);
    input.onQuit(quitHandler);
    input.processLine("/quit");
    expect(quitHandler).toHaveBeenCalledTimes(1);
    expect(promptHandler).not.toHaveBeenCalled();
  });

  it("/QUIT (uppercase) → fires onQuit", () => {
    const { input } = makeTestInput();
    const quitHandler = mock(() => {});
    input.onQuit(quitHandler);
    input.processLine("/QUIT");
    expect(quitHandler).toHaveBeenCalledTimes(1);
  });

  it("/exit → fires onQuit (not onPrompt)", () => {
    const { input } = makeTestInput();
    const promptHandler = mock((_text: string) => {});
    const quitHandler = mock(() => {});
    input.onPrompt(promptHandler);
    input.onQuit(quitHandler);
    input.processLine("/exit");
    expect(quitHandler).toHaveBeenCalledTimes(1);
    expect(promptHandler).not.toHaveBeenCalled();
  });

  it("/clear → fires onCommand('clear') (not onPrompt)", () => {
    const { input } = makeTestInput();
    const promptHandler = mock((_text: string) => {});
    const commandHandler = mock((_cmd: string) => {});
    input.onPrompt(promptHandler);
    input.onCommand(commandHandler);
    input.processLine("/clear");
    expect(commandHandler).toHaveBeenCalledWith("clear");
    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(promptHandler).not.toHaveBeenCalled();
  });

  it("/new → fires onCommand('new-session') (not onPrompt)", () => {
    const { input } = makeTestInput();
    const promptHandler = mock((_text: string) => {});
    const commandHandler = mock((_cmd: string) => {});
    input.onPrompt(promptHandler);
    input.onCommand(commandHandler);
    input.processLine("/new");
    expect(commandHandler).toHaveBeenCalledWith("new-session");
    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(promptHandler).not.toHaveBeenCalled();
  });

  it("/help → fires onCommand('help') and writes to renderer (not onPrompt)", () => {
    const { input, output } = makeTestInput();
    const promptHandler = mock((_text: string) => {});
    const commandHandler = mock((_cmd: string) => {});
    input.onPrompt(promptHandler);
    input.onCommand(commandHandler);
    input.processLine("/help");
    expect(commandHandler).toHaveBeenCalledWith("help");
    expect(promptHandler).not.toHaveBeenCalled();
    // renderer should have written something (help text)
    expect(output().length).toBeGreaterThan(0);
  });

  it("multiple onPrompt handlers all get called", () => {
    const { input } = makeTestInput();
    const h1 = mock((_text: string) => {});
    const h2 = mock((_text: string) => {});
    input.onPrompt(h1);
    input.onPrompt(h2);
    input.processLine("test");
    expect(h1).toHaveBeenCalledWith("test");
    expect(h2).toHaveBeenCalledWith("test");
  });

  it("multiple onQuit handlers all get called", () => {
    const { input } = makeTestInput();
    const h1 = mock(() => {});
    const h2 = mock(() => {});
    input.onQuit(h1);
    input.onQuit(h2);
    input.processLine("/quit");
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });
});

// ─── TuiInput.askPermission ───────────────────────────────────────────────────

describe("TuiInput.askPermission", () => {
  const req: PermissionRequest = {
    sessionId: "sess-1",
    toolName: "bash",
    description: "Ejecutar: ls -la /home/user",
    input: { command: "ls -la /home/user" },
  };

  function makePermissionTestInput(answer: string) {
    const { input } = makeTestInput();
    input._mockQuestionAnswer = answer;
    return { input };
  }

  it("'y' → returns true", async () => {
    const { input } = makePermissionTestInput("y");
    const result = await input.askPermission(req);
    expect(result).toBe(true);
  });

  it("'Y' → returns true", async () => {
    const { input } = makePermissionTestInput("Y");
    const result = await input.askPermission(req);
    expect(result).toBe(true);
  });

  it("'yes' → returns true", async () => {
    const { input } = makePermissionTestInput("yes");
    const result = await input.askPermission(req);
    expect(result).toBe(true);
  });

  it("'YES' → returns true", async () => {
    const { input } = makePermissionTestInput("YES");
    const result = await input.askPermission(req);
    expect(result).toBe(true);
  });

  it("'n' → returns false", async () => {
    const { input } = makePermissionTestInput("n");
    const result = await input.askPermission(req);
    expect(result).toBe(false);
  });

  it("'N' → returns false", async () => {
    const { input } = makePermissionTestInput("N");
    const result = await input.askPermission(req);
    expect(result).toBe(false);
  });

  it("'no' → returns false", async () => {
    const { input } = makePermissionTestInput("no");
    const result = await input.askPermission(req);
    expect(result).toBe(false);
  });

  it("'' (empty, default n) → returns false", async () => {
    const { input } = makePermissionTestInput("");
    const result = await input.askPermission(req);
    expect(result).toBe(false);
  });

  it("'maybe' (unknown) → returns false (default deny)", async () => {
    const { input } = makePermissionTestInput("maybe");
    const result = await input.askPermission(req);
    expect(result).toBe(false);
  });
});

// ─── TuiInput lifecycle methods ───────────────────────────────────────────────

describe("TuiInput lifecycle methods", () => {
  it("pause() should not throw (no readline active)", () => {
    const { input } = makeTestInput();
    expect(() => input.pause()).not.toThrow();
  });

  it("resume() should not throw (no readline active)", () => {
    const { input } = makeTestInput();
    expect(() => input.resume()).not.toThrow();
  });

  it("close() should not throw (no readline active)", () => {
    const { input } = makeTestInput();
    expect(() => input.close()).not.toThrow();
  });

  it("pause() then resume() should not throw", () => {
    const { input } = makeTestInput();
    expect(() => {
      input.pause();
      input.resume();
    }).not.toThrow();
  });
});
