/**
 * tui-client.ts — TUI-06
 *
 * Punto de entrada del TUI interactivo.
 *
 * Integra todas las piezas del TUI:
 *   - AgentProcess  (spawn del servidor ACP)
 *   - AcpClient     (protocolo JSON-RPC)
 *   - TuiState      (estado mutable)
 *   - TuiRenderer   (salida ANSI)
 *   - TuiInput      (readline + comandos)
 *
 * Exporta `createTuiOrchestrator(deps)` para testing con dependencias inyectadas.
 * La función `main()` crea las dependencias reales y llama a esta función.
 */

import { AgentProcess, LLM_ENV_VARS } from "./tui/agent-process.ts";
import { AcpClient } from "./tui/acp-client.ts";
import { TuiState } from "./tui/state.ts";
import { TuiRenderer } from "./tui/renderer.ts";
import { TuiInput } from "./tui/input.ts";
import type { TuiStatus, TuiMessage, PermissionRequest, SessionUpdatePayload } from "./tui/types.ts";

// ─── Dependency interfaces (for injection / testing) ─────────────────────────

/** Minimal interface of AcpClient used by the orchestrator. */
export interface IAcpClient {
  initialize(): Promise<{ protocolVersion: number; serverInfo: unknown }>;
  newSession(cwd: string): Promise<string>;
  sendPrompt(sessionId: string, text: string): Promise<void>;
  onUpdate(handler: (payload: SessionUpdatePayload) => void): void;
  onPermissionRequest(handler: (req: PermissionRequest) => void): void;
  sendPermissionResponse(sessionId: string, approved: boolean): void;
}

/** Minimal interface of AgentProcess used by the orchestrator. */
export interface IAgentProcess {
  spawn(): void;
  kill(): void;
  onExit(handler: (code: number | null) => void): void;
}

/** Minimal interface of TuiRenderer used by the orchestrator. */
export interface IRenderer {
  renderHeader(version: string): void;
  renderStatusBar(status: TuiStatus): void;
  renderUserMessage(text: string): void;
  renderAgentMessageStart(): void;
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
}

/** Minimal interface of TuiInput used by the orchestrator. */
export interface IInput {
  start(): void;
  pause(): void;
  resume(): void;
  close(): void;
  askPermission(req: PermissionRequest): Promise<boolean>;
  onPrompt(handler: (text: string) => void): void;
  onCommand(handler: (cmd: string) => void): void;
  onQuit(handler: () => void): void;
}

/** Minimal interface of TuiState used by the orchestrator. */
export interface IState {
  readonly messageCount: number;
  setStatus(s: TuiStatus): void;
  addMessage(m: TuiMessage): void;
  appendStream(text: string): void;
  flushStream(): void;
  setPendingPermission(req: PermissionRequest): void;
  clearPendingPermission(): void;
}

// ─── TuiOrchestratorDeps ─────────────────────────────────────────────────────

/** All dependencies for the TUI orchestrator — injectable for testing. */
export interface TuiOrchestratorDeps {
  acpClient: IAcpClient;
  agentProcess: IAgentProcess;
  renderer: IRenderer;
  input: IInput;
  state: IState;
  version: string;
  cwd: string;
  /** Active LLM provider name — shown as system message at startup. */
  provider?: string;
  /** Override process.exit for testing. Defaults to process.exit. */
  exit?: (code: number) => never | void;
  /**
   * Environment variables for health checks.
   * Defaults to process.env. Override in tests.
   */
  env?: Record<string, string | undefined>;
}

// ─── Marker constants ─────────────────────────────────────────────────────────

const ROUTING_MARKER     = "\x00ROUTING\x00";
const TOOL_CALL_MARKER   = "\x00TOOL_CALL\x00";
const TOOL_RESULT_MARKER = "\x00TOOL_RESULT\x00";

// ─── TuiOrchestrator ─────────────────────────────────────────────────────────

export interface TuiOrchestrator {
  /** Runs the full lifecycle: handshake → input loop. */
  start(): Promise<void>;
}

/**
 * Creates a TUI orchestrator with the given dependencies.
 * This is the main factory used both in production (via `main()`) and in tests.
 */
