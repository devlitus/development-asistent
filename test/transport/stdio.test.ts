/**
 * Unit tests for StdioTransport — the JSON-RPC over stdio NDJSON transport.
 *
 * Uses mock streams instead of real stdin/stdout for deterministic testing.
 */

import { describe, it, expect, mock } from "bun:test";
import { StdioTransport } from "../../src/transport/stdio.ts";
import type {
  JSONRPCRequest,
  JSONRPCNotification,
} from "../../src/types/jsonrpc.ts";

// ---------------------------------------------------------------------------
// Helpers: mock streams
// ---------------------------------------------------------------------------

/** Create a ReadableStream<Uint8Array> that immediately emits `data` and closes. */
function createInputStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

/** Create a ReadableStream that emits chunks with a small delay between them. */
function createDelayedInputStream(
  chunks: string[],
  delayMs = 10,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Create a mock output that captures written strings. */
function createMockOutput() {
  const chunks: string[] = [];
  return {
    write(data: string) {
      chunks.push(data);
    },
    get chunks() {
      return chunks;
    },
    /** Parse all written chunks as JSON objects. */
    get messages() {
      return chunks.map((c) => JSON.parse(c.trim()));
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StdioTransport", () => {
  describe("incoming message parsing", () => {
    it("should parse a valid JSON-RPC request and call the handler", async () => {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      });

      const input = createInputStream(request + "\n");
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(1);

      const received = handler.mock.calls[0]![0] as JSONRPCRequest;
      expect(received.jsonrpc).toBe("2.0");
      expect(received.id).toBe(1);
      expect(received.method).toBe("initialize");
      expect(received.params).toEqual({ protocolVersion: 1 });
    });

    it("should parse a valid JSON-RPC notification (no id field)", async () => {
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1" },
      });

      const input = createInputStream(notification + "\n");
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(1);

      const received = handler.mock.calls[0]![0] as JSONRPCNotification;
      expect(received.jsonrpc).toBe("2.0");
      expect(received.method).toBe("session/update");
      expect("id" in received).toBe(false);
    });

    it("should handle multiple messages separated by newlines", async () => {
      const messages = [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "method1" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "method2" }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "method3" }),
      ]
        .join("\n") + "\n";

      const input = createInputStream(messages);
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(3);

      const methods = handler.mock.calls.map(
        (c) => (c[0] as JSONRPCRequest).method,
      );
      expect(methods).toEqual(["method1", "method2", "method3"]);
    });

    it("should ignore empty lines between messages", async () => {
      const data =
        "\n\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }) +
        "\n\n";

      const input = createInputStream(data);
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should handle a request without params field", async () => {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "shutdown",
      });

      const input = createInputStream(request + "\n");
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0]![0] as JSONRPCRequest;
      expect(received.method).toBe("shutdown");
      expect(received.params).toBeUndefined();
    });

    it("should handle messages arriving in separate chunks", async () => {
      const chunks = [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "m1" }) + "\n",
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "m2" }) + "\n",
      ];

      const input = createDelayedInputStream(chunks, 5);
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("parse error handling", () => {
    it("should send parse_error (-32700) for malformed JSON", async () => {
      const input = createInputStream("{invalid json\n");
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).not.toHaveBeenCalled();
      expect(output.chunks).toHaveLength(1);

      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBeNull();
      expect(response.error.code).toBe(-32700);
      expect(response.error.message).toContain("Parse error");
    });

    it("should send invalid_request (-32600) for valid JSON that is not JSON-RPC", async () => {
      const input = createInputStream('{"foo":"bar"}\n');
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).not.toHaveBeenCalled();
      expect(output.chunks).toHaveLength(1);

      const response = output.messages[0]!;
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toContain("Invalid Request");
    });

    it("should send invalid_request (-32600) when jsonrpc field is missing", async () => {
      const input = createInputStream('{"id":1,"method":"test"}\n');
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).not.toHaveBeenCalled();
      const response = output.messages[0]!;
      expect(response.error.code).toBe(-32600);
    });

    it("should send invalid_request (-32600) when method is not a string", async () => {
      const input = createInputStream('{"jsonrpc":"2.0","id":1,"method":123}\n');
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).not.toHaveBeenCalled();
      const response = output.messages[0]!;
      expect(response.error.code).toBe(-32600);
    });

    it("should include the request id in error response when available", async () => {
      const input = createInputStream('{"jsonrpc":"2.0","id":42,"method":123}\n');
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      const response = output.messages[0]!;
      expect(response.id).toBe(42);
      expect(response.error.code).toBe(-32600);
    });

    it("should continue processing after a malformed message", async () => {
      const data =
        "not json\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "valid" }) +
        "\n";

      const input = createInputStream(data);
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      // First line: parse error sent, handler NOT called
      // Second line: valid, handler called
      expect(handler).toHaveBeenCalledTimes(1);
      expect(output.chunks).toHaveLength(1); // Only the error response

      const received = handler.mock.calls[0]![0] as JSONRPCRequest;
      expect(received.method).toBe("valid");
    });
  });

  describe("sendResponse", () => {
    it("should write a valid JSON-RPC response to output", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendResponse(1, { protocolVersion: 1 });

      expect(output.chunks).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ protocolVersion: 1 });
      expect(response.error).toBeUndefined();
    });

    it("should support string IDs in responses", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendResponse("abc-123", { status: "ok" });

      const response = output.messages[0]!;
      expect(response.id).toBe("abc-123");
    });

    it("should terminate each response with a newline", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendResponse(1, {});

      expect(output.chunks[0]!.endsWith("\n")).toBe(true);
    });
  });

  describe("sendNotification", () => {
    it("should write a valid JSON-RPC notification to output", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendNotification("session/update", { sessionId: "s1" });

      expect(output.chunks).toHaveLength(1);
      const notif = output.messages[0]!;
      expect(notif.jsonrpc).toBe("2.0");
      expect(notif.method).toBe("session/update");
      expect(notif.params).toEqual({ sessionId: "s1" });
      expect("id" in notif).toBe(false);
    });

    it("should not include params field when params is undefined", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendNotification("cancelled");

      const notif = output.messages[0]!;
      expect(notif.method).toBe("cancelled");
      expect("params" in notif).toBe(false);
    });

    it("should terminate each notification with a newline", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendNotification("test");

      expect(output.chunks[0]!.endsWith("\n")).toBe(true);
    });
  });

  describe("sendError", () => {
    it("should write a JSON-RPC error response", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendError(1, { code: -32601, message: "Method not found" });

      expect(output.chunks).toHaveLength(1);
      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toBe("Method not found");
      expect(response.result).toBeUndefined();
    });

    it("should use null id for error responses without a known id", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendError(null, { code: -32700, message: "Parse error" });

      const raw = output.chunks[0]!;
      expect(raw).toContain('"id":null');
    });

    it("should include error data when provided", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendError(1, {
        code: -32602,
        message: "Invalid params",
        data: { field: "sessionId" },
      });

      const response = output.messages[0]!;
      expect(response.error.data).toEqual({ field: "sessionId" });
    });
  });

  describe("lifecycle", () => {
    it("should resolve start() when input stream ends", async () => {
      const input = createInputStream(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }) + "\n",
      );
      const output = createMockOutput();

      const transport = new StdioTransport({ input, output });
      // Should resolve, not hang
      await transport.start(() => {});
    });

    it("should process remaining buffer when stream closes without trailing newline", async () => {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "test",
      });
      // Note: no trailing newline
      const input = createInputStream(request);
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should await async handler for buffer without trailing newline", async () => {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "test",
      });
      // Note: no trailing newline
      const input = createInputStream(request);
      const output = createMockOutput();

      let resolved = false;
      const handler = mock<(msg: unknown) => Promise<void>>(async () => {
        await new Promise((r) => setTimeout(r, 20));
        resolved = true;
      });

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      // Handler must have fully resolved (async completed)
      expect(handler).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(true);
    });

    it("should stop reading when close() is called", async () => {
      // Stream that never ends on its own
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const input = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }) + "\n",
            ),
          );
          // Don't close — stream stays open
        },
      });

      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      const startPromise = transport.start(handler);

      // Give the reader a moment to process the chunk
      await new Promise((r) => setTimeout(r, 20));

      transport.close();

      // start() should resolve after close()
      await startPromise;

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge case tests (correcciones Issues 1, 3, 5, 7)
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should isolate handler throws and continue processing subsequent messages", async () => {
      const data =
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "crash" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "valid" }) +
        "\n";

      const input = createInputStream(data);
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>((msg: unknown) => {
        const m = msg as JSONRPCRequest;
        if (m.method === "crash") {
          throw new Error("Handler exploded!");
        }
      });

      const transport = new StdioTransport({ input, output });
      // start() should NOT reject — handler error is isolated
      await transport.start(handler);

      // Both messages were processed: first threw, second was handled normally
      expect(handler).toHaveBeenCalledTimes(2);
      const secondCall = handler.mock.calls[1]![0] as JSONRPCRequest;
      expect(secondCall.method).toBe("valid");
    });

    it("should reassemble a message split across two chunks", async () => {
      // Split a valid JSON-RPC message in the middle across two chunks
      const fullMessage = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "split",
        params: { key: "value" },
      });

      const mid = Math.floor(fullMessage.length / 2);
      const chunk1 = fullMessage.slice(0, mid);
      const chunk2 = fullMessage.slice(mid) + "\n";

      const input = createDelayedInputStream([chunk1, chunk2], 10);
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0]![0] as JSONRPCRequest;
      expect(received.method).toBe("split");
      expect(received.params).toEqual({ key: "value" });
    });

    it("should send invalid_request (-32600) for array-typed id", async () => {
      const input = createInputStream(
        '{"jsonrpc":"2.0","id":[1,2],"method":"test"}\n',
      );
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).not.toHaveBeenCalled();
      expect(output.chunks).toHaveLength(1);

      const response = output.messages[0]!;
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBeNull();
      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toContain("Invalid Request");
    });

    it("should send error with null id via sendError producing valid JSON with id:null", () => {
      const output = createMockOutput();
      const transport = new StdioTransport({ output });

      transport.sendError(null, { code: -32700, message: "Parse error" });

      const raw = output.chunks[0]!;
      // Verify it serializes as JSON with id:null
      const parsed = JSON.parse(raw);
      expect(parsed.id).toBeNull();
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.error.code).toBe(-32700);
    });

    it("should not throw when close() is called multiple times", async () => {
      const input = createInputStream(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }) + "\n",
      );
      const output = createMockOutput();
      const transport = new StdioTransport({ input, output });

      await transport.start(() => {});

      // Double close should not throw
      expect(() => {
        transport.close();
        transport.close();
      }).not.toThrow();
    });

    it("should preserve unicode characters through the full cycle", async () => {
      const unicodeMethod = "méthod_🎉";
      const unicodeParams = { greeting: "hölá 🌍", emoji: "🚀🔧" };
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: unicodeMethod,
        params: unicodeParams,
      });

      const input = createInputStream(request + "\n");
      const output = createMockOutput();
      const handler = mock<(msg: unknown) => void>(() => {});

      const transport = new StdioTransport({ input, output });
      await transport.start(handler);

      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0]![0] as JSONRPCRequest;
      expect(received.method).toBe(unicodeMethod);
      expect(received.params).toEqual(unicodeParams);

      // Also verify round-trip via sendResponse
      transport.sendResponse(1, { echo: unicodeParams });
      const response = output.messages[output.messages.length - 1]!;
      expect(response.result).toEqual({ echo: unicodeParams });
    });
  });
});
