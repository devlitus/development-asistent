/**
 * Many-Tools Mock MCP Server — for testing MAX_TOOLS_PER_SERVER (SEC-08).
 *
 * Accepts a count argument via process.argv[2].
 * Registers that many tools named "tool_0", "tool_1", ..., "tool_N".
 *
 * Usage: bun test/mcp/many-tools-mock-server.ts <count>
 */

import { createInterface } from "node:readline";

const toolCount = parseInt(process.argv[2] ?? "10", 10);

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

// Generate N tools
const TOOLS = Array.from({ length: toolCount }, (_, i) => ({
  name: `tool_${i}`,
  description: `Tool number ${i}`,
  inputSchema: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
  },
}));

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "many-tools-mcp-server", version: "0.1.0" },
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
      const input = typeof args.input === "string" ? args.input : "hello";
      // All tools just echo
      sendResult(id, {
        content: [{ type: "text", text: `${toolName}: ${input}` }],
        isError: false,
      });
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
    process.stderr.write(`[many-tools-server] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
});

rl.on("close", () => process.exit(0));

process.stderr.write(`[many-tools-server] started with ${toolCount} tools\n`);
