/**
 * Stderr Mock MCP Server — for testing MAX_STDERR_BYTES (SEC-09).
 *
 * Accepts a mode argument via process.argv[2]:
 *   - A number (bytes): writes that many bytes to stderr immediately on start
 *   - "secret": writes a line containing an API key to stderr
 *
 * Usage: bun test/mcp/stderr-mock-server.ts <bytes|secret>
 */

import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "1024";

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

// Emit stderr content immediately on startup
if (mode === "secret") {
  // Write a line with a fake API key that should be redacted
  process.stderr.write("Error: API key sk-ant-api03-supersecretkey1234567890 is invalid\n");
} else {
  const bytes = parseInt(mode, 10);
  if (!isNaN(bytes) && bytes > 0) {
    // Write `bytes` bytes of 'X' to stderr in chunks
    const chunkSize = 1024;
    let remaining = bytes;
    while (remaining > 0) {
      const toWrite = Math.min(chunkSize, remaining);
      process.stderr.write("X".repeat(toWrite));
      remaining -= toWrite;
    }
    process.stderr.write("\n");
  }
}

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the input",
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
        serverInfo: { name: "stderr-mcp-server", version: "0.1.0" },
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
      const input = typeof params?.arguments?.input === "string" ? params.arguments.input : "hello";
      sendResult(id, {
        content: [{ type: "text", text: `${input} world` }],
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
    process.stderr.write(`[stderr-server] Error: ${err instanceof Error ? err.message : String(err)}\n`);
  });
});

rl.on("close", () => process.exit(0));