export function createTuiOrchestrator(deps: TuiOrchestratorDeps): TuiOrchestrator {
  const { acpClient, agentProcess, renderer, input, state, version, cwd } = deps;
  const provider = deps.provider;
  const doExit = deps.exit ?? ((code: number) => process.exit(code));
  const env = deps.env ?? process.env;

  // Current ACP session id — set after newSession()
  let sessionId = "";

  // Tracks whether we've started rendering the current agent message
  let agentMessageStarted = false;

  // ── Shutdown ────────────────────────────────────────────────────────────────

  function shutdown(): void {
    input.close();
    agentProcess.kill();
    renderer.renderSystemMessage("¡Hasta luego!");
    doExit(0);
  }

  // ── Handle a user prompt ────────────────────────────────────────────────────

  async function handlePrompt(text: string): Promise<void> {
    state.setStatus("thinking");
    input.pause();
    renderer.renderUserMessage(text);
    state.addMessage({ role: "user", content: text, timestamp: Date.now() });

    // Reset streaming flag for this new prompt
    agentMessageStarted = false;

    renderer.renderStatusBar("thinking");
    renderer.startSpinner();

    try {
      await acpClient.sendPrompt(sessionId, text);
    } catch (err) {
      renderer.renderError(String(err));
    } finally {
      renderer.stopSpinner();
      // Only close the message line if it was actually started (NEW-L1)
      if (agentMessageStarted) {
        renderer.renderAgentMessageEnd();
      }
      state.flushStream();
      state.setStatus("idle");
      renderer.renderStatusBar("idle");
      renderer.renderTurnSeparator();
      input.resume();
    }
  }

  // ── Handle a command ────────────────────────────────────────────────────────

  async function handleCommand(cmd: string): Promise<void> {
    switch (cmd) {
      case "quit":
        shutdown();
        break;

      case "clear":
        // Clear screen and re-render header
        process.stdout.write("\x1b[2J\x1b[H");
        renderer.renderHeader(version);
        renderer.renderStatusBar("idle");
        break;

      case "new-session":
        try {
          sessionId = await acpClient.newSession(cwd);
          renderer.renderSystemMessage(`Nueva sesión iniciada: ${sessionId}`);
        } catch (err) {
          renderer.renderError(`No se pudo crear nueva sesión: ${err}`);
        }
        break;

      case "status": {
        const shortId = sessionId ? sessionId.slice(0, 8) : null;
        const msgCount = state.messageCount;
        const sessionLine = shortId
          ? `Sesión: ${shortId} · ${msgCount} mensaje${msgCount !== 1 ? "s" : ""}`
          : "Sin sesión activa";
        const providerLine = provider ? `Provider: ${provider}` : "Provider: desconocido";
        renderer.renderSystemMessage(`${sessionLine}\n${providerLine}`);
        break;
      }
    }
  }

  // ── Register ACP update handler ─────────────────────────────────────────────

  acpClient.onUpdate((payload: SessionUpdatePayload) => {
    if (payload.update.sessionUpdate === "agent_message_chunk") {
      const text = payload.update.content.text;

      // 1. Tool call marker
      if (text.startsWith(TOOL_CALL_MARKER)) {
        const toolName = text.slice(TOOL_CALL_MARKER.length);
        renderer.renderToolCall(toolName, {});
        return;
      }

      // 2. Tool result marker
      if (text.startsWith(TOOL_RESULT_MARKER)) {
        const rest = text.slice(TOOL_RESULT_MARKER.length);
        const sepIdx = rest.lastIndexOf("\x00");
        const toolName = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
        const status   = sepIdx >= 0 ? rest.slice(sepIdx + 1) : "completed";
        renderer.renderToolResult(toolName, status);
        return;
      }

      // 3. Routing marker
      if (text.startsWith(ROUTING_MARKER)) {
        const agentName = text.slice(ROUTING_MARKER.length);
        renderer.renderRoutingInfo(agentName);
        return;
      }

      // 4. Normal text
      if (!agentMessageStarted) {
        renderer.renderAgentMessageStart();
        agentMessageStarted = true;
      }
      renderer.renderStreamChunk(text);
      state.appendStream(text);
    }
  });

  // ── Register ACP permission handler ────────────────────────────────────────

  acpClient.onPermissionRequest(async (req: PermissionRequest) => {
    renderer.stopSpinner();
    state.setStatus("waiting_permission");
    renderer.renderStatusBar("waiting_permission");
    state.setPendingPermission(req);

    const approved = await input.askPermission(req);
    acpClient.sendPermissionResponse(req.sessionId, approved);

    state.clearPendingPermission();
    state.setStatus("thinking");
    renderer.startSpinner();
  });

  // ── Register agent exit handler ─────────────────────────────────────────────

  agentProcess.onExit((code: number | null) => {
    renderer.stopSpinner();
    renderer.renderError(
      `El agente terminó inesperadamente (código: ${code ?? "null"})`,
    );
    // Ensure we clean up any pending prompt state before exiting
    state.setStatus("error");
    renderer.renderStatusBar("error");
    agentMessageStarted = false;
    input.resume();
    doExit(1);
  });

  // ── Register input handlers ─────────────────────────────────────────────────

  input.onPrompt((text: string) => {
    handlePrompt(text).catch((err) => {
      renderer.renderError(String(err));
    });
  });

  input.onCommand((cmd: string) => {
    handleCommand(cmd).catch((err) => {
      renderer.renderError(String(err));
    });
  });

  input.onQuit(() => {
    shutdown();
  });

  // ── Health checks (soft — never block startup) ──────────────────────────────

  async function runHealthChecks(): Promise<void> {
    // ── Check 1: Docs agent web search keys ────────────────────────────────────
    const hasBrave  = Boolean(env["BRAVE_API_KEY"]);
    const hasTavily = Boolean(env["TAVILY_API_KEY"]);

    if (hasBrave || hasTavily) {
      renderer.renderSystemMessage("✓ Docs agent: búsqueda web disponible");
    } else {
      renderer.renderSystemMessage(
        "⚠ Docs agent: sin API de búsqueda web (BRAVE_API_KEY / TAVILY_API_KEY no configuradas)"
      );
    }

    // ── Check 2: LLM provider ping ──────────────────────────────────────────────
    try {
      const pingPromise = acpClient.sendPrompt(sessionId, "__health_check__");
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("timeout")), 10_000);
      });
      try {
        await Promise.race([pingPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutHandle);
      }
      renderer.renderSystemMessage(`✓ Provider OK`);
    } catch (err) {
      const isTimeout = String(err).includes("timeout");
      renderer.renderSystemMessage(
        isTimeout
          ? "⚠ Provider no responde (timeout 10s)"
          : `⚠ Provider error: ${String(err)}`
      );
    }
  }

  // ── start() ─────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    // 1. Spawn the agent process
    agentProcess.spawn();

    // 2. Handshake: initialize + newSession
    await acpClient.initialize();
    sessionId = await acpClient.newSession(cwd);

    // 3. Render header and initial status
    renderer.renderHeader(version);
    renderer.renderStatusBar("idle");
    state.setStatus("idle");

    // 3b. Show provider and hint
    if (provider) renderer.renderSystemMessage(`Provider: ${provider}`);

    // 3c. Run health checks (soft — errors are caught internally)
    await runHealthChecks();

    renderer.renderSystemMessage("Escribe tu mensaje o /help para ver comandos");

    // 4. Start the input loop
    input.start();
  }

  return { start };
}

