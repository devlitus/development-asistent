/**
 * tui-simulate.ts
 *
 * Simulador de usuario para el TUI.
 * Parchea process.stdin con mock TTY → arranca main() real → inyecta input.
 *
 * Uso: bun run scripts/tui-simulate.ts
 */

import { PassThrough } from "stream";

// ─── 1. Parchear process.stdin ANTES de cualquier import de Ink ──────────────

const fakeStdin = new PassThrough();
Object.assign(fakeStdin, {
  isTTY: true,
  isRaw: false,
  setRawMode(_m: boolean) { this.isRaw = _m; },
  ref() { return this; },
  unref() { return this; },
});
fakeStdin.resume();

Object.defineProperty(process, "stdin", {
  value: fakeStdin,
  configurable: true,
  writable: true,
});

// ─── 2. Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function send(text: string): void {
  for (const ch of text) fakeStdin.push(ch);
  fakeStdin.push("\r");  // Enter
}

function log(msg: string): void {
  process.stderr.write(`\n[SIM] ── ${msg}\n`);
}

// ─── 3. Sesión de usuario simulada ───────────────────────────────────────────

async function runSession(): Promise<void> {
  log("Importando TUI...");
  const { main } = await import("./tui-client.tsx");

  log("Lanzando main() con stdin mock...");
  // main() no resuelve hasta /quit — la ejecutamos en background
  const mainDone = main().catch((e) => {
    process.stderr.write(`[SIM] main() error: ${e}\n`);
  });

  // ── Arranque: esperar handshake + health checks ──
  log("Esperando arranque y handshake (8s)...");
  await sleep(8000);

  // ── PRUEBA 1: /help ──────────────────────────────
  log("PRUEBA 1 → /help");
  send("/help");
  await sleep(1500);

  // ── PRUEBA 2: /status ────────────────────────────
  log("PRUEBA 2 → /status");
  send("/status");
  await sleep(1500);

  // ── PRUEBA 3: /sessions ──────────────────────────
  log("PRUEBA 3 → /sessions");
  send("/sessions");
  await sleep(2000);

  // ── PRUEBA 4: prompt real al LLM (saludo) ────────
  log("PRUEBA 4 → prompt 'hola, ¿qué eres?'");
  send("hola, ¿qué eres?");
  await sleep(60000);  // LM Studio puede tardar hasta 60s

  // ── PRUEBA 5: /clear ─────────────────────────────
  log("PRUEBA 5 → /clear");
  send("/clear");
  await sleep(1500);

  // ── PRUEBA 6: /new ───────────────────────────────
  log("PRUEBA 6 → /new (nueva sesión)");
  send("/new");
  await sleep(2000);

  // ── PRUEBA 7: prompt de código ───────────────────
  log("PRUEBA 7 → 'lee el archivo package.json y dime la versión'");
  send("lee el archivo package.json y dime la versión del proyecto");
  await sleep(90000);  // Esperar tool call + respuesta

  // ── PRUEBA 8: /sessions tras las 2 sesiones ──────
  log("PRUEBA 8 → /sessions (deberían aparecer 2 sesiones nuevas)");
  send("/sessions");
  await sleep(2000);

  // ── PRUEBA 9: input vacío (Enter sin texto) ───────
  log("PRUEBA 9 → Enter vacío (no debe crashear)");
  send("");
  await sleep(1000);

  // ── PRUEBA 10: comando desconocido ────────────────
  log("PRUEBA 10 → /foobar (comando desconocido)");
  send("/foobar");
  await sleep(1500);

  // ── Salida limpia ─────────────────────────────────
  log("PRUEBA 11 → /quit");
  send("/quit");

  await Promise.race([mainDone, sleep(5000)]);
  log("Sesión finalizada.");
  process.exit(0);
}

runSession().catch((err) => {
  process.stderr.write(`[SIM] Fatal: ${err}\n`);
  process.exit(1);
});
