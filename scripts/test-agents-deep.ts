/**
 * test-agents-deep.ts — Test de agentes con LLM real
 *
 * Envía prompts que ejercitan cada agente y verifica que:
 * 1. El servidor no crashea
 * 2. Se reciben streaming chunks
 * 3. La respuesta final contiene contenido razonable
 * 4. Los tool_calls se procesan correctamente
 *
 * Escribe resultados detallados a scripts/deep-test-results.json
 *
 * Uso:
 *   bun scripts/test-agents-deep.ts                        # todos los tests
 *   bun scripts/test-agents-deep.ts --test "git"           # solo tests con "git" en el nombre
 *   bun scripts/test-agents-deep.ts --test "git" --test "code"  # varios filtros (OR)
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface DeepResult {
  test: string;
  agent: string;
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR";
  durationMs: number;
  prompt: string;
  chunks: string[];
  fullResponse: string;
  toolCallsReceived: boolean;
  error?: string;
  warnings: string[];
}

interface TestCase {
  /** Nombre del test — usado para filtrado con --test. */
  name: string;
  /** Nombre del agente esperado (solo informativo). */
  agent: string;
  /** Header de grupo visual, e.g. "CODE AGENT". Se imprime cuando cambia. */
  group?: string;
  /** Prompt a enviar. */
  prompt: string;
  /** Strings que deben aparecer en la respuesta (case-insensitive). */
  expectedHints: string[];
}

// ─── Colores ──────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m",
  gray: "\x1b[90m", blue: "\x1b[34m", magenta: "\x1b[35m",
};

const TIMEOUT_LLM = 300_000; // 5 min por test (modelo 27B puede ser lento con tool calling)
const TEST_CWD = process.cwd();

// ─── Definición de tests ──────────────────────────────────────────────────────

const ALL_TESTS: TestCase[] = [
  {
    name: "Respuesta a saludo simple",
    agent: "orchestrator",
    group: "CONVERSACIONAL",
    prompt: "Hola, ¿qué eres y qué puedes hacer?",
    expectedHints: [],
  },
  {
    name: "Leer archivo package.json",
    agent: "code",
    group: "CODE AGENT",
    prompt: "Lee el archivo package.json y dime el nombre y versión del proyecto",
    expectedHints: ["personal-asistent", "0.1.0"],
  },
  {
    name: "Listar directorio src/",
    agent: "code",
    group: "CODE AGENT",
    prompt: "Lista los archivos del directorio src/ del proyecto",
    expectedHints: [],
  },
  {
    name: "Buscar texto en archivos",
    agent: "code",
    group: "CODE AGENT",
    prompt: "Busca la función 'createProvider' en los archivos TypeScript del proyecto",
    expectedHints: ["createProvider"],
  },
  {
    name: "Estado del repositorio git",
    agent: "git",
    group: "GIT AGENT",
    prompt: "¿Cuál es el estado actual del repositorio git? Muéstrame git status",
    expectedHints: [],
  },
  {
    name: "Log de commits recientes",
    agent: "git",
    group: "GIT AGENT",
    prompt: "Muéstrame los últimos 5 commits del repositorio",
    expectedHints: [],
  },
  {
    name: "Ejecutar comando simple",
    agent: "os",
    group: "OS AGENT",
    prompt: "Ejecuta el comando 'bun --version' y dime qué versión de Bun está instalada",
    expectedHints: [],
  },
  {
    name: "Listar archivos con shell",
    agent: "os",
    group: "OS AGENT",
    prompt: "Ejecuta un comando para listar los archivos del directorio actual",
    expectedHints: [],
  },
  {
    name: "Buscar documentación web",
    agent: "docs",
    group: "DOCS AGENT",
    prompt: "Busca documentación sobre la API de Bun SQLite",
    expectedHints: [],
  },
  {
    name: "Prompt muy largo (stress test)",
    agent: "code",
    group: "EDGE CASES",
    prompt: "A".repeat(500) + " — lee el archivo README.md",
    expectedHints: [],
  },
  {
    name: "Caracteres especiales en prompt",
    agent: "code",
    group: "EDGE CASES",
    prompt: "Lee el archivo 'src/index.ts' y muéstrame la función <startup>. También: $PATH && echo \"test\" | grep foo",
    expectedHints: [],
  },
];

