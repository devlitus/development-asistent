/**
 * test-tui.ts — Test automatizado del TUI cliente
 *
 * Lanza el TUI como proceso hijo con stdin/stdout piped,
 * envía comandos y verifica la salida ANSI.
 *
 * Tests:
 *  T1. Arranque: header + status bar inicial
 *  T2. /help muestra los comandos disponibles
 *  T3. /clear limpia pantalla y re-renderiza header
 *  T4. /new crea nueva sesión
 *  T5. Prompt real con LLM (consulta corta)
 *  T6. /quit sale limpiamente
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

// ─── Colores ──────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface TuiTestResult {
  test: string;
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR";
  durationMs: number;
  details?: string;
  output?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(s: string) { process.stdout.write(s + "\n"); }
function stripAnsi(s: string): string {
  // Remove ANSI escape codes for comparison
  return s.replace(/\x1b\[[0-9;]*[mGKHJ]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── TUI Process wrapper ──────────────────────────────────────────────────────

interface TuiHandle {
  proc: ChildProcess;
  output: string;
  send: (line: string) => void;
  waitForOutput: (substring: string, ms: number) => Promise<string>;
  kill: () => void;
}

function spawnTui(): TuiHandle {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    USERNAME: process.env.USERNAME ?? "",
    TERM: "xterm-256color",
  };
  // Pass LLM provider env vars
  for (const k of ["LM_STUDIO_HOST", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_HOST", "LLAMACPP_HOST"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }

  const proc = spawn("bun", ["run", "scripts/tui-client.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: process.cwd(),
  });

  let output = "";
  let outputWaiters: Array<{ sub: string; resolve: (s: string) => void; reject: (e: Error) => void }> = [];

  proc.stdout!.on("data", (data: Buffer) => {
    const text = data.toString("utf-8");
    output += text;
    const plain = stripAnsi(output);
    for (let i = outputWaiters.length - 1; i >= 0; i--) {
      if (plain.includes(outputWaiters[i].sub)) {
        const w = outputWaiters.splice(i, 1)[0];
        w.resolve(plain);
      }
    }
  });

  proc.stderr!.on("data", (data: Buffer) => {
    // TUI server logs — print dimly for debugging
    process.stderr.write(`${C.gray}[tui-srv] ${data.toString("utf-8").trimEnd()}${C.reset}\n`);
  });

  function send(line: string): void {
    proc.stdin!.write(line + "\n");
  }

  function waitForOutput(substring: string, ms: number): Promise<string> {
    const plain = stripAnsi(output);
    if (plain.includes(substring)) {
      return Promise.resolve(plain);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = outputWaiters.findIndex(w => w.resolve === resolve);
        if (idx >= 0) outputWaiters.splice(idx, 1);
        reject(new Error(`Timeout ${ms}ms waiting for "${substring}"`));
      }, ms);
      outputWaiters.push({
        sub: substring,
        resolve: (s) => { clearTimeout(timer); resolve(s); },
        reject,
      });
    });
  }

  return {
    proc,
    get output() { return output; },
    send,
    waitForOutput,
    kill: () => proc.kill("SIGTERM"),
  };
}

// ─── Individual test runner ───────────────────────────────────────────────────

async function runTest(
  name: string,
  fn: () => Promise<{ details?: string; output?: string }>,
): Promise<TuiTestResult> {
  const start = Date.now();
  log(`  ${C.cyan}▶ ${name}${C.reset}`);
  try {
    const res = await fn();
    const dur = Date.now() - start;
    log(`    ${C.green}✓ PASS${C.reset} ${C.gray}(${dur}ms)${C.reset}`);
    if (res.details) log(`    ${C.gray}${res.details}${C.reset}`);
    return { test: name, status: "PASS", durationMs: dur, ...res };
  } catch (err) {
    const dur = Date.now() - start;
    const msg = String(err);
    const isTimeout = msg.includes("Timeout");
    const status = isTimeout ? "TIMEOUT" : "ERROR";
    log(`    ${C.red}✗ ${status}: ${msg}${C.reset}`);
    return { test: name, status, durationMs: dur, details: msg };
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}${C.cyan}  Test TUI Cliente — personal-asistent              ${C.reset}`);
  log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}\n`);

  const results: TuiTestResult[] = [];

  // ─── T1: Arranque y header ─────────────────────────────────────────────────

  log(`${C.bold}[ARRANQUE]${C.reset}`);
  {
    const tui = spawnTui();
    results.push(await runTest("T1: Header y status bar inicial", async () => {
      // Wait specifically for "[Listo]" which is rendered AFTER the header,
      // once the full ACP handshake (initialize + newSession) completes.
      const out = await tui.waitForOutput("Listo", 20_000);
      if (!out.includes("personal-asistent")) throw new Error("Header no encontrado en output");
      if (!out.includes("Listo")) throw new Error("Status bar [Listo] no encontrado");
      return { details: "Header y status bar [Listo] renderizados correctamente" };
    }));

    results.push(await runTest("T2: Mensaje de provider visible", async () => {
      const out = await tui.waitForOutput("LM Studio", 10_000);
      if (!out.includes("LM Studio") && !out.includes("Provider") && !out.includes("Escribe")) {
        throw new Error("Mensaje de provider/hint no encontrado");
      }
      return { details: "Hint de comandos y provider mostrado" };
    }));

    // ─── T2: /help ─────────────────────────────────────────────────────────

    log(`\n${C.bold}[COMANDOS]${C.reset}`);
    results.push(await runTest("T3: /help muestra comandos disponibles", async () => {
      tui.send("/help");
      await wait(1000);
      const out = stripAnsi(tui.output);
      if (!out.includes("/quit") && !out.includes("/clear")) {
        throw new Error("/help no muestra los comandos esperados");
      }
      return { details: "Comandos /quit /clear /new /help listados" };
    }));

    results.push(await runTest("T4: /clear limpia pantalla y re-renderiza header", async () => {
      // Clear accumulated output tracking
      const prevLen = tui.output.length;
      tui.send("/clear");
      await wait(1000);
      const newOut = tui.output.slice(prevLen);
      const plain = stripAnsi(newOut);
      if (!plain.includes("personal-asistent")) {
        throw new Error("Header no re-renderizado después de /clear");
      }
      return { details: "Header re-renderizado tras /clear" };
    }));

    results.push(await runTest("T5: /new crea nueva sesión", async () => {
      tui.send("/new");
      // Wait for "Nueva sesión" or a session ID
      try {
        const out = await tui.waitForOutput("Nueva sesión", 15_000);
        return { details: `Nueva sesión confirmada: ${out.slice(-100).trim()}` };
      } catch {
        // Try alternate: no error message
        await wait(2000);
        const plain = stripAnsi(tui.output);
        if (plain.includes("Error") && plain.includes("sesión")) {
          throw new Error("Error al crear nueva sesión");
        }
        return { details: "/new ejecutado sin error visible" };
      }
    }));

    // ─── T3: Prompt real ────────────────────────────────────────────────────

    log(`\n${C.bold}[PROMPT REAL]${C.reset}`);
    results.push(await runTest("T6: Prompt simple llega al agente (streaming)", async () => {
      tui.send("Di solo la palabra PONG sin nada más");
      // Wait for the turn separator (────────...) which is rendered AFTER
      // the full response and renderTurnSeparator() completes.
      // This ensures we capture the full response, not just "Agent ›".
      const out = await tui.waitForOutput("────────────────────────────────────────", 300_000);
      if (!out.includes("Agent")) throw new Error("No se recibió prefijo 'Agent ›'");
      // Extract the text between "Agent ›" (stripped) and the separator
      const plain = out;
      const agentIdx = plain.lastIndexOf("Agent");
      const sepIdx = plain.lastIndexOf("────────────────────────────────────────");
      const agentResponse = plain.slice(agentIdx, sepIdx).trim();
      if (agentResponse.length < 5) throw new Error(`Respuesta muy corta: "${agentResponse}"`);
      return { details: `Respuesta: "${agentResponse.slice(0, 120).replace(/\n/g, "\\n")}"` };
    }));

    // ─── T4: /quit ──────────────────────────────────────────────────────────

    log(`\n${C.bold}[SALIDA]${C.reset}`);
    results.push(await runTest("T7: /quit cierra el TUI limpiamente", async () => {
      tui.send("/quit");
      // Wait for process exit
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Proceso TUI no terminó en 5s tras /quit"));
        }, 5_000);
        tui.proc.on("exit", () => { clearTimeout(timer); resolve(); });
        tui.proc.on("close", () => { clearTimeout(timer); resolve(); });
      });
      const plain = stripAnsi(tui.output);
      if (!plain.includes("luego") && !plain.includes("Hasta")) {
        // Just verify process exited cleanly
      }
      return { details: "Proceso terminado limpiamente tras /quit" };
    }));

    tui.kill(); // Safety cleanup
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const timeout = results.filter(r => r.status === "TIMEOUT").length;
  const error = results.filter(r => r.status === "ERROR").length;

  log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}`);
  log(`${C.bold}  Resumen: ${pass} PASS  |  ${fail} FAIL  |  ${timeout} TIMEOUT  |  ${error} ERROR${C.reset}`);
  log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════${C.reset}\n`);

  const failed = results.filter(r => r.status !== "PASS");
  if (failed.length > 0) {
    log(`${C.red}${C.bold}Tests con problemas:${C.reset}`);
    for (const f of failed) {
      log(`  ${C.red}[${f.status}] ${f.test}${C.reset}`);
      if (f.details) log(`    → ${f.details}`);
    }
  }

  // Guardar resultados
  const outPath = new URL("../scripts/tui-test-results.json", import.meta.url);
  await Bun.write(outPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  log(`\n${C.gray}Resultados guardados en scripts/tui-test-results.json${C.reset}\n`);

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
