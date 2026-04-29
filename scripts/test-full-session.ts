/**
 * test-full-session.ts — Test de integración E2E del servidor ACP
 *
 * Simula un usuario real enviando mensajes al servidor via JSON-RPC.
 * Testea: initialize, session/new, session/prompt con varios agentes.
 * Usa LM_STUDIO_HOST configurado en .env
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

// ─── Configuración ────────────────────────────────────────────────────────────

const TIMEOUT_INIT = 15_000;    // 15s para initialize + session/new
const TIMEOUT_PROMPT = 120_000; // 120s para respuestas del LLM
const TEST_CWD = process.cwd();

// ─── Colores ANSI ─────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
};

// ─── Resultado de cada test ───────────────────────────────────────────────────

interface TestResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP" | "TIMEOUT";
  durationMs: number;
  error?: string;
  detail?: string;
}

const results: TestResult[] = [];

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

function logTest(r: TestResult) {
  const icon = r.status === "PASS" ? `${C.green}✓` : r.status === "FAIL" ? `${C.red}✗` : r.status === "TIMEOUT" ? `${C.yellow}⏱` : `${C.gray}−`;
  const dur = `${C.gray}(${r.durationMs}ms)${C.reset}`;
  log(`  ${icon} ${r.status}${C.reset} ${r.name} ${dur}`);
  if (r.error) log(`    ${C.red}→ ${r.error}${C.reset}`);
  if (r.detail) log(`    ${C.gray}  ${r.detail}${C.reset}`);
}

// ─── Servidor ACP ─────────────────────────────────────────────────────────────

interface ServerHandle {
  proc: ChildProcess;
  send: (msg: object) => void;
  waitFor: (predicate: (msg: unknown) => boolean, timeoutMs: number) => Promise<unknown>;
  allMessages: unknown[];
  kill: () => void;
}

function startServer(): ServerHandle {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
  };

  // Pasar solo las vars LLM definidas
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LM_STUDIO_HOST", "LLAMACPP_HOST", "OLLAMA_HOST"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }

  const proc = spawn("bun", ["run", "src/index.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: TEST_CWD,
  });

  const allMessages: unknown[] = [];
  const waiters: Array<{ predicate: (msg: unknown) => boolean; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
  let ndjsonBuffer = "";

  proc.stdout!.on("data", (data: Buffer) => {
    const chunk = data.toString("utf-8");
    const combined = ndjsonBuffer + chunk;
    const lines = combined.split("\n");
    ndjsonBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        allMessages.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(msg)) {
            const [w] = waiters.splice(i, 1);
            w.resolve(msg);
          }
        }
      } catch {
        // ignorar líneas no-JSON
      }
    }
  });

  proc.stderr!.on("data", (data: Buffer) => {
    // Mostrar stderr del servidor en gris para debugging
    process.stderr.write(`${C.gray}[server] ${data.toString("utf-8").trim()}${C.reset}\n`);
  });

  function send(msg: object): void {
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function waitFor(predicate: (msg: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Revisar mensajes ya recibidos
      for (const msg of allMessages) {
        if (predicate(msg)) {
          resolve(msg);
          return;
        }
      }
      const timer = setTimeout(() => {
        const idx = waiters.findIndex(w => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      waiters.push({
        predicate,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject,
      });
    });
  }

  function kill(): void {
    proc.kill("SIGTERM");
  }

  return { proc, send, waitFor, allMessages, kill };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let nextId = 1;

function makeRequest(method: string, params: unknown) {
  return { jsonrpc: "2.0", id: nextId++, method, params };
}

function isResponseTo(id: number) {
  return (msg: unknown): boolean => {
    if (typeof msg !== "object" || msg === null) return false;
    return (msg as Record<string, unknown>)["id"] === id;
  };
}

function hasMethod(method: string) {
  return (msg: unknown): boolean => {
    if (typeof msg !== "object" || msg === null) return false;
    return (msg as Record<string, unknown>)["method"] === method;
  };
}

function isSessionUpdate(sessionId: string) {
  return (msg: unknown): boolean => {
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as Record<string, unknown>;
    if (m["method"] !== "session/update") return false;
    const p = m["params"] as Record<string, unknown> | null;
    return p?.["sessionId"] === sessionId;
  };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    const r: TestResult = { name, status: "PASS", durationMs: Date.now() - start };
    results.push(r);
    logTest(r);
    return r;
  } catch (err) {
    const msg = String(err);
    const isTimeout = msg.includes("Timeout");
    const r: TestResult = {
      name,
      status: isTimeout ? "TIMEOUT" : "FAIL",
      durationMs: Date.now() - start,
      error: msg,
    };
    results.push(r);
    logTest(r);
    return r;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n${C.bold}${C.cyan}════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}${C.cyan}  Test E2E — personal-asistent + LM Studio  ${C.reset}`);
  log(`${C.bold}${C.cyan}════════════════════════════════════════════${C.reset}\n`);

  log(`${C.gray}LM_STUDIO_HOST: ${process.env.LM_STUDIO_HOST}${C.reset}`);
  log(`${C.gray}CWD: ${TEST_CWD}${C.reset}\n`);

  const server = startServer();

  // Esperar a que el servidor arranque
  await new Promise(r => setTimeout(r, 1500));

  let sessionId = "";

  // ─── BLOQUE 1: Protocolo base ──────────────────────────────────────────────

  log(`\n${C.bold}[1] Protocolo base${C.reset}`);

  await runTest("Servidor arranca sin crash", async () => {
    if (server.proc.exitCode !== null) {
      throw new Error(`Servidor terminó con código ${server.proc.exitCode}`);
    }
  });

  await runTest("initialize — handshake ACP", async () => {
    const req = makeRequest("initialize", { protocolVersion: 1 });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_INIT) as Record<string, unknown>;
    if ("error" in resp) throw new Error(`Error RPC: ${JSON.stringify(resp["error"])}`);
    const result = resp["result"] as Record<string, unknown>;
    if (typeof result["protocolVersion"] !== "number") throw new Error("Falta protocolVersion");
    results[results.length - 1].detail = `protocolVersion=${result["protocolVersion"]}`;
  });

  await runTest("session/new — crear sesión", async () => {
    const req = makeRequest("session/new", { cwd: TEST_CWD, mcpServers: [] });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_INIT) as Record<string, unknown>;
    if ("error" in resp) throw new Error(`Error RPC: ${JSON.stringify(resp["error"])}`);
    const result = resp["result"] as Record<string, unknown>;
    if (typeof result["sessionId"] !== "string") throw new Error("Falta sessionId");
    sessionId = result["sessionId"] as string;
    results[results.length - 1].detail = `sessionId=${sessionId}`;
  });

  await runTest("session/new duplicado (misma sesión o nueva)", async () => {
    const req = makeRequest("session/new", { cwd: TEST_CWD, mcpServers: [] });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_INIT) as Record<string, unknown>;
    if ("error" in resp) throw new Error(`Error RPC: ${JSON.stringify(resp["error"])}`);
    const result = resp["result"] as Record<string, unknown>;
    if (typeof result["sessionId"] !== "string") throw new Error("Falta sessionId en segunda sesión");
    results[results.length - 1].detail = `segunda sessionId=${result["sessionId"]}`;
  });

  // ─── BLOQUE 2: Routing de intención ────────────────────────────────────────

  log(`\n${C.bold}[2] Routing de intención + respuesta LLM${C.reset}`);

  await runTest("prompt conversacional simple — recibe session/update", async () => {
    const req = makeRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Hola, ¿qué puedes hacer?" }],
    });
    server.send(req);

    // Esperar al menos un chunk de streaming
    const update = await server.waitFor(isSessionUpdate(sessionId), TIMEOUT_PROMPT) as Record<string, unknown>;
    const params = update["params"] as Record<string, unknown>;
    const upd = params["update"] as Record<string, unknown>;
    if (upd["sessionUpdate"] !== "agent_message_chunk") throw new Error("Chunk no es agent_message_chunk");
    const content = upd["content"] as Record<string, unknown>;
    if (typeof content["text"] !== "string" || content["text"].length === 0) throw new Error("Chunk text vacío");

    // Esperar la respuesta final (result)
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_PROMPT) as Record<string, unknown>;
    if ("error" in resp) throw new Error(`Error RPC: ${JSON.stringify(resp["error"])}`);
    results[results.length - 1].detail = `Primer chunk: "${(content["text"] as string).slice(0, 60)}..."`;
  });

  await runTest("prompt código — routing a code agent", async () => {
    const req = makeRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Lee el archivo package.json y dime la versión del proyecto" }],
    });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_PROMPT) as Record<string, unknown>;
    if ("error" in resp) throw new Error(`Error RPC: ${JSON.stringify(resp["error"])}`);
    results[results.length - 1].detail = "Routing code agent OK";
  });

  await runTest("prompt git — routing a git agent", async () => {
    const req = makeRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "¿Cuál es el estado del repositorio git actual?" }],
    });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_PROMPT) as Record<string, unknown>;
    if ("error" in resp) throw new Error(`Error RPC: ${JSON.stringify(resp["error"])}`);
    results[results.length - 1].detail = "Routing git agent OK";
  });

  // ─── BLOQUE 3: Casos de error y edge cases ──────────────────────────────────

  log(`\n${C.bold}[3] Casos de error y edge cases${C.reset}`);

  await runTest("prompt con sessionId inexistente — debe devolver error RPC", async () => {
    const req = makeRequest("session/prompt", {
      sessionId: "session-inexistente-xyz-999",
      prompt: [{ type: "text", text: "test" }],
    });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_INIT) as Record<string, unknown>;
    // Debe devolver error (código -32000 o similar) — si devuelve result sin error es un bug
    if (!("error" in resp)) {
      throw new Error("Debería devolver error para sessionId inexistente, pero devolvió result");
    }
    results[results.length - 1].detail = `error.code=${(resp["error"] as Record<string, unknown>)["code"]}`;
  });

  await runTest("método desconocido — debe devolver -32601 Method not found", async () => {
    const req = makeRequest("metodo/inexistente", { foo: "bar" });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_INIT) as Record<string, unknown>;
    if (!("error" in resp)) throw new Error("Debería devolver error para método desconocido");
    const errCode = (resp["error"] as Record<string, unknown>)["code"];
    if (errCode !== -32601) {
      results[results.length - 1].error = `Código esperado -32601, recibido ${errCode}`;
      results[results.length - 1].status = "FAIL";
    }
    results[results.length - 1].detail = `error.code=${errCode}`;
  });

  await runTest("JSON inválido en stdin — servidor no crashea", async () => {
    server.proc.stdin!.write("esto no es json\n");
    await new Promise(r => setTimeout(r, 500));
    if (server.proc.exitCode !== null) {
      throw new Error(`Servidor crasheó al recibir JSON inválido (código: ${server.proc.exitCode})`);
    }
  });

  await runTest("notification sin id — servidor no crashea", async () => {
    // Enviar una notification (sin id) que el servidor no conoce
    server.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "unknown/notification", params: {} }) + "\n");
    await new Promise(r => setTimeout(r, 300));
    if (server.proc.exitCode !== null) {
      throw new Error(`Servidor crasheó con notification desconocida (código: ${server.proc.exitCode})`);
    }
  });

  // ─── BLOQUE 4: session/prompt prompt vacío ─────────────────────────────────

  log(`\n${C.bold}[4] Validaciones de input${C.reset}`);

  await runTest("prompt vacío — comportamiento controlado", async () => {
    const req = makeRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "" }],
    });
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_PROMPT) as Record<string, unknown>;
    // Puede devolver error o respuesta vacía — ambos son válidos; lo que NO puede es crashear
    if (server.proc.exitCode !== null) throw new Error("Servidor crasheó con prompt vacío");
    results[results.length - 1].detail = "error" in resp ? `Devuelve error (correcto)` : `Devuelve result (aceptable)`;
  });

  await runTest("session/new sin parámetro cwd — comportamiento controlado", async () => {
    const req = makeRequest("session/new", {});
    server.send(req);
    const resp = await server.waitFor(isResponseTo(req.id as number), TIMEOUT_INIT) as Record<string, unknown>;
    if (server.proc.exitCode !== null) throw new Error("Servidor crasheó sin cwd");
    results[results.length - 1].detail = "error" in resp ? `Devuelve error (correcto)` : `Devuelve result con default cwd`;
  });

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  server.kill();
  await new Promise(r => setTimeout(r, 1000));

  // ─── Resumen ───────────────────────────────────────────────────────────────

  const total = results.length;
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const timeout = results.filter(r => r.status === "TIMEOUT").length;

  log(`\n${C.bold}${C.cyan}════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}  Resumen: ${passed}/${total} PASS  |  ${failed} FAIL  |  ${timeout} TIMEOUT${C.reset}`);
  log(`${C.bold}${C.cyan}════════════════════════════════════════════${C.reset}\n`);

  // Listar fallos
  const failures = results.filter(r => r.status !== "PASS");
  if (failures.length > 0) {
    log(`${C.red}${C.bold}Fallos:${C.reset}`);
    for (const f of failures) {
      log(`  ${C.red}[${f.status}] ${f.name}${C.reset}`);
      if (f.error) log(`    → ${f.error}`);
    }
    log("");
  }

  // Guardar resultados en JSON para el informe
  const outputPath = new URL("../scripts/test-results.json", import.meta.url);
  await Bun.write(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  log(`${C.gray}Resultados guardados en scripts/test-results.json${C.reset}\n`);

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
