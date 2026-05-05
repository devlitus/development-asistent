import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

interface DiagResult {
  ok: boolean;
  label: string;
  detail: string;
}

/**
 * Ejecuta una serie de comprobaciones y muestra el resultado
 * en un QuickPick informativo para que el usuario sepa qué falta.
 */
export async function runDiagnostics(
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const results: DiagResult[] = [];

  // 1. Bun instalado
  const config = vscode.workspace.getConfiguration("personalAsistent");
  const bunExe: string = config.get("bunExecutable") || "bun";
  const bunVersion = await getBunVersion(bunExe);
  results.push(
    bunVersion
      ? { ok: true, label: "Bun", detail: `v${bunVersion}` }
      : {
          ok: false,
          label: "Bun no encontrado",
          detail: `'${bunExe}' no está en PATH. Instala desde https://bun.sh o configura personalAsistent.bunExecutable`,
        }
  );

  // 2. Directorio del servidor
  const serverPath: string = config.get("serverPath") || detectServerPath();
  results.push(
    serverPath
      ? { ok: true, label: "Servidor personal-asistent", detail: serverPath }
      : {
          ok: false,
          label: "Directorio del servidor no encontrado",
          detail:
            "Abre la carpeta del proyecto personal-asistent en este workspace, o configura personalAsistent.serverPath",
        }
  );

  // 3. Al menos una API key configurada
  const hasKey =
    !!config.get("anthropicApiKey") ||
    !!config.get("openaiApiKey") ||
    !!config.get("ollamaHost") ||
    !!config.get("lmStudioHost") ||
    !!process.env["ANTHROPIC_API_KEY"] ||
    !!process.env["OPENAI_API_KEY"] ||
    !!process.env["OLLAMA_HOST"] ||
    !!process.env["LM_STUDIO_HOST"];
  results.push(
    hasKey
      ? { ok: true, label: "Proveedor LLM", detail: detectProviderName(config) }
      : {
          ok: false,
          label: "Sin proveedor LLM configurado",
          detail:
            "Configura personalAsistent.anthropicApiKey / openaiApiKey / ollamaHost, o define las variables de entorno equivalentes",
        }
  );

  // 4. Copilot Chat disponible
  results.push(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode as any).chat
      ? { ok: true, label: "GitHub Copilot Chat", detail: "Disponible" }
      : {
          ok: false,
          label: "GitHub Copilot Chat no instalado",
          detail: "Instala la extensión 'GitHub Copilot Chat' y recarga VS Code",
        }
  );

  // Mostrar resumen en QuickPick
  const allOk = results.every((r) => r.ok);
  const items = results.map((r) => ({
    label: `${r.ok ? "$(check)" : "$(error)"} ${r.label}`,
    description: r.detail,
    picked: false,
  }));

  items.unshift({
    label: allOk
      ? "$(check-all) Todo correcto — escribe @asistent en el chat de Copilot"
      : "$(warning) Hay problemas que resolver antes de usar @asistent",
    description: "",
    picked: false,
  });

  outputChannel.appendLine("\n=== Diagnóstico Personal Asistent ===");
  for (const r of results) {
    outputChannel.appendLine(`${r.ok ? "[OK]" : "[ERROR]"} ${r.label}: ${r.detail}`);
  }

  await vscode.window.showQuickPick(items, {
    title: "Personal Asistent — Diagnóstico",
    placeHolder: "Estado de la configuración",
    canPickMany: false,
  });

  if (!allOk) {
    const open = await vscode.window.showInformationMessage(
      "¿Abrir la configuración de Personal Asistent?",
      "Abrir configuración",
      "Cancelar"
    );
    if (open === "Abrir configuración") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "personalAsistent"
      );
    }
  }
}

function getBunVersion(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec(`${exe} --version`, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim().replace(/^bun\s+/i, ""));
    });
  });
}

function detectServerPath(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    const candidate = folder.uri.fsPath;
    const entry = path.join(candidate, "src", "index.ts");
    const pkg = path.join(candidate, "package.json");
    if (!fs.existsSync(entry) || !fs.existsSync(pkg)) continue;
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
      if (pkgJson.name === "personal-asistent") return candidate;
    } catch { /* ignorar */ }
  }
  return "";
}

function detectProviderName(config: vscode.WorkspaceConfiguration): string {
  if (config.get("anthropicApiKey") || process.env["ANTHROPIC_API_KEY"])
    return "Anthropic (Claude)";
  if (config.get("openaiApiKey") || process.env["OPENAI_API_KEY"])
    return "OpenAI";
  if (config.get("ollamaHost") || process.env["OLLAMA_HOST"])
    return "Ollama (local)";
  if (config.get("lmStudioHost") || process.env["LM_STUDIO_HOST"])
    return "LM Studio (local)";
  return "Desconocido";
}
