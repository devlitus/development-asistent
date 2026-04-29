/**
 * StdioTransport — bidirectional JSON-RPC 2.0 transport over stdin/stdout.
 *
 * Reads NDJSON (newline-delimited JSON) from a readable stream,
 * parses each line as a JSON-RPC message, and delegates to a handler.
 * Sends responses and notifications by writing NDJSON to an output sink.
 *
 * ## Design decisions
 * - **Dependency-injected streams** for testability: accepts custom
 *   `input` (ReadableStream<Uint8Array>) and `output` ({ write }).
 * - **stdout is sacred**: only JSON-RPC goes to output. Any logging
 *   within the app must use `console.error` or a dedicated logger.
 * - **No ACP awareness**: this layer is pure JSON-RPC.
 * - **Graceful shutdown**: `close()` aborts the read loop; signal
 *   handlers (SIGINT/SIGTERM) are the caller's responsibility.
 */

import type {
  JSONRPCRequest,
  JSONRPCNotification,
  JSONRPCResponse,
  JSONRPCError,
} from "../types/jsonrpc.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Handler invoked for every valid incoming JSON-RPC request or notification. */
export type MessageHandler = (
  message: JSONRPCRequest | JSONRPCNotification,
) => void | Promise<void>;

/** Minimal write contract — matches `process.stdout` and test doubles. */
export interface TransportOutput {
  readonly write: (data: string) => void;
}

/** Constructor options — all optional for production defaults. */
export interface StdioTransportOptions {
  /** Input byte stream. Defaults to `Bun.stdin.stream()`. */
  readonly input?: ReadableStream<Uint8Array>;
  /** Output writer. Defaults to a thin wrapper around `process.stdout`. */
  readonly output?: TransportOutput;
}

/**
 * Internal reader type that works with both web streams and Bun's
 * extended ReadableStreamDefaultReader (which adds readMany).
 */
type LineReader = {
  read(): Promise<ReadableStreamReadResult<string>>;
  releaseLock(): void;
  cancel(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed message size in bytes (10 MB). */
const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class StdioTransport {
  private readonly input: ReadableStream<Uint8Array>;
  private readonly output: TransportOutput;
  private aborted = false;
  private activeReader: LineReader | null = null;

  constructor(options: StdioTransportOptions = {}) {
    this.input = options.input ?? Bun.stdin.stream();
    this.output = options.output ?? createStdoutWriter();
  }

  // ---- Reading (inbound) -------------------------------------------------

  /**
   * Start reading from the input stream.
   *
   * Resolves when the stream ends or `close()` is called.
   * Each valid JSON-RPC message triggers `handler`.
   * Parse errors and invalid messages produce error responses on the output.
   */
  async start(handler: MessageHandler): Promise<void> {
    // TextDecoderStream type in @types/bun has a writable side mismatch
    // with ReadableStream<Uint8Array> — cast is safe at runtime in Bun.
    const decoded = this.input.pipeThrough(
      new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
    );
    const reader = decoded.getReader() as unknown as LineReader;
    this.activeReader = reader;
    let buffer = "";

    try {
      while (!this.aborted) {
        const result = await reader.read();
        if (result.done) break;

        buffer += result.value;

        // Issue 7: Enforce max message size to prevent OOM
        if (buffer.length > MAX_MESSAGE_SIZE) {
          this.sendError(null, {
            code: -32700,
            message: "Message too large",
          });
          buffer = "";
          continue;
        }

        // Split on newlines — last element is an incomplete line
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.trim() === "") continue;
          await this.processLine(line, handler);
        }
      }

      // Process any remaining data in the buffer after stream closes
      if (!this.aborted && buffer.trim() !== "") {
        await this.processLine(buffer, handler);
      }
    } finally {
      this.activeReader = null;
      try {
        reader.releaseLock();
      } catch (err) {
        // Reader may already be released after cancel()
        console.error("[transport] releaseLock failed:", err);
      }
    }
  }

  /**
   * Stop the read loop. `start()` will resolve shortly after.
   */
  close(): void {
    this.aborted = true;
    // Cancel the active reader to unblock any pending read()
    if (this.activeReader) {
      this.activeReader.cancel().catch(() => {});
    }
  }

  // ---- Writing (outbound) ------------------------------------------------

  /** Send a successful JSON-RPC response. */
  sendResponse(id: string | number, result: unknown): void {
    const response: JSONRPCResponse = {
      jsonrpc: "2.0",
      id,
      result,
    };
    this.writeLine(JSON.stringify(response));
  }

  /** Send a JSON-RPC error response. `id` may be `null` when unknown. */
  sendError(id: string | number | null, error: JSONRPCError): void {
    const response: JSONRPCResponse = {
      jsonrpc: "2.0",
      id,
      error,
    };
    this.writeLine(JSON.stringify(response));
  }

  /** Send a JSON-RPC notification (no id). */
  sendNotification(method: string, params?: unknown): void {
    const notification: JSONRPCNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined && { params }),
    };
    this.writeLine(JSON.stringify(notification));
  }

  // ---- Internals ---------------------------------------------------------

  private async processLine(line: string, handler: MessageHandler): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendError(null, {
        code: -32700,
        message: "Parse error",
      });
      return;
    }

    // Validate JSON-RPC 2.0 structure
    if (typeof parsed !== "object" || parsed === null) {
      this.sendError(null, {
        code: -32600,
        message: "Invalid Request",
      });
      return;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj["jsonrpc"] !== "2.0") {
      this.sendError(extractId(obj), {
        code: -32600,
        message: "Invalid Request",
      });
      return;
    }

    if (typeof obj["method"] !== "string") {
      this.sendError(extractId(obj), {
        code: -32600,
        message: "Invalid Request",
      });
      return;
    }

    // Issue 5: Validate that id is string, number, or null (not array/object)
    if ("id" in obj && obj["id"] !== null &&
        typeof obj["id"] !== "string" && typeof obj["id"] !== "number") {
      this.sendError(null, {
        code: -32600,
        message: "Invalid Request",
      });
      return;
    }

    // Valid JSON-RPC message — delegate to handler
    // Issue 1: Isolate handler errors to prevent transport death
    try {
      await handler(parsed as JSONRPCRequest | JSONRPCNotification);
    } catch (err) {
      console.error("[StdioTransport] handler error:", err);
    }
  }

  private writeLine(json: string): void {
    this.output.write(json + "\n");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a JSON-RPC `id` from a parsed object, or `null` if not found. */
function extractId(obj: Record<string, unknown>): string | number | null {
  const id = obj["id"];
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

/** Create a thin writer around `process.stdout`. */
function createStdoutWriter(): TransportOutput {
  return {
    write(data: string): void {
      process.stdout.write(data);
    },
  };
}
