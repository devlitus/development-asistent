import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

/**
 * ServerManager — gestiona el proceso hijo de personal-asistent.
 *
 * Lanza el servidor usando Bun desde el directorio del proyecto
 * y expone stdin/stdout para la comunicación JSON-RPC.
 */
export class ServerManager {
  private process: cp.ChildProcess | null = null;
  private readonly outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /** Devuelve true si el proceso está activo. */
  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** stdin del proceso hijo (para enviar mensajes). */
  get stdin(): cp.ChildProcess["stdin"] {
    return this.process?.stdin ?? null;
  }

  /** stdout del proceso hijo (para recibir mensajes). */
  get stdout(): cp.ChildProcess["stdout"] {
    return this.process?.stdout ?? null;
  }

  /**
   * Inicia el servidor personal-asistent como proceso hijo.
   * Detecta automáticamente el directorio del proyecto o usa serverPath de la config.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    const config = vscode.workspace.getConfiguration("personalAsistent");
    const bunExe: string = config.get("bunExecutable") || "bun";
    const serverPath: string = config.get("serverPath") || this.detectServerPath();

    if (!serverPath) {
      throw new Error(
        "No se encontró el directorio de personal-asistent. " +
        "Configura 'personalAsistent.serverPath' apuntando a la carpeta del proyecto."
      );
    }

    const entryPoint = path.join(serverPath, "src", "index.ts");
    if (!fs.existsSync(entryPoint)) {
      throw new Error(
        `No se encontró ${entryPoint}. ` +
        "Verifica que 'personalAsistent.serverPath' apunte a la carpeta correcta."
      );
    }

    const env = this.buildEnv(config);

    this.outputChannel.appendLine(`[Server] Iniciando: ${bunExe} run ${entryPoint}`);
    this.outputChannel.appendLine(`[Server] Directorio: ${serverPath}`);

    this.process = cp.spawn(bunExe, ["run", entryPoint], {
      cwd: serverPath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.outputChannel.appendLine(`[Server] ${data.toString().trimEnd()}`);
    });

    this.process.on("exit", (code, signal) => {
      this.outputChannel.appendLine(
        `[Server] Proceso terminado (código: ${code ?? signal})`
      );
      this.process = null;
    });

    this.process.on("error", (err) => {
      this.outputChannel.appendLine(`[Server] Error de proceso: ${err.message}`);
      // Si bun no está en PATH, dar un mensaje claro
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        vscode.window.showErrorMessage(
          `No se encontró '${bunExe}'. Instala Bun desde https://bun.sh o configura 'personalAsistent.bunExecutable'.`
        );
      }
      this.process = null;
    });

    // Esperar un poco para que el proceso arranque
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    if (!this.isRunning) {
      throw new Error("El proceso de personal-asistent terminó inesperadamente al iniciar.");
    }

    this.outputChannel.appendLine("[Server] Proceso iniciado correctamente.");
  }

  /** Detiene el proceso hijo de forma limpia. */
  stop(): void {
    if (this.process && !this.process.killed) {
      this.outputChannel.appendLine("[Server] Deteniendo proceso...");
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  /**
   * Detecta el directorio del servidor buscando en los workspaces abiertos
   * un directorio que contenga src/index.ts con la firma de personal-asistent.
   */
  private detectServerPath(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of workspaceFolders) {
      const candidate = folder.uri.fsPath;
      const entry = path.join(candidate, "src", "index.ts");
      const pkg = path.join(candidate, "package.json");

      if (!fs.existsSync(entry) || !fs.existsSync(pkg)) continue;

      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (pkgJson.name === "personal-asistent") {
          return candidate;
        }
      } catch {
        // package.json inválido, ignorar
      }
    }

    return "";
  }

  /**
   * Construye las variables de entorno para el proceso hijo.
   * Mezcla el entorno actual con las claves API configuradas.
   * Nunca expone las claves en logs.
   */
  private buildEnv(config: vscode.WorkspaceConfiguration): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };

    const anthropicKey: string = config.get("anthropicApiKey") || "";
    const openaiKey: string = config.get("openaiApiKey") || "";
    const ollamaHost: string = config.get("ollamaHost") || "";
    const lmStudioHost: string = config.get("lmStudioHost") || "";

    // Las variables de entorno tienen prioridad sobre la config de VS Code
    if (anthropicKey && !env["ANTHROPIC_API_KEY"]) {
      env["ANTHROPIC_API_KEY"] = anthropicKey;
    }
    if (openaiKey && !env["OPENAI_API_KEY"]) {
      env["OPENAI_API_KEY"] = openaiKey;
    }
    if (ollamaHost && !env["OLLAMA_HOST"]) {
      env["OLLAMA_HOST"] = ollamaHost;
    }
    if (lmStudioHost && !env["LM_STUDIO_HOST"]) {
      env["LM_STUDIO_HOST"] = lmStudioHost;
    }

    return env;
  }
}
