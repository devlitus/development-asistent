import * as vscode from "vscode";
import { RpcClient, type SessionUpdateParams } from "./rpc-client.ts";
import { ServerManager } from "./server-manager.ts";
import type { StatusBar } from "./status-bar.ts";

// Marcadores especiales que emite el servidor
const TOOL_CALL_MARKER = "\x00TOOL_CALL\x00";
const TOOL_RESULT_MARKER = "\x00TOOL_RESULT\x00";
const ERR_MARKER = "\x00ERR\x00";

/** Resultado de initialize (subconjunto que usamos). */
interface InitializeResult {
  protocolVersion: string;
  agentCapabilities: Record<string, unknown>;
}

/** Resultado de session/new. */
interface SessionNewResult {
  sessionId: string;
}

/** Resultado de session/prompt. */
interface SessionPromptResult {
  stopReason: "end_turn" | "error";
}

/**
 * AgentSession — mantiene el estado de una sesión ACP por workspace.
 *
 * Una sesión se crea la primera vez que el usuario escribe en el chat
 * y se reutiliza en mensajes posteriores (sticky participant).
 */
interface AgentSession {
  sessionId: string;
  client: RpcClient;
  server: ServerManager;
}

/**
 * Registra el Chat Participant @asistent y devuelve el Disposable.
 *
 * El participant:
 * 1. Arranca el servidor personal-asistent (proceso hijo) si no está corriendo.
 * 2. Hace initialize + session/new en la primera invocación.
 * 3. En cada mensaje, hace session/prompt y streamea las notificaciones
 *    session/update al chat de VS Code.
 * 4. Muestra herramientas activas como progreso mientras trabaja.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
  statusBar: StatusBar
): vscode.Disposable {
  // Sesión activa por workspace folder (null = no iniciada)
  let activeSession: AgentSession | null = null;

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> => {
    // ── 1. Obtener o crear sesión ────────────────────────────────────────
    try {
      if (!activeSession || !activeSession.server.isRunning) {
        statusBar.setStarting();
        response.progress("Iniciando Personal Asistent...");
        activeSession = await createSession(outputChannel);
        statusBar.setReady(activeSession.sessionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      statusBar.setError(msg);
      response.markdown(
        `**Error al iniciar el servidor:**\n\n\`\`\`\n${msg}\n\`\`\`\n\n` +
        `Ejecuta **Personal Asistent: Diagnóstico** en la paleta de comandos (\`Ctrl+Shift+P\`) para ver qué falta.`
      );
      return { metadata: { command: request.command ?? "" } };
    }

    const { sessionId, client } = activeSession;

    // ── 2. Construir el texto del prompt ────────────────────────────────
    const commandPrefix = request.command ? `/${request.command} ` : "";
    const userText = `${commandPrefix}${request.prompt}`.trim();

    if (!userText) {
      response.markdown("¿En qué puedo ayudarte? Escribe tu petición.");
      return { metadata: { command: request.command ?? "" } };
    }

    // ── 3. Enviar session/prompt y streamear respuesta ──────────────────
    let accumulated = "";
    let toolInProgress: string | null = null;

    // Registrar handler de notificaciones
    const unsubscribe = client.onNotification(
      "session/update",
      (params: unknown) => {
        if (token.isCancellationRequested) return;

        const p = params as SessionUpdateParams;
        if (p?.update?.sessionUpdate !== "agent_message_chunk") return;

        const text = p?.update?.content?.text ?? "";
        if (!text) return;

        // Detectar marcadores especiales de herramientas
        if (text.startsWith(TOOL_CALL_MARKER)) {
          const toolName = text.slice(TOOL_CALL_MARKER.length);
          toolInProgress = toolName;
          response.progress(`Usando herramienta: ${toolName}...`);
          return;
        }

        if (text.startsWith(TOOL_RESULT_MARKER)) {
          const parts = text.slice(TOOL_RESULT_MARKER.length).split("\x00");
          const toolName = parts[0] ?? toolInProgress ?? "herramienta";
          const status = parts[1] ?? "completed";
          toolInProgress = null;
          outputChannel.appendLine(
            `[Chat] Tool ${toolName}: ${status}`
          );
          return;
        }

        if (text.startsWith(ERR_MARKER)) {
          const errorMsg = text.slice(ERR_MARKER.length);
          response.markdown(`\n> **Error del agente:** ${errorMsg}\n`);
          return;
        }

        // Texto normal — streamear al chat
        accumulated += text;
        response.markdown(text);
      }
    );

    try {
      const result = await client.sendRequest<SessionPromptResult>(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: userText }],
        }
      );

      unsubscribe();

      if (result.stopReason === "error") {
        if (!accumulated) {
          response.markdown(
            "> El agente terminó con error. Revisa el canal **Personal Asistent** para más detalles."
          );
        }
        return { metadata: { command: request.command ?? "" } };
      }

      return { metadata: { command: request.command ?? "" } };
    } catch (err) {
      unsubscribe();
      const msg = err instanceof Error ? err.message : String(err);

      // Si el servidor murió, limpiar la sesión para reiniciar la próxima vez
      if (!activeSession?.server.isRunning) {
        activeSession = null;
        statusBar.setStopped();
      }

      response.markdown(
        `**Error de comunicación con el agente:**\n\n\`\`\`\n${msg}\n\`\`\``
      );
      return { metadata: { command: request.command ?? "" } };
    }
  };

  const participant = vscode.chat.createChatParticipant(
    "personal-asistent.agent",
    handler
  );

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "icon.png"
  );

  // Limpiar sesión al desactivar la extensión
  context.subscriptions.push(
    new vscode.Disposable(() => {
      activeSession?.server.stop();
      activeSession = null;
    })
  );

  return participant;
}

/**
 * Crea una nueva sesión ACP: arranca el servidor, hace initialize y session/new.
 */
async function createSession(
  outputChannel: vscode.OutputChannel
): Promise<AgentSession> {
  const server = new ServerManager(outputChannel);
  await server.start();

  if (!server.stdin || !server.stdout) {
    server.stop();
    throw new Error("El proceso del servidor no tiene stdin/stdout disponibles.");
  }

  const client = new RpcClient(server.stdin, server.stdout, outputChannel);

  // initialize
  const initResult = await client.sendRequest<InitializeResult>("initialize", {
    protocolVersion: "0.1.0",
    clientInfo: { name: "vscode-personal-asistent", version: "0.1.0" },
  });
  outputChannel.appendLine(
    `[ACP] Protocol version: ${initResult.protocolVersion}`
  );

  // session/new — usa el primer workspace folder como cwd
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const sessionResult = await client.sendRequest<SessionNewResult>(
    "session/new",
    { cwd }
  );
  outputChannel.appendLine(`[ACP] Session creada: ${sessionResult.sessionId}`);

  return { sessionId: sessionResult.sessionId, client, server };
}
