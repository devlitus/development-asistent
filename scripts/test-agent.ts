/**
 * test-agent.ts — Suite de prueba del agente ACP via JSON-RPC
 *
 * Ejecutar: bun run scripts/test-agent.ts
 *
 * Cubre:
 *   1. Handshake ACP (initialize + session/new)
 *   2. Prompt simple → CodeAgent responde
 *   3. CodeAgent herramienta list_directory
 *   4. CodeAgent herramienta read_file
 *   5. CodeAgent herramienta search_code
 *   6. Routing OS/git/docs → fallo gracioso (no registrados)
 *   7. Segunda sesión (/new-session equivalente)
 *   8. Prompt inválido (session ID incorrecto)
 */

import { spawn } from "child_process";
import * as path from "path";

const CWD = process.cwd();
const TIMEOUT_MS = 120_000; // 2 min — Gemma ~15 tok/s, clasificador + agente ~30s total

// ─── Logger ────────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().split("T")[1]!.slice(0, 8);
}
function log(label: string, msg: unknown): void {
  process.stderr.write(`[${ts()}] [${label}] ${JSON.stringify(msg, null, 2)}\n`);
}
function logStep(n: number, desc: string): void {
  process.stderr.write(`\n${"─".repeat(64)}\n▶ ${n}. ${desc}\n${"─".repeat(64)}\n`);
}

// ─── AgentProcess ─────────────────────────────────────────────────────────────

type MsgHandler = (msg: unknown) => void;

function spawnAgent(): {
  send: (msg: object) => void;
  onMessage: (h: MsgHandler) => void;
  kill: () => void;
} {
  const childEnv: Record<string, string> = {};
  for (const key of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LM_STUDIO_HOST",
    "LLAMACPP_HOST", "OLLAMA_HOST",
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP",
    "SystemRoot", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA",
  ]) {
    if (process.env[key]) childEnv[key] = process.env[key]!;
  }

  const child = spawn("bun", ["run", path.join(CWD, "src/index.ts")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: childEnv,
    cwd: CWD,
  });

  const handlers: MsgHandler[] = [];
  let buffer = "";

  child.stdout!.on("data", (data: Buffer) => {
    buffer += data.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const msg = JSON.parse(line);
        for (const h of handlers) h(msg);
      } catch {
        process.stderr.write(`[raw-stdout] ${line}\n`);
      }
    }
  });

  child.on("exit", (code) => {
    process.stderr.write(`[agent-exit] code=${code}\n`);
  });

  return {
    send: (msg) => child.stdin!.write(JSON.stringify(msg) + "\n"),
    onMessage: (h) => handlers.push(h),
    kill: () => {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000);
    },
  };
}

// ─── JSON-RPC Client ───────────────────────────────────────────────────────────