// ─── main() ──────────────────────────────────────────────────────────────────

/**
 * Entry point: creates real dependencies and starts the TUI.
 *
 * Bun loads .env automatically — no dotenv needed.
 */
async function main(): Promise<void> {
  // Verify at least one LLM provider is configured
  const hasProvider = LLM_ENV_VARS.some((key) => Boolean(process.env[key]));
  if (!hasProvider) {
    process.stderr.write(
      "[tui] Error: No LLM provider configured.\n" +
        "Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, LM_STUDIO_HOST, LLAMACPP_HOST, OLLAMA_HOST\n",
    );
    process.exit(1);
  }

  // Read package version
  let version = "0.1.0";
  try {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json() as Record<string, unknown>;
    if (typeof pkg["version"] === "string") version = pkg["version"] as string;
  } catch (err) {
    process.stderr.write(`[tui] Warning: no se pudo leer package.json: ${err}\n`);
  }

  // Detect active LLM provider
  function sanitizeHostUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function detectProvider(): string {
    if (process.env["ANTHROPIC_API_KEY"]) return "Anthropic";
    if (process.env["OPENAI_API_KEY"]) return "OpenAI";
    if (process.env["LM_STUDIO_HOST"]) return `LM Studio (${sanitizeHostUrl(process.env["LM_STUDIO_HOST"])})`;
    if (process.env["LLAMACPP_HOST"]) return `llama.cpp (${sanitizeHostUrl(process.env["LLAMACPP_HOST"])})`;
    if (process.env["OLLAMA_HOST"]) return `Ollama (${sanitizeHostUrl(process.env["OLLAMA_HOST"])})`;
    return "desconocido";
  }

  // Create real dependencies
  const agentProcess = new AgentProcess();
  const acpClient = new AcpClient(agentProcess);
  const state = new TuiState();
  const renderer = new TuiRenderer();
  const input = new TuiInput(renderer, state);

  const orchestrator = createTuiOrchestrator({
    acpClient,
    agentProcess,
    renderer,
    input,
    state,
    version,
    cwd: process.cwd(),
    provider: detectProvider(),
  });

  await orchestrator.start();
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// Only run main() when this file is executed directly (not imported in tests).
// Bun sets import.meta.main = true when the file is the entry point.
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[tui] Fatal: ${err}\n`);
    process.exit(1);
  });
}
