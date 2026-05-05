import * as vscode from "vscode";

/**
 * StatusBar — barra de estado que muestra si el servidor está corriendo.
 *
 * Estados:
 *  $(circle-slash) Detenido  → rojo    → al hacer click abre el log
 *  $(sync~spin) Iniciando…   → amarillo
 *  $(check) Listo            → verde
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = "personalAsistent.showLog";
    this.setStopped();
    this.item.show();
  }

  setStopped(): void {
    this.item.text = "$(circle-slash) Asistent";
    this.item.tooltip = "Personal Asistent: detenido. Escribe @asistent para iniciar.";
    this.item.backgroundColor = undefined;
    this.item.color = new vscode.ThemeColor("statusBarItem.warningForeground");
  }

  setStarting(): void {
    this.item.text = "$(sync~spin) Asistent";
    this.item.tooltip = "Personal Asistent: iniciando servidor...";
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  setReady(sessionId: string): void {
    this.item.text = "$(check) Asistent";
    this.item.tooltip = `Personal Asistent: listo (sesión ${sessionId.slice(0, 8)}…)\nHaz click para ver el log`;
    this.item.backgroundColor = undefined;
    this.item.color = new vscode.ThemeColor("statusBarItem.prominentForeground");
  }

  setError(message: string): void {
    this.item.text = "$(error) Asistent";
    this.item.tooltip = `Personal Asistent: error — ${message}\nHaz click para ver el log`;
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    this.item.color = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
