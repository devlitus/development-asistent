/**
 * Spike client — simulates a basic ACP client for end-to-end testing.
 *
 * Usage:
 *   bun run scripts/spike-client.ts          # Auto-mode: runs the agent and tests the flow
 *   bun run scripts/spike-client.ts --manual  # Only prints the JSON-RPC messages to send
 *
 * This script validates the full ACP flow without requiring Zed:
 *   initialize → session/new → session/prompt → verify response
 */

import { spawn } from "child_process";

const AGENT_COMMAND = ["bun", "run", "src/index.ts"];
const TIMEOUT_MS = 30000;

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function buildRequest(id: number | string, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) }) + "\n";
}

function printManualMode(): void {
  console.error("=== ACP Spike Client (manual mode) ===\n");
  console.error("Send these messages to the agent via stdin (one per line):\n");

  const messages = [
    buildRequest(1, "initialize", { protocolVersion: 1 }),
    buildRequest(2, "session/new", { cwd: "/tmp/spike", mcpServers: [] }),
    // session/prompt will use sessionId from the response
  ];

  for (const msg of messages) {
    console.error(msg.trim());
  }

  console.error("\nThen send session/prompt with the sessionId returned above:");
  console.error(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "<SESSION_ID_FROM_RESPONSE>",
        prompt: [{ type: "text", text: "Hello from spike client!" }],
      },
    }) + "\n",
  );
}

async function runAutoMode(): Promise<void> {
  console.error("=== ACP Spike Client (auto mode) ===\n");

  // Verify API keys are available
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error("Error: No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    process.exit(1);
  }

  const child = spawn(AGENT_COMMAND[0], AGENT_COMMAND.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  const messages: JSONRPCMessage[] = [];
  let buffer = "";
  let sessionId: string | undefined;
  let resolveDone: () => void;
  const donePromise = new Promise<void>((r) => (resolveDone = r));

  child.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const msg = JSON.parse(line) as JSONRPCMessage;
        messages.push(msg);
        console.error(`[spike-client] Received: ${line.trim()}`);

        if (msg.id === 2 && msg.result && typeof msg.result === "object" && "sessionId" in msg.result) {
          sessionId = (msg.result as { sessionId: string }).sessionId;
          console.error(`[spike-client] Got sessionId: ${sessionId}`);

          // Send session/prompt now that we have the sessionId
          const promptMsg = buildRequest(3, "session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Hello from spike client!" }],
          });
          console.error(`[spike-client] Sending: ${promptMsg.trim()}`);
          child.stdin!.write(promptMsg);
        }

        if (msg.id === 3) {
          // Prompt response received — flow complete
          setTimeout(() => {
            child.stdin!.end();
            resolveDone();
          }, 500);
        }
      } catch {
        console.error(`[spike-client] Non-JSON line: ${line}`);
      }
    }
  });

  child.on("exit", (code) => {
    console.error(`[spike-client] Agent exited with code ${code}`);
    resolveDone();
  });

  // Send initialize
  const initMsg = buildRequest(1, "initialize", { protocolVersion: 1 });
  console.error(`[spike-client] Sending: ${initMsg.trim()}`);
  child.stdin!.write(initMsg);

  // Send session/new
  const newSessionMsg = buildRequest(2, "session/new", { cwd: "/tmp/spike", mcpServers: [] });
  console.error(`[spike-client] Sending: ${newSessionMsg.trim()}`);
  child.stdin!.write(newSessionMsg);

  // Wait for completion or timeout
  const timeout = setTimeout(() => {
    console.error("[spike-client] Timeout waiting for responses");
    child.kill();
    resolveDone();
  }, TIMEOUT_MS);

  await donePromise;
  clearTimeout(timeout);

  // Validate flow
  console.error("\n=== Validation ===");

  const initResponse = messages.find((m) => m.id === 1 && m.result);
  if (initResponse) {
    console.error("✅ initialize response received");
  } else {
    console.error("❌ initialize response missing");
    process.exit(1);
  }

  const newSessionResponse = messages.find((m) => m.id === 2 && m.result);
  if (newSessionResponse) {
    console.error("✅ session/new response received");
  } else {
    console.error("❌ session/new response missing");
    process.exit(1);
  }

  const updateNotification = messages.find(
    (m) => m.method === "session/update" &&
      m.params && typeof m.params === "object" &&
      (m.params as Record<string, unknown>).update &&
      typeof (m.params as Record<string, unknown>).update === "object" &&
      (m.params as Record<string, unknown>).update,
  );
  if (updateNotification) {
    console.error("✅ session/update notification received");
  } else {
    console.error("❌ session/update notification missing");
    process.exit(1);
  }

  const promptResponse = messages.find((m) => m.id === 3 && m.result);
  if (promptResponse) {
    console.error("✅ session/prompt response received");
    const stopReason = (promptResponse.result as { stopReason?: string })?.stopReason;
    if (stopReason === "end_turn") {
      console.error("✅ stopReason is 'end_turn'");
    } else {
      console.error(`❌ unexpected stopReason: ${stopReason}`);
      process.exit(1);
    }
  } else {
    console.error("❌ session/prompt response missing");
    process.exit(1);
  }

  console.error("\n🎉 Spike client: ALL CHECKS PASSED");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--manual")) {
    printManualMode();
  } else {
    await runAutoMode();
  }
}

main().catch((err) => {
  console.error("[spike-client] Fatal error:", err);
  process.exit(1);
});
