/**
 * tui-client.tsx — INK-06
 *
 * Punto de entrada del TUI interactivo con Ink/React.
 *
 * Integra todas las piezas del TUI:
 *   - AgentProcess  (spawn del servidor ACP)
 *   - AcpClient     (protocolo JSON-RPC)
 *   - TuiState      (estado mutable)
 *   - InkRenderer   (salida Ink/React)
 *   - InkInput      (input vía useInput de Ink)
 *
 * Exporta `createTuiOrchestrator(deps)` para testing con dependencias inyectadas.
 * La función `main()` crea las dependencias reales y llama a esta función.
 */

import { render } from "ink";
import { Database } from "bun:sqlite";
import { AgentProcess, LLM_ENV_VARS } from "./tui/agent-process.ts";
import { AcpClient } from "./tui/acp-client.ts";
import { TuiState } from "./tui/state.ts";
import { TuiApp } from "./tui/ink-renderer.tsx";
import type { SetAppState } from "./tui/ink-renderer.tsx";
import { InkRenderer } from "./tui/ink-renderer.tsx";
import { InkInput } from "./tui/ink-input.ts";
import type { TuiStatus, TuiMessage, PermissionRequest, SessionUpdatePayload } from "./tui/types.ts";
import type { IRenderer } from "./tui/interfaces.ts";
export type { IRenderer } from "./tui/interfaces.ts";
import { loadConfig } from "../src/config/loader.ts";
import type { Config, AgentConfig } from "../src/config/schema.ts";
import { getDbPath } from "../src/persistence/db-path.ts";

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
  /** Desplaza el scroll de la conversación una línea hacia arriba. */
  handleArrowUp?(): void;
  /** Desplaza el scroll de la conversación una línea hacia abajo. */
  handleArrowDown?(): void;
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
const STATUS_MARKER      = "\x00STATUS\x00";
const ERR_MARKER         = "\x00ERR\x00";

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

  // Tracks the last routed agent name for message prefix
  let lastRoutedAgent = "Agent";

  // A5: stored sigint handler reference so shutdown() can remove it
  let sigintHandler: (() => void) | null = null;

  // ── Shutdown ────────────────────────────────────────────────────────────────

  function shutdown(): void {
    // A5: clean up SIGINT listener to avoid leaks in tests
    if (sigintHandler) {
      process.off("SIGINT", sigintHandler);
      sigintHandler = null;
    }
    input.close();
    agentProcess.kill();
    renderer.renderSystemMessage("¡Hasta luego!");
    doExit(0);
  }

  // ── Handle a user prompt ────────────────────────────────────────────────────

  async function handlePrompt(text: string): Promise<void> {
    // C3: guardia — no enviar si no hay sesión activa
    if (!sessionId) {
      renderer.renderError("Sin sesión activa. Usa /new para crear una.");
      return;
    }
    renderer.resetScroll(); // Volver al final cuando el usuario envía
    state.setStatus("thinking");
    input.pause();
    renderer.renderUserMessage(text);
    state.addMessage({ role: "user", content: text, timestamp: Date.now() });

    // Reset streaming flag for this new prompt
    agentMessageStarted = false;
    lastRoutedAgent = "Agent";

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

  // ── handleSessionsList ──────────────────────────────────────────────────────

  async function handleSessionsList(): Promise<void> {
    try {
      const dbPath = getDbPath();
      const db = new Database(dbPath, { readonly: true });
      const rows = db.query<{
        id: string;
        created_at: number;
        msg_count: number;
        first_user_msg: string | null;
      }, []>(`
        SELECT s.id, s.created_at, COUNT(m.id) as msg_count,
               MIN(CASE WHEN m.role='user' THEN m.content END) as first_user_msg
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 10
      `).all();
      db.close();

      if (rows.length === 0) {
        renderer.renderSystemMessage("No hay sesiones anteriores.");
        return;
      }

      const lines = rows.map((r) => {
        const shortId = r.id.slice(0, 8);
        const date = new Date(r.created_at).toLocaleDateString("es-ES", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });
        // Sanitizar escape codes ANSI del preview para evitar corrupción del TUI
        const rawPreview = r.first_user_msg
          ? r.first_user_msg.slice(0, 60) + (r.first_user_msg.length > 60 ? "…" : "")
          : "(sin mensajes)";
        // eslint-disable-next-line no-control-regex
        const preview = rawPreview.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
        return `  ${shortId}  ${date}  [${r.msg_count} msgs]  ${preview}`;
      });

      renderer.renderSystemMessage(
        `Sesiones recientes:\n${lines.join("\n")}\n\nUsa /resume <id> para reanudar`
      );
    } catch (err) {
      renderer.renderSystemMessage(`No se pudo leer el historial: ${err}`);
    }
  }

  // ── handleSessionResume ─────────────────────────────────────────────────────

  async function handleSessionResume(shortId: string): Promise<void> {
    // Validar que shortId sea un prefijo hex UUID (solo [0-9a-f-])
    if (!/^[0-9a-f-]{1,36}$/i.test(shortId)) {
      renderer.renderSystemMessage(
        `ID inválido: '${shortId}'. Usa el ID corto de /sessions (ej: 84c3ffe2).`
      );
      return;
    }

    try {
      const dbPath = getDbPath();
      const db = new Database(dbPath, { readonly: true });

      // Escapar metacaracteres LIKE (%, _, \) para evitar wildcards no intencionados
      const escapedId = shortId.replace(/[%_\\]/g, "\\$&");
      const session = db.query<{ id: string }, [string]>(
        `SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' LIMIT 1`
      ).get(`${escapedId}%`);

      if (!session) {
        renderer.renderSystemMessage(
          `Sesión '${shortId}' no encontrada. Usa /sessions para listar.`
        );
        db.close();
        return;
      }

      const messages = db.query<{ role: string; content: string }, [string]>(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 5`
      ).all(session.id);
      db.close();

      // Actualizar sessionId local
      sessionId = session.id;
      renderer.renderSystemMessage(
        `Reanudando sesión ${session.id.slice(0, 8)}…\n` +
        `Nota: el contexto LLM empieza fresco; solo se muestra historial visual.`
      );

      // Mostrar últimos mensajes en orden cronológico
      for (const msg of messages.reverse()) {
        if (msg.role === "user") {
          renderer.renderUserMessage(msg.content);
        } else if (msg.role === "assistant") {
          renderer.renderAgentMessageStart();
          renderer.renderStreamChunk(msg.content);
          renderer.renderAgentMessageEnd();
        }
      }
    } catch (err) {
      renderer.renderSystemMessage(`Error al reanudar sesión: ${err}`);
    }
  }

  // ── Handle a command ────────────────────────────────────────────────────────

  async function handleCommand(cmd: string): Promise<void> {
    switch (cmd) {
      case "help":
        renderer.renderSystemMessage(
          "Comandos disponibles:\n" +
          "  /help         — muestra esta ayuda\n" +
          "  /clear        — limpia la pantalla\n" +
          "  /new          — inicia una nueva sesión\n" +
          "  /status       — muestra info de sesión y provider\n" +
          "  /sessions     — lista las últimas 10 sesiones\n" +
          "  /resume <id>  — reanuda una sesión por su ID corto\n" +
          "  /quit         — sale del TUI"
        );
        break;

      case "quit":
        shutdown();
        break;

      case "clear":
        // Clear messages via renderer (Ink-safe — no raw ANSI escape codes)
        renderer.clearMessages();
        renderer.renderHeader(version);
        renderer.renderStatusBar("idle");
        break;

      case "new-session":
        try {
          // C1: si el agente está muerto, respawnearlo antes de crear sesión
          // spawn() es idempotente — si ya está vivo, no hace nada
          agentProcess.spawn();
          sessionId = await acpClient.newSession(cwd);
          state.setStatus("idle");                    // C5: transición error → idle
          renderer.renderStatusBar("idle");           // C5: actualizar badge visual
          renderer.renderSystemMessage(`Nueva sesión iniciada: ${sessionId.slice(0, 8)}…`);
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

      case "sessions":
        await handleSessionsList();
        break;

      case "resume-missing-id":
        renderer.renderSystemMessage("Uso: /resume <id>  —  usa /sessions para listar IDs");
        break;

      default:
        if (cmd.startsWith("resume:")) {
          const shortId = cmd.slice("resume:".length);
          await handleSessionResume(shortId);
        }
        break;
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
        lastRoutedAgent = agentName;
        renderer.renderRoutingInfo(agentName);
        return;
      }

      // 4. Status marker
      if (text.startsWith(STATUS_MARKER)) {
        renderer.renderSystemMessage(text.slice(STATUS_MARKER.length));
        return;
      }

      // 5. Error marker
      if (text.startsWith(ERR_MARKER)) {
        renderer.renderError(text.slice(ERR_MARKER.length));
        return;
      }

      // 6. Normal text
      if (!agentMessageStarted) {
        renderer.renderAgentMessageStart(lastRoutedAgent);
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
    // C1: NO llamar doExit(1) inmediatamente — dar opción de recuperación
    renderer.renderSystemMessage(
      "El agente se ha detenido. Opciones:\n" +
      "  /new   — reiniciar el agente y crear nueva sesión\n" +
      "  /quit  — salir del TUI"
    );
    // sessionId queda inválido — la guardia C3 en handlePrompt lo capturará
    sessionId = "";
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

    // ── Check 2: LLM provider env vars (D-02: no sendPrompt, solo env vars) ────
    const llmProviderName = detectLlmProviderFromEnv(env);
    if (llmProviderName) {
      renderer.renderSystemMessage(`✓ LLM provider configurado: ${llmProviderName}`);
    } else {
      renderer.renderSystemMessage("⚠ Sin provider LLM configurado");
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

    // A5: registrar SIGINT para shutdown limpio (process.once para evitar múltiples registros)
    sigintHandler = () => { shutdown(); };
    process.once("SIGINT", sigintHandler);
  }

  return { start };
}

// ─── main() ──────────────────────────────────────────────────────────────────

/**
 * Detects the LLM provider name from environment variables (D-02).
 * Returns the provider name or null if none configured.
 * Uses injected env for testability.
 */
function detectLlmProviderFromEnv(env: Record<string, string | undefined>): string | null {
  if (env["ANTHROPIC_API_KEY"]) return "Anthropic";
  if (env["OPENAI_API_KEY"]) return "OpenAI";
  if (env["LM_STUDIO_HOST"]) return "LM Studio";
  if (env["LLAMACPP_HOST"]) return "llama.cpp";
  if (env["OLLAMA_HOST"]) return "Ollama";
  return null;
}

/**
 * Detects the LLM provider URL from environment variables.
 * Returns the URL to probe, or null if no URL-based provider is configured.
 */
function detectLlmProviderUrl(env: Record<string, string | undefined>): string | null {
  const checks = [
    ["LM_STUDIO_HOST", "/v1/models"],
    ["LLAMACPP_HOST",  "/v1/models"],
    ["OLLAMA_HOST",    "/api/tags"],
  ] as const;
  for (const [key, path] of checks) {
    const raw = env[key];
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      return `${parsed.origin}${path}`;
    } catch {
      continue; // URL malformada — ignorar
    }
  }
  return null;
}

/**
 * Checks LLM provider connectivity.
 * - For URL-based providers (Ollama, LM Studio, llama.cpp): does a fetch probe.
 * - For API-key providers (Anthropic, OpenAI): just checks env var presence.
 * Exported for testing.
 */
export async function checkProviderConnectivity(
  env: Record<string, string | undefined>
): Promise<{ ok: boolean; message: string }> {
  const probeUrl = detectLlmProviderUrl(env);

  if (probeUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(probeUrl, { signal: controller.signal });
        if (res.ok) {
          return { ok: true, message: "✓ Provider OK" };
        }
        return { ok: false, message: `⚠ Provider error: HTTP ${res.status}` };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        return { ok: false, message: "⚠ Provider no responde (timeout 5s)" };
      }
      return { ok: false, message: `⚠ Provider error: ${String(err)}` };
    }
  }

  // API-key based providers — just check env var presence
  if (env["ANTHROPIC_API_KEY"]) {
    return { ok: true, message: "✓ Provider OK (Anthropic API key configurada)" };
  }
  if (env["OPENAI_API_KEY"]) {
    return { ok: true, message: "✓ Provider OK (OpenAI API key configurada)" };
  }

  return { ok: false, message: "⚠ Sin provider LLM configurado (revisar ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_HOST)" };
}

/**
 * Entry point: creates real dependencies using Ink and starts the TUI.
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
    const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as Record<string, unknown>;
    if (typeof pkg["version"] === "string") version = pkg["version"] as string;
  } catch (err) {
    process.stderr.write(`[tui] Warning: no se pudo leer package.json: ${err}\n`);
  }

  // Detect active LLM provider
  let config: Config | undefined;
  let configError: string | undefined;
  try {
    config = loadConfig();
  } catch (err) {
    configError = String(err);
  }

  // ── Mount Ink tree and wait for onReady ──────────────────────────────────────

  let resolveReady!: (setState: SetAppState) => void;
  const readyPromise = new Promise<SetAppState>((resolve) => {
    resolveReady = resolve;
  });

  const { unmount } = render(
    <TuiApp onReady={(setState) => resolveReady(setState)} />,
  );

  // Wait until TuiApp has mounted and called onReady with setState
  const setState = await readyPromise;

  // ── Create Ink-based dependencies ────────────────────────────────────────────

  const agentProcess = new AgentProcess();
  const acpClient = new AcpClient(agentProcess);
  const state = new TuiState();
  const renderer = new InkRenderer(setState);
  const input = new InkInput(setState);

  // ── Create and start orchestrator ────────────────────────────────────────────

  const orchestrator = createTuiOrchestrator({
    acpClient,
    agentProcess,
    renderer,
    input,
    state,
    version,
    cwd: process.cwd(),
    provider: detectProvider(config),
    exit: (code: number) => {
      unmount();
      process.exit(code);
    },
  });

  await orchestrator.start();

  // Show config warning if loadConfig() failed
  if (configError) {
    renderer.renderSystemMessage(`⚠ config.toml inválido: ${configError}`);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// Only run main() when this file is executed directly (not imported in tests).

// ─── Helpers used by main() and exported for testing ─────────────────────────

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

/**
 * Detects the active LLM provider.
 * Priority: config.toml (agents.orchestrator) > env vars > "desconocido"
 */
export function detectProvider(cfg?: Config): string {
  // Primero intentar config.toml
  const orchCfg: AgentConfig | undefined = cfg?.agents?.["orchestrator"];
  if (orchCfg?.provider && orchCfg?.model) {
    return `${orchCfg.provider} · ${orchCfg.model}`;
  }
  if (orchCfg?.provider) {
    return orchCfg.provider;
  }
  // Fallback: env vars
  if (process.env["ANTHROPIC_API_KEY"]) return "Anthropic";
  if (process.env["OPENAI_API_KEY"]) return "OpenAI";
  if (process.env["LM_STUDIO_HOST"]) return `LM Studio (${sanitizeHostUrl(process.env["LM_STUDIO_HOST"])})`;
  if (process.env["LLAMACPP_HOST"]) return `llama.cpp (${sanitizeHostUrl(process.env["LLAMACPP_HOST"])})`;
  if (process.env["OLLAMA_HOST"]) return `Ollama (${sanitizeHostUrl(process.env["OLLAMA_HOST"])})`;
  return "desconocido";
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[tui] Fatal: ${err}\n`);
    process.exit(1);
  });
}
