/**
 * MCP Mock Server — minimal MCP server for testing.
 *
 * Implements the MCP protocol over stdio (NDJSON JSON-RPC 2.0).
 * Responds to: initialize, notifications/initialized, tools/list, tools/call
 *
 * Tool provided:
 *   - echo(input: string) → returns `${input} world`
 *   - slow_tool(input: string) → waits 10 seconds (for timeout testing)
 *
 * Usage: bun test/mcp/mock-server.ts
 *
 * IMPORTANT: All log output goes to stderr. stdout is reserved for JSON-RPC.
 */

import { createInterface } from "node:readline";

// ─── Types ────────────────────────────────────────────────────────

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

// ─── Tool definitions ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the input concatenated with ' world'",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The string to echo" },
      },
      required: ["input"],
    },
  },
  {
    name: "slow_tool",
    description: "A tool that takes a long time to respond (for timeout testing)",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "Input value" },
      },
      required: ["input"],
    },
  },
];

// ─── Response helpers ─────────────────────────────────────────────

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function sendResult(id: number | string | null, result: unknown): void {
  sendResponse({ jsonrpc: "2.0", id: id ?? null, result });
}

function sendError(
  id: number | string | null,
  code: number,
  message: string,
): void {
  sendResponse({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

// ─── Request handlers ─────────────────────────────────────────────

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  switch (req.method) {
    case "initialize": {
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp-server", version: "0.1.0" },
      });
      break;
    }

    case "notifications/initialized": {
      // Notification — no response expected
      break;
    }

    case "tools/list": {
      sendResult(id, { tools: TOOLS });
      break;
    }

    case "tools/call": {
      const params = req.params as {
        name: string;
        arguments: Record<string, unknown>;
      };

      if (!params || typeof params.name !== "string") {
        sendError(id, -32602, "Invalid params: missing tool name");
        break;
      }

      const toolName = params.name;
      const args = params.arguments ?? {};

      if (toolName === "echo") {
        const input = args.input;
        if (typeof input !== "string") {
          sendError(id, -32602, "Invalid params: 'input' must be a string");
          break;
        }
        sendResult(id, {
          content: [{ type: "text", text: `${input} world` }],
          isError: false,
        });
      } else if (toolName === "slow_tool") {
        // Wait 10 seconds — used to test timeout handling
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        sendResult(id, {
          content: [{ type: "text", text: "slow response" }],
          isError: false,
        });
      } else {
        sendError(id, -32601, `Tool not found: ${toolName}`);
      }
      break;
    }

    default: {
      sendError(id, -32601, `Method not found: ${req.method}`);
      break;
    }
  }
}

// ─── Main loop ────────────────────────────────────────────────────

const rl = createInterface({
  input: process.stdin,
  terminal: false,
});

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
    process.stderr.write(
      `[mock-server] Error handling request: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
});

rl.on("close", () => {
  process.exit(0);
});

process.stderr.write("[mock-server] MCP mock server started\n");