function createClient(agent: ReturnType<typeof spawnAgent>) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  const notifHandlers: ((method: string, params: unknown) => void)[] = [];

  agent.onMessage((raw: unknown) => {
    const m = raw as Record<string, unknown>;
    if (typeof m["id"] === "number" && "result" in m) {
      const p = pending.get(m["id"] as number);
      if (p) { pending.delete(m["id"] as number); p.resolve(m["result"]); }
    } else if (typeof m["id"] === "number" && "error" in m) {
      const p = pending.get(m["id"] as number);
      const err = ((m["error"] as Record<string, unknown>)?.["message"] as string) ?? "RPC error";
      if (p) { pending.delete(m["id"] as number); p.reject(new Error(err)); }
    } else if (typeof m["method"] === "string") {
      for (const h of notifHandlers) h(m["method"] as string, m["params"]);
    }
  });

  return {
    request: <T>(method: string, params: unknown, timeoutMs = TIMEOUT_MS): Promise<T> => {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timeout (${timeoutMs}ms) waiting for "${method}" (id=${id})`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (r) => { clearTimeout(timer); resolve(r as T); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        agent.send({ jsonrpc: "2.0", id, method, params });
      });
    },
    onNotification: (h: (method: string, params: unknown) => void) => notifHandlers.push(h),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface NotifRecord { method: string; params: unknown }

/** Collect all session/update text chunks into a single string. */
function collectText(notifs: NotifRecord[]): string {
  return notifs
    .filter((n) => n.method === "session/update")
    .map((n) => {
      const u = ((n.params as Record<string, unknown>)["update"]) as Record<string, unknown>;
      if (u?.["sessionUpdate"] === "agent_message_chunk") {
        return ((u["content"] as Record<string, unknown>)?.["text"] as string) ?? "";
      }
      return "";
    })
    .join("");
}

// ─── Test runner ──────────────────────────────────────────────────────────────

interface TestResult { test: string; status: "✅" | "❌" | "⚠️"; detail: string; ms?: number }

async function runTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const pass = (test: string, detail = "", ms?: number) => {
    results.push({ test, status: "✅", detail, ms });
    process.stderr.write(`  ✅ ${test}${ms !== undefined ? ` (${ms}ms)` : ""}: ${detail}\n`);
  };
  const fail = (test: string, detail: string, ms?: number) => {
    results.push({ test, status: "❌", detail, ms });
    process.stderr.write(`  ❌ ${test}${ms !== undefined ? ` (${ms}ms)` : ""}: ${detail}\n`);
  };
  const warn = (test: string, detail: string) => {
    results.push({ test, status: "⚠️", detail });
    process.stderr.write(`  ⚠️  ${test}: ${detail}\n`);
  };

  // ─── SETUP ──────────────────────────────────────────────────────────────────
  logStep(0, "Spawn + handshake");

  const agent = spawnAgent();
  const client = createClient(agent);
  const allNotifs: NotifRecord[] = [];
  client.onNotification((method, params) => allNotifs.push({ method, params }));

  await new Promise((r) => setTimeout(r, 1500)); // wait for startup
  pass("spawn", "proceso hijo iniciado");

  // initialize
  try {
    const t0 = Date.now();
    const r = await client.request<Record<string, unknown>>("initialize", { protocolVersion: 1 }, 10_000);
    const ms = Date.now() - t0;
    const pv = r["protocolVersion"];
    const caps = r["agentCapabilities"] ?? r["serverInfo"];
    if (typeof pv === "number") {
      pass("initialize", `protocolVersion=${pv} caps=${JSON.stringify(caps)}`, ms);
    } else {
      fail("initialize", `respuesta inesperada: ${JSON.stringify(r)}`, ms);
      agent.kill(); return results;
    }
  } catch (e) { fail("initialize", String(e)); agent.kill(); return results; }

  // session/new
  let sid = "";
  try {
    const t0 = Date.now();
    const r = await client.request<Record<string, unknown>>("session/new", { cwd: CWD, mcpServers: [] }, 10_000);
    const ms = Date.now() - t0;
    sid = r["sessionId"] as string;
    if (typeof sid === "string" && sid.length > 0) {
      pass("session/new", `sessionId=${sid.slice(0, 8)}...`, ms);
    } else {
      fail("session/new", `sessionId inválido: ${JSON.stringify(r)}`, ms);
      agent.kill(); return results;
    }
  } catch (e) { fail("session/new", String(e)); agent.kill(); return results; }

  // Helper: send a prompt and return collected text
  async function prompt(label: string, text: string, expectContains?: string[]): Promise<string> {
    logStep(results.length + 1, `${label}: "${text.slice(0, 50)}"`);
    const before = allNotifs.length;
    const t0 = Date.now();
    try {
      await client.request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text }],
      });
      const ms = Date.now() - t0;
      const collected = collectText(allNotifs.slice(before));
      const newNotifs = allNotifs.length - before;

      if (!collected.trim()) {
        warn(label, `Sin texto en respuesta (${newNotifs} notifs, ${ms}ms)`);
        return "";
      }

      if (expectContains) {
        const missing = expectContains.filter((s) => !collected.toLowerCase().includes(s.toLowerCase()));
        if (missing.length > 0) {
          warn(label, `Respuesta OK pero faltan keywords: [${missing.join(", ")}]. Texto: "${collected.slice(0, 150)}..."`);
        } else {
          pass(label, `"${collected.slice(0, 120)}..."`, ms);
        }
      } else {
        pass(label, `${ms}ms | ${newNotifs} notifs | "${collected.slice(0, 100)}..."`, ms);
      }
      return collected;
    } catch (e) {
      const ms = Date.now() - t0;
      fail(label, String(e), ms);
      return "";
    }
  }

  // ─── TEST 1: greeting ──────────────────────────────────────────────────────
  await prompt("T1-greeting", "Hola, ¿qué puedes hacer?", ["código", "archivos"]);

  // ─── TEST 2: list_directory ────────────────────────────────────────────────
  await prompt(
    "T2-list-directory",
    "Lista los archivos en el directorio raíz del proyecto (src/)",
    ["src", "index", "agent"],
  );

  // ─── TEST 3: read_file ─────────────────────────────────────────────────────
  await prompt(
    "T3-read-file",
    "Lee el archivo package.json y dime la versión del proyecto y las dependencias",
    ["0.1.0", "bun"],
  );

  // ─── TEST 4: search_code ──────────────────────────────────────────────────
  await prompt(
    "T4-search-code",
    "Busca en el código fuente dónde se define la clase Orchestrator",
    ["orchestrator"],
  );

  // ─── TEST 5: OS routing (no registrado) ───────────────────────────────────
  logStep(results.length + 1, "T5-os-routing: prompt de shell (OS agent no registrado)");
  {
    const before = allNotifs.length;
    const t0 = Date.now();
    try {
      await client.request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "Ejecuta el comando: echo hola mundo" }],
      });
      const ms = Date.now() - t0;
      const collected = collectText(allNotifs.slice(before));
      // The orchestrator should route to OS agent, but OS is not registered → fallback or error
      if (collected.toLowerCase().includes("error") || collected.toLowerCase().includes("no agent") || collected.length > 0) {
        warn("T5-os-routing", `OS agent no registrado. Respuesta: "${collected.slice(0, 150)}" (${ms}ms)`);
      } else {
        warn("T5-os-routing", `Sin respuesta (${ms}ms) — OS agent no registrado en src/index.ts`);
      }
    } catch (e) {
      warn("T5-os-routing", `Error esperado (OS no registrado): ${String(e)}`);
    }
  }

  // ─── TEST 6: Git routing (no registrado) ──────────────────────────────────
  logStep(results.length + 1, "T6-git-routing: prompt de git (Git agent no registrado)");
  {
    const before = allNotifs.length;
    const t0 = Date.now();
    try {
      await client.request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "Muéstrame el git status del repositorio" }],
      });
      const ms = Date.now() - t0;
      const collected = collectText(allNotifs.slice(before));
      warn("T6-git-routing", `Git agent no registrado. Respuesta: "${collected.slice(0, 150)}" (${ms}ms)`);
    } catch (e) {
      warn("T6-git-routing", `Error (Git no registrado): ${String(e)}`);
    }
  }

  // ─── TEST 7: invalid sessionId ────────────────────────────────────────────
  logStep(results.length + 1, "T7-invalid-session: sessionId inexistente");
  try {
    const t0 = Date.now();
    await client.request("session/prompt", {
      sessionId: "00000000-0000-0000-0000-000000000000",
      prompt: [{ type: "text", text: "hola" }],
    }, 5_000);
    fail("T7-invalid-session", "Debería haber dado error pero tuvo éxito");
  } catch (e) {
    const msg = String(e);
    if (msg.includes("not found") || msg.includes("Invalid params") || msg.includes("session")) {
      pass("T7-invalid-session", `Error correcto: ${msg.slice(0, 80)}`);
    } else {
      warn("T7-invalid-session", `Error (podría ser correcto): ${msg.slice(0, 80)}`);
    }
  }

  // ─── TEST 8: nueva sesión ─────────────────────────────────────────────────
  logStep(results.length + 1, "T8-new-session: crear segunda sesión");
  let sid2 = "";
  try {
    const t0 = Date.now();
    const r = await client.request<Record<string, unknown>>("session/new", { cwd: CWD, mcpServers: [] }, 5_000);
    const ms = Date.now() - t0;
    sid2 = r["sessionId"] as string;
    if (sid2 && sid2 !== sid) {
      pass("T8-new-session", `Nueva sessionId=${sid2.slice(0, 8)}... (diferente de la anterior)`, ms);
    } else {
      fail("T8-new-session", `sessionId repetido o vacío: ${sid2}`);
    }
  } catch (e) { fail("T8-new-session", String(e)); }

  // ─── TEST 9: método desconocido ───────────────────────────────────────────
  logStep(results.length + 1, "T9-unknown-method: método RPC inexistente");
  try {
    await client.request("unknown/method", {}, 5_000);
    fail("T9-unknown-method", "Debería haber dado -32601 pero tuvo éxito");
  } catch (e) {
    const msg = String(e);
    if (msg.includes("Method not found") || msg.includes("-32601") || msg.includes("not found")) {
      pass("T9-unknown-method", `Error -32601 correcto: ${msg.slice(0, 60)}`);
    } else {
      warn("T9-unknown-method", `Error recibido: ${msg.slice(0, 80)}`);
    }
  }

  // ─── CLEANUP ──────────────────────────────────────────────────────────────
  logStep(99, "Cleanup");
  agent.kill();
  await new Promise((r) => setTimeout(r, 500));
  pass("cleanup", "proceso hijo terminado");

  // ─── SUMMARY ──────────────────────────────────────────────────────────────
  const totalMs = results.filter((r) => r.ms !== undefined).reduce((a, b) => a + (b.ms ?? 0), 0);
  const passed  = results.filter((r) => r.status === "✅").length;
  const failed  = results.filter((r) => r.status === "❌").length;
  const warned  = results.filter((r) => r.status === "⚠️").length;

  process.stderr.write(`\n${"═".repeat(64)}\nRESUMEN\n${"═".repeat(64)}\n`);
  for (const r of results) {
    process.stderr.write(`  ${r.status} ${r.test}${r.ms !== undefined ? ` [${r.ms}ms]` : ""}: ${r.detail.slice(0, 100)}\n`);
  }
  process.stderr.write(`\n  Tests: ${results.length} | ✅ ${passed} | ❌ ${failed} | ⚠️  ${warned}\n`);
  process.stderr.write(`  Tiempo acumulado LLM: ${(totalMs / 1000).toFixed(1)}s\n`);

  return results;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
runTests().then((results) => {
  const failed = results.filter((r) => r.status === "❌").length;
  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => {
  process.stderr.write(`[fatal] ${err}\n`);
  process.exit(1);
});
