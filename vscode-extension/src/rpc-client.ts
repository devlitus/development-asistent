import type { Readable, Writable } from "stream";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 tipos básicos
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

// ---------------------------------------------------------------------------
// Tipos ACP (subconjunto necesario)
// ---------------------------------------------------------------------------

export interface SessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: { type: string; text?: string };
  };
}

// ---------------------------------------------------------------------------
// RpcClient
// ---------------------------------------------------------------------------

/**
 * Cliente JSON-RPC 2.0 sobre stdio (NDJSON).
 *
 * - Envía requests a través de stdin del proceso servidor.
 * - Lee responses y notifications de stdout.
 * - Resuelve Promises por id de request.
 * - Emite notificaciones vía callbacks registrados.
 */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly notificationHandlers = new Map<
    string,
    Array<(params: unknown) => void>
  >();
  private buffer = "";
  private readonly outputChannel: vscode.OutputChannel;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;
    stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
    stdout.on("end", () => this.onEnd());
  }

  // ── Envío ────────────────────────────────────────────────────────────────

  /**
   * Envía una request JSON-RPC y devuelve una Promise con el resultado.
   * Lanza si el servidor responde con error.
   */
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      const line = JSON.stringify(message) + "\n";
      this.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`Error escribiendo en stdin: ${err.message}`));
        }
      });
    });
  }

  /**
   * Registra un handler para una notificación concreta (ej: "session/update").
   * Devuelve una función para eliminar el handler.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);

    return () => {
      const current = this.notificationHandlers.get(method) ?? [];
      this.notificationHandlers.set(
        method,
        current.filter((h) => h !== handler)
      );
    };
  }

  // ── Recepción ────────────────────────────────────────────────────────────

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // La última parte puede estar incompleta — guardarla en buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.processLine(trimmed);
    }
  }

  private processLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.outputChannel.appendLine(`[RPC] Línea inválida ignorada: ${line.slice(0, 120)}`);
      return;
    }

    if ("id" in msg && msg.id !== undefined) {
      // Es una Response
      this.handleResponse(msg as JsonRpcResponse);
    } else {
      // Es una Notification
      this.handleNotification(msg as JsonRpcNotification);
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) {
      this.outputChannel.appendLine(`[RPC] Response sin pending request (id=${msg.id})`);
      return;
    }
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const handlers = this.notificationHandlers.get(msg.method) ?? [];
    for (const handler of handlers) {
      try {
        handler(msg.params);
      } catch (err) {
        this.outputChannel.appendLine(
          `[RPC] Error en handler de '${msg.method}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private onEnd(): void {
    // Rechazar todas las requests pendientes
    for (const [id, pending] of this.pending) {
      pending.reject(new Error("Conexión con el servidor cerrada."));
      this.pending.delete(id);
    }
  }
}
