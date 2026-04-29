/**
 * Oversized Mock MCP Server — for testing MAX_LINE_BYTES (SEC-07).
 *
 * Accepts a size argument (in KB) via process.argv[2].
 * - If size >= 1024 (1MB+): sends a giant oversized line BEFORE the real response
 * - If size < 1024: sends a normal-sized response (to test 500KB is OK)
 *
 * For tools/call "echo": sends the oversized line first (if configured),
 * then sends the real valid response.
 *
 * Usage: bun test/mcp/oversized-mock-server.ts <sizeKB>
 */

import { createInterface } from "node:readline";

const sizeKB = parseInt(process.argv[2] ?? "500", 10);
const sizeBytes = sizeKB * 1024;
const isOversized = sizeBytes > 1 * 1024 * 1024; // > 1MB

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function sendResult(id: number | string | null, result: unknown): void {
  sendResponse({ jsonrpc: "2.0", id: id ?? null, result });
}

function sendError(id: number | string | null, code: number, message: string): void {
  sendResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the input concatenated with ' world'",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
];

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "oversized-mcp-server", version: "0.1.0" },
      });
      break;
    }
    case "notifications/initialized":
      break;

    case "tools/list": {
      sendResult(id, { tools: TOOLS });
      break;
    }

    case "tools/call": {
      const params = req.params as { name: string; arguments: Record<string, unknown> };
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (toolName === "echo") {
        const input = typeof args.input === "string" ? args.input : "hello";

        if (isOversized) {
          // Send a giant oversized line first — this should be discarded by the client
          // We send a JSON object with a huge "data" field to make it a valid-looking but oversized line
          const bigData = "X".repeat(sizeBytes);
          // This line is NOT a valid JSON-RPC response for any pending request
          // (id = 99999 which has no pending request), so it won't resolve anything
          // The important thing is the line itself is > MAX_LINE_BYTES
          const oversizedLine = JSON.stringify({ jsonrpc: "2.0", id: 99999, result: { data: bigData } });
          process.stdout.write(oversizedLine + "\n");
          // Small delay to let the client process (and discard) the oversized line
          await new Promise((r) => setTimeout(r, 50));
        }

        // Send the real valid response
        sendResult(id, {
          content: [{ type: "text", text: `${input} world` }],
          isError: false,
        });
      } else {
        sendError(id, -32601, `Tool not found: ${toolName}`);
      }
      break;
    }

    default:
      sendError(id, -32601, `Method not found: ${req.method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }
  handleRequest(req).catch((err: unknown) => {
    process.stderr.write(`[oversized-server] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
});

rl.on("close", () => process.exit(0));

process.stderr.write(`[oversized-server] started, sizeKB=${sizeKB}, isOversized=${isOversized}\n`);
