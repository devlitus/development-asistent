import * as vscode from "vscode";
import { registerChatParticipant } from "./participant.ts";
import { StatusBar } from "./status-bar.ts";
import { runDiagnostics } from "./diagnostics.ts";

let outputChannel: vscode.OutputChannel | undefined;
let statusBar: StatusBar | undefined;

/**
 * Punto de entrada de la extensión.
 */
export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Personal Asistent");
  context.subscriptions.push(outputChannel);

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  outputChannel.appendLine("Personal Asistent activado.");

  // Verificar que la API de chat está disponible (requiere Copilot Chat)
  if (!vscode.chat) {
    const msg =
      "Personal Asistent requiere GitHub Copilot Chat. Instálalo y recarga VS Code.";
    outputChannel.appendLine(`[Error] ${msg}`);
    statusBar.setError("Requiere GitHub Copilot Chat");
    vscode.window.showErrorMessage(msg, "Ver diagnóstico").then((sel) => {
      if (sel === "Ver diagnóstico") runDiagnostics(outputChannel!);
    });
    return;
  }

  try {
    const participant = registerChatParticipant(context, outputChannel, statusBar);
    context.subscriptions.push(participant);
    outputChannel.appendLine("[OK] Chat participant @asistent registrado.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[Error] Al registrar el participant: ${msg}`);
    statusBar.setError(msg);
    vscode.window.showErrorMessage(`Personal Asistent: error al activar — ${msg}`);
    return;
  }

  // Comando: ver log
  context.subscriptions.push(
    vscode.commands.registerCommand("personalAsistent.showLog", () => {
      outputChannel?.show();
    })
  );

  // Comando: diagnóstico
  context.subscriptions.push(
    vscode.commands.registerCommand("personalAsistent.diagnose", () => {
      runDiagnostics(outputChannel!);
    })
  );

  // Comando: reiniciar sesión
  context.subscriptions.push(
    vscode.commands.registerCommand("personalAsistent.restart", () => {
      outputChannel?.appendLine("[Extension] Reinicio solicitado.");
      statusBar?.setStopped();
      vscode.window.showInformationMessage(
        "Personal Asistent: sesión reiniciada. El próximo mensaje en el chat conectará de nuevo."
      );
    })
  );

  // Notificación de bienvenida la primera vez
  const welcomed = context.globalState.get<boolean>("welcomed");
  if (!welcomed) {
    context.globalState.update("welcomed", true);
    vscode.window
      .showInformationMessage(
        "✅ Personal Asistent instalado. Escribe @asistent en el chat de Copilot para empezar.",
        "Abrir chat",
        "Ver diagnóstico"
      )
      .then((sel) => {
        if (sel === "Abrir chat") {
          vscode.commands.executeCommand("workbench.panel.chat.view.copilot.focus");
        } else if (sel === "Ver diagnóstico") {
          runDiagnostics(outputChannel!);
        }
      });
  }
}

/**
 * Llamado por VS Code al desactivar la extensión.
 */
export function deactivate(): void {
  outputChannel?.appendLine("Personal Asistent desactivado.");
  statusBar?.dispose();
}