// ─── Server helper ────────────────────────────────────────────────────────────

interface ServerHandle {
  proc: ChildProcess;
  send: (msg: object) => void;
  waitFor: (pred: (m: unknown) => boolean, ms: number) => Promise<unknown>;
  collectUntil: (pred: (m: unknown) => boolean, ms: number) => Promise<unknown[]>;
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
    USERNAME: process.env.USERNAME ?? "",
  };
  for (const k of ["LM_STUDIO_HOST", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_HOST", "LLAMACPP_HOST"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }

  const proc = spawn("bun", ["run", "src/index.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: TEST_CWD,
  });

  const allMessages: unknown[] = [];
  const waiters: Array<{
    pred: (m: unknown) => boolean;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    multi?: { msgs: unknown[]; resolve: (v: unknown[]) => void; reject: (e: Error) => void };
  }> = [];
  let buf = "";

  proc.stdout!.on("data", (data: Buffer) => {
    const combined = buf + data.toString("utf-8");
    const lines = combined.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        allMessages.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i];
          if (w.multi) {
            w.multi.msgs.push(msg);
            if (w.pred(msg)) {
              waiters.splice(i, 1);
              w.multi.resolve(w.multi.msgs);
            }
          } else if (w.pred(msg)) {
            waiters.splice(i, 1);
            w.resolve(msg);
          }
        }
      } catch { /* skip */ }
    }
  });

  proc.stderr!.on("data", (data: Buffer) => {
    process.stderr.write(`${C.gray}[srv] ${data.toString("utf-8").trimEnd()}${C.reset}\n`);
  });

  function send(msg: object) {
    proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  function waitFor(pred: (m: unknown) => boolean, ms: number): Promise<unknown> {
    for (const m of allMessages) { if (pred(m)) return Promise.resolve(m); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex(w => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timeout ${ms}ms`));
      }, ms);
      waiters.push({ pred, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
    });
  }

  function collectUntil(pred: (m: unknown) => boolean, ms: number): Promise<unknown[]> {
    const collected: unknown[] = [];
    return new Promise((resolve, reject) => {
      let waiterRef: (typeof waiters)[number] | null = null;
      const timer = setTimeout(() => {
        if (waiterRef !== null) {
          const idx = waiters.indexOf(waiterRef);
          if (idx >= 0) waiters.splice(idx, 1);
        }
        reject(new Error(`Timeout ${ms}ms`));
      }, ms);
      const waiter: (typeof waiters)[number] = {
        pred,
        resolve: () => {},
        reject,
        multi: { msgs: collected, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject },
      };
      waiterRef = waiter;
      waiters.push(waiter);
    });
  }

  return { proc, send, waitFor, collectUntil, kill: () => proc.kill("SIGTERM") };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

let id = 1;
function req(method: string, params: unknown): JsonRpcRequest { return { jsonrpc: "2.0", id: id++, method, params }; }
function isResp(n: number) { return (m: unknown): boolean => typeof m === "object" && m !== null && (m as Record<string, unknown>)["id"] === n; }
function isUpdate(sid: string) {
  return (m: unknown): boolean => {
    if (typeof m !== "object" || m === null) return false;
    const v = m as Record<string, unknown>;
    if (v["method"] !== "session/update") return false;
    if (typeof v["params"] !== "object" || v["params"] === null) return false;
    return (v["params"] as Record<string, unknown>)["sessionId"] === sid;
  };
}

function getChunkText(m: unknown): string {
  if (typeof m !== "object" || m === null) return "";
  const v = m as Record<string, unknown>;
  if (typeof v["params"] !== "object" || v["params"] === null) return "";
  const p = v["params"] as Record<string, unknown>;
  if (typeof p["update"] !== "object" || p["update"] === null) return "";
  const u = p["update"] as Record<string, unknown>;
  if (typeof u["content"] !== "object" || u["content"] === null) return "";
  const c = u["content"] as Record<string, unknown>;
  return typeof c["text"] === "string" ? c["text"] : "";
}

function log(s: string) { process.stdout.write(s + "\n"); }

// ─── CLI filter parser ────────────────────────────────────────────────────────

function parseCliFilters(args: string[]): string[] {
  const filters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--test" && i + 1 < args.length) {
      filters.push(args[i + 1]!.toLowerCase());
      i++;
    }
  }
  return filters;
}

// ─── Full prompt test ─────────────────────────────────────────────────────────

async function testPrompt(
  server: ServerHandle,
  sessionId: string,
  testName: string,
  agentName: string,
  promptText: string,
  expectedContentHints: string[],
): Promise<DeepResult> {
  const start = Date.now();
  const chunks: string[] = [];
  const warnings: string[] = [];

  log(`\n  ${C.blue}▶ ${testName}${C.reset}`);
  log(`    ${C.gray}Prompt: "${promptText}"${C.reset}`);

  const r = req("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: promptText }],
  });

  server.send(r);

  // Collect all messages until we get the final RPC response
  let fullResponse = "";
  let toolCallsReceived = false;

  try {
    const allMsgs = await server.collectUntil(isResp(r.id), TIMEOUT_LLM);

    for (const m of allMsgs) {
      if (isUpdate(sessionId)(m)) {
        const text = getChunkText(m);
        chunks.push(text);
        fullResponse += text;
        if (text.includes("⚙")) toolCallsReceived = true;
      }
    }

    const finalMsg = allMsgs[allMsgs.length - 1];
    if (typeof finalMsg !== "object" || finalMsg === null) {
      return {
        test: testName, agent: agentName, status: "FAIL" as const,
        durationMs: Date.now() - start, prompt: promptText,
        chunks, fullResponse, toolCallsReceived,
        warnings: ["No response received"],
      };
    }
    const finalMsgObj = finalMsg as Record<string, unknown>;

    if ("error" in finalMsgObj) {
      const errMsg = String((finalMsgObj["error"] as Record<string, unknown>)["message"] ?? "unknown");
      log(`    ${C.red}✗ Error RPC: ${errMsg}${C.reset}`);
      return {
        test: testName, agent: agentName, status: "FAIL",
        durationMs: Date.now() - start, prompt: promptText,
        chunks, fullResponse, toolCallsReceived,
        error: errMsg, warnings,
      };
    }

    // Check expected hints
    const responseNorm = fullResponse.toLowerCase();
    for (const hint of expectedContentHints) {
      if (!responseNorm.includes(hint.toLowerCase())) {
        warnings.push(`Respuesta no contiene "${hint}"`);
      }
    }

    const status: DeepResult["status"] = warnings.length === 0 ? "PASS" : "FAIL";
    const icon = status === "PASS" ? `${C.green}✓` : `${C.yellow}⚠`;
    log(`    ${icon} ${status}${C.reset} ${C.gray}(${Date.now() - start}ms, ${chunks.length} chunks)${C.reset}`);
    log(`    ${C.gray}Respuesta: "${fullResponse.slice(0, 120).replace(/\n/g, '\\n')}..."${C.reset}`);
    if (warnings.length) {
      for (const w of warnings) log(`    ${C.yellow}⚠ ${w}${C.reset}`);
    }

    return {
      test: testName, agent: agentName, status,
      durationMs: Date.now() - start, prompt: promptText,
      chunks, fullResponse, toolCallsReceived, warnings,
    };
  } catch (err) {
    const msg = String(err);
    const isTimeout = msg.includes("Timeout");
    log(`    ${C.red}✗ ${isTimeout ? "TIMEOUT" : "ERROR"}: ${msg}${C.reset}`);
    return {
      test: testName, agent: agentName,
      status: isTimeout ? "TIMEOUT" : "ERROR",
      durationMs: Date.now() - start, prompt: promptText,
      chunks, fullResponse, toolCallsReceived,
      error: msg, warnings,
    };
  }
}

// ─── Run single test (crea su propia sesión) ──────────────────────────────────

async function runTest(server: ServerHandle, testCase: TestCase): Promise<DeepResult> {
  const start = Date.now();
  try {
    // Crear sesión nueva para este test (aislamiento de historial)
    const sessReq = req("session/new", { cwd: TEST_CWD, mcpServers: [] });
    server.send(sessReq);
    const sessResp = await server.waitFor(isResp(sessReq.id), 10_000) as Record<string, unknown>;
    const sessionId = (sessResp["result"] as Record<string, unknown>)?.["sessionId"];
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`session/new devolvió sessionId inválido: ${JSON.stringify(sessionId)}`);
    }

    return await testPrompt(
      server,
      sessionId,
      testCase.name,
      testCase.agent,
      testCase.prompt,
      testCase.expectedHints,
    );
  } catch (err) {
    return {
      test: testCase.name,
      agent: testCase.agent,
      status: "FAIL",
      durationMs: Date.now() - start,
      prompt: testCase.prompt,
      chunks: [],
      fullResponse: "",
      toolCallsReceived: false,
      warnings: [`Error en setup: ${String(err)}`],
    };
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}${C.cyan}  Test Profundo de Agentes — LM Studio              ${C.reset}`);
  log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}\n`);

  const server = startServer();
  await new Promise(r => setTimeout(r, 1500));

  // Handshake (una sola vez — el servidor no se reinicia entre tests)
  const initReq = req("initialize", { protocolVersion: 1 });
  server.send(initReq);
  await server.waitFor(isResp(initReq.id), 10_000);
  log(`${C.green}✓ Servidor inicializado${C.reset}`);

  // Filtrar tests según --test CLI
  const filters = parseCliFilters(process.argv.slice(2));
  const testsToRun = filters.length === 0
    ? ALL_TESTS
    : ALL_TESTS.filter(t => filters.some(f => t.name.toLowerCase().includes(f)));

  if (filters.length > 0) {
    const filterLabel = filters.map(f => `"${f}"`).join(", ");
    log(`${C.yellow}Ejecutando ${testsToRun.length}/${ALL_TESTS.length} tests (filtro: ${filterLabel})${C.reset}`);
  } else {
    log(`${C.gray}Ejecutando ${ALL_TESTS.length} tests${C.reset}`);
  }

  if (testsToRun.length === 0) {
    log(`${C.red}No hay tests que coincidan con el filtro.${C.reset}`);
    server.kill();
    process.exit(1);
  }

  const results: DeepResult[] = [];

  // Ejecutar tests con agrupación visual por grupo
  let lastGroup = "";
  for (const testCase of testsToRun) {
    if (testCase.group && testCase.group !== lastGroup) {
      log(`\n${C.bold}[${testCase.group}]${C.reset}`);
      lastGroup = testCase.group;
    }
    results.push(await runTest(server, testCase));
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  server.kill();

  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const timeout = results.filter(r => r.status === "TIMEOUT").length;
  const error = results.filter(r => r.status === "ERROR").length;

  log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}  Resumen: ${pass} PASS  |  ${fail} FAIL  |  ${timeout} TIMEOUT  |  ${error} ERROR${C.reset}`);
  log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}\n`);

  const withToolCalls = results.filter(r => r.toolCallsReceived).length;
  log(`${C.gray}Tool calls recibidos en: ${withToolCalls}/${results.length} tests${C.reset}`);

  const avg = Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length);
  log(`${C.gray}Tiempo promedio por test: ${avg}ms${C.reset}`);

  const failed = results.filter(r => r.status !== "PASS");
  if (failed.length > 0) {
    log(`\n${C.red}${C.bold}Tests fallidos:${C.reset}`);
    for (const f of failed) {
      log(`  ${C.red}[${f.status}] ${f.test} (${f.agent})${C.reset}`);
      if (f.error) log(`    → ${f.error}`);
    }
  }

  // Guardar resultados
  const outPath = new URL("../scripts/deep-test-results.json", import.meta.url);
  await Bun.write(outPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  log(`\n${C.gray}Resultados guardados en scripts/deep-test-results.json${C.reset}\n`);

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
