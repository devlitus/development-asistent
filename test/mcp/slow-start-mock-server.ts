/**
 * Slow-start MCP Mock Server — delays startup by N ms before responding.
 *
 * Used to test parallel startup timing in MCPToolRegistry.
 *
 * Usage: bun test/mcp/slow-start-mock-server.ts <delayMs>
 */

import { createInterface } from "node:readline";

const delayMs = parseInt(process.argv[2] ?? "300", 10);

// Simulate slow startup by waiting before processing requests
await new Promise((resolve) => setTimeout(resolve, delayMs));

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

const TOOLS = [
  {
    name: "slow_echo",
    description: "Echo tool from slow-start server",
    inputSchema: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  },
];

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function sendResult(id: number | string | null, result: unknown): void {
  sendResponse({ jsonrpc: "2.0", id: id ?? null, result });
}

function sendError(id: number | string | null, code: number, message: string): void {
  sendResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "slow-mock-server", version: "0.1.0" },
      });
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const params = req.params as { name: string; arguments: Record<string, unknown> };
      if (params?.name === "slow_echo") {
        const input = params.arguments?.input ?? "";
        sendResult(id, { content: [{ type: "text", text: `${input} world` }], isError: false });
      } else {
        sendError(id, -32601, `Tool not found: ${params?.name}`);
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
    process.stderr.write(`[slow-mock-server] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
});

rl.on("close", () => process.exit(0));

process.stderr.write(`[slow-mock-server] started after ${delayMs}ms delay\n`);
