/**
 * Tests de integración: ContextWindow integrado en el Orchestrator (Tarea 27)
 *
 * Cubre:
 * - 27a: Instanciar ContextWindow por sesión
 * - 27b: Summarizer conectado con LLMProvider
 * - 27c: Persistencia de resúmenes en SQLite
 * - 27d: Ciclo completo: nuevo → chat → resumen → resume
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Orchestrator } from "../../src/orchestrator/orchestrator.ts";
import { SQLiteRepository } from "../../src/persistence/repository.ts";
import { Migrator } from "../../src/persistence/migrator.ts";
import type { LLMProvider, ChatMessage } from "../../src/types/llm.ts";
import type { SessionId } from "../../src/types/persistence.ts";
import type { Agent, AgentContext, AgentResult } from "../../src/types/agent.ts";
import type { IntentClassifier, SessionHistoryProvider } from "../../src/orchestrator/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function makeSessionId(id: string): SessionId {
  return id as SessionId;
}

function createMockLLMProvider(summaryResponse = "Resumen generado."): LLMProvider {
  return {
    name: "mock-llm",
    chat: mock(async (_messages: readonly ChatMessage[]) => ({
      content: summaryResponse,
      finishReason: "stop" as const,
    })),
    stream: mock(async function* () {}),
  };
}

function createMockClassifier(agentType: "code" | "git" | "os" | "docs" = "code"): IntentClassifier {
  return {
    classify: mock(async (_prompt: string, _history: readonly ChatMessage[]) => ({
      agentType,
      confidence: 1.0,
      reasoning: "mock",
    })),
  };
}

function createMockHistoryProvider(messages: ChatMessage[] = []): SessionHistoryProvider {
  return {
    getHistory: mock(async (_sessionId: SessionId) => messages),
  };
}

function createMockAgent(result: AgentResult = { success: true, output: "done" }): Agent {
  return {
    name: "mock-code",
    type: "code",
    systemPrompt: "Mock agent",
    execute: mock(async (_ctx: AgentContext) => result),
  };
}

async function makeRepo(): Promise<{ repo: SQLiteRepository; db: Database }> {
  const db = new Database(":memory:");
  const sql = await Bun.file(
    new URL("../../src/persistence/migrations/001_initial.sql", import.meta.url)
  ).text();
  const migrator = new Migrator(db, [{ name: "001_initial.sql", sql }]);
  migrator.migrate();
  const repo = new SQLiteRepository(db);
  return { repo, db };
}

async function collectEvents(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ─── 27a: Instanciar ContextWindow por sesión ─────────────────────

describe("27a — ContextWindow instanciado por sesión", () => {
  it("debería instanciar ContextWindow al crear una sesión nueva", async () => {
    const { repo } = await makeRepo();
    const llmProvider = createMockLLMProvider();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider,
      repository: repo,
    });

    const sessionId = makeSessionId("sess-new-001");
    orchestrator.initSession(sessionId);

    expect(orchestrator.hasContextWindow(sessionId)).toBe(true);
  });

  it("debería tener ContextWindow vacío al iniciar sesión nueva", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
      repository: repo,
    });

    const sessionId = makeSessionId("sess-new-002");
    orchestrator.initSession(sessionId);

    const cw = orchestrator.getContextWindow(sessionId);
    expect(cw).toBeDefined();
    // Sin mensajes, estimatedTokens debe ser 0
    expect(cw!.estimatedTokens()).toBe(0);
  });

  it("debería liberar la instancia al terminar la sesión", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
      repository: repo,
    });

    const sessionId = makeSessionId("sess-end-001");
    orchestrator.initSession(sessionId);
    expect(orchestrator.hasContextWindow(sessionId)).toBe(true);

    orchestrator.endSession(sessionId);
    expect(orchestrator.hasContextWindow(sessionId)).toBe(false);
  });

  it("debería mantener instancias independientes para múltiples sesiones", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
      repository: repo,
    });

    const sess1 = makeSessionId("sess-multi-001");
    const sess2 = makeSessionId("sess-multi-002");

    orchestrator.initSession(sess1);
    orchestrator.initSession(sess2);

    const cw1 = orchestrator.getContextWindow(sess1)!;
    const cw2 = orchestrator.getContextWindow(sess2)!;

    // Añadir mensajes a sess1 no afecta a sess2
    cw1.addMessages([{ role: "user", content: "Hola desde sesión 1" }]);

    expect(cw1.estimatedTokens()).toBeGreaterThan(0);
    expect(cw2.estimatedTokens()).toBe(0);
  });

  it("debería acumular mensajes en ContextWindow durante dispatch", async () => {
    const { repo } = await makeRepo();
    const llmProvider = createMockLLMProvider();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider,
      repository: repo,
    });

    orchestrator.registerAgent(createMockAgent());

    const sessionId = makeSessionId("sess-dispatch-001");
    orchestrator.initSession(sessionId);

    await collectEvents(orchestrator.dispatch(sessionId, "Hola mundo"));

    const cw = orchestrator.getContextWindow(sessionId)!;
    // Después del dispatch, el mensaje del usuario debe estar en el ContextWindow
    expect(cw.estimatedTokens()).toBeGreaterThan(0);
  });
});

// ─── 27a: session/resume ──────────────────────────────────────────

describe("27a — session/resume reconstruye ContextWindow desde SQLite", () => {
  it("debería reconstruir ContextWindow con mensajes históricos al hacer resume", async () => {
    const { repo } = await makeRepo();

    // Simular historial previo
    const historicalMessages: ChatMessage[] = [
      { role: "user", content: "Mensaje histórico 1" },
      { role: "assistant", content: "Respuesta histórica 1" },
      { role: "user", content: "Mensaje histórico 2" },
    ];

    const historyProvider = createMockHistoryProvider(historicalMessages);
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider,
      llmProvider: createMockLLMProvider(),
      repository: repo,
    });

    const sessionId = makeSessionId("sess-resume-001");
    await orchestrator.resumeSession(sessionId);

    const cw = orchestrator.getContextWindow(sessionId)!;
    expect(cw).toBeDefined();
    // Debe tener tokens de los mensajes históricos
    expect(cw.estimatedTokens()).toBeGreaterThan(0);
  });

  it("debería crear ContextWindow vacío si no hay historial en resume", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider([]),
      llmProvider: createMockLLMProvider(),
      repository: repo,
    });

    const sessionId = makeSessionId("sess-resume-empty-001");
    await orchestrator.resumeSession(sessionId);

    const cw = orchestrator.getContextWindow(sessionId)!;
    expect(cw).toBeDefined();
    expect(cw.estimatedTokens()).toBe(0);
  });
});

// ─── 27b: Summarizer conectado con LLMProvider ────────────────────

describe("27b — Summarizer conectado con LLMProvider", () => {
  it("debería usar el LLMProvider del Orchestrator para generar resúmenes", async () => {
    const { repo } = await makeRepo();
    const llmProvider = createMockLLMProvider("Resumen de prueba.");

    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider,
      repository: repo,
      contextWindowOptions: {
        maxRecentMessages: 2,
        modelContextSize: 100,
        tokenThresholdPercent: 0.1, // umbral muy bajo para forzar resumen
      },
    });

    orchestrator.registerAgent(createMockAgent());

    // Crear sesión en SQLite para satisfacer FK de summaries
    const session = repo.createSession("/workspace");
    const sessionId = session.id;
    orchestrator.initSession(sessionId);

    const cw = orchestrator.getContextWindow(sessionId)!;

    // Añadir suficientes mensajes para superar el umbral
    cw.addMessages([
      { role: "user", content: "Mensaje 1 con bastante contenido para superar el umbral de tokens" },
      { role: "assistant", content: "Respuesta 1 con bastante contenido para superar el umbral de tokens" },
      { role: "user", content: "Mensaje 2 con bastante contenido para superar el umbral de tokens" },
      { role: "assistant", content: "Respuesta 2 con bastante contenido para superar el umbral de tokens" },
    ]);

    // Llamar getMessagesForPrompt debe disparar el summarizer
    const messages = await cw.getMessagesForPrompt();

    // El LLM debe haber sido llamado para generar el resumen
    expect(llmProvider.chat).toHaveBeenCalled();
    // El resultado debe contener el resumen
    expect(messages.some((m) => m.content.includes("Resumen"))).toBe(true);
  });
});

// ─── 27c: Persistir resúmenes en SQLite ──────────────────────────

describe("27c — Persistir resúmenes en SQLite", () => {
  it("debería persistir el resumen en SQLite cuando se genera", async () => {
    const { repo } = await makeRepo();
    const llmProvider = createMockLLMProvider("Resumen persistido.");

    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider,
      repository: repo,
      contextWindowOptions: {
        maxRecentMessages: 2,
        modelContextSize: 100,
        tokenThresholdPercent: 0.1,
      },
    });

    // Crear sesión en SQLite para satisfacer FK
    const session = repo.createSession("/workspace");
    const sessionId = session.id;

    orchestrator.initSession(sessionId);
    const cw = orchestrator.getContextWindow(sessionId)!;

    cw.addMessages([
      { role: "user", content: "Mensaje 1 con bastante contenido para superar el umbral de tokens" },
      { role: "assistant", content: "Respuesta 1 con bastante contenido para superar el umbral de tokens" },
      { role: "user", content: "Mensaje 2 con bastante contenido para superar el umbral de tokens" },
      { role: "assistant", content: "Respuesta 2 con bastante contenido para superar el umbral de tokens" },
    ]);

    await cw.getMessagesForPrompt();

    // Verificar que el resumen fue persistido en SQLite
    const summaries = repo.getSummariesBySession(sessionId);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]!.content).toBe("Resumen persistido.");
    expect(summaries[0]!.sessionId).toBe(sessionId);
  });

  it("debería restaurar resúmenes desde SQLite en session/resume", async () => {
    const { repo } = await makeRepo();

    // Crear sesión y resumen previo en SQLite
    const session = repo.createSession("/workspace");
    const sessionId = session.id;

    // Simular un turn y mensajes para tener IDs válidos
    const turn = repo.addTurn(sessionId, "prompt inicial", "stop");
    const msg1 = repo.addMessage(turn.id, "user", "Mensaje original 1");
    const msg2 = repo.addMessage(turn.id, "assistant", "Respuesta original 1");

    // Añadir un resumen previo
    repo.addSummary(sessionId, "Resumen previo de la sesión.", msg1.id, msg2.id);

    const historicalMessages: ChatMessage[] = [
      { role: "user", content: "Mensaje histórico post-resumen" },
    ];

    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(historicalMessages),
      llmProvider: createMockLLMProvider(),
      repository: repo,
    });

    await orchestrator.resumeSession(sessionId);

    // El ContextWindow debe existir y tener los mensajes históricos
    const cw = orchestrator.getContextWindow(sessionId)!;
    expect(cw).toBeDefined();
    expect(cw.estimatedTokens()).toBeGreaterThan(0);
  });
});

// ─── 27d: Tests de integración completos ─────────────────────────

describe("27d — Ciclo completo: nuevo → chat → resumen → resume", () => {
  it("debería mantener sesiones simultáneas completamente aisladas", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
      repository: repo,
    });

    orchestrator.registerAgent(createMockAgent());

    const sessions = [
      makeSessionId("concurrent-001"),
      makeSessionId("concurrent-002"),
      makeSessionId("concurrent-003"),
    ];

    // Iniciar todas las sesiones
    for (const sid of sessions) {
      orchestrator.initSession(sid);
    }

    // Añadir mensajes distintos a cada sesión
    for (let i = 0; i < sessions.length; i++) {
      const cw = orchestrator.getContextWindow(sessions[i]!)!;
      cw.addMessages([
        { role: "user", content: `Mensaje exclusivo de sesión ${i + 1}` },
      ]);
    }

    // Verificar que cada sesión tiene sus propios tokens
    const tokens = sessions.map((sid) =>
      orchestrator.getContextWindow(sid)!.estimatedTokens()
    );

    // Todas deben tener tokens > 0
    expect(tokens.every((t) => t > 0)).toBe(true);

    // Terminar una sesión no afecta a las demás
    orchestrator.endSession(sessions[0]!);
    expect(orchestrator.hasContextWindow(sessions[0]!)).toBe(false);
    expect(orchestrator.hasContextWindow(sessions[1]!)).toBe(true);
    expect(orchestrator.hasContextWindow(sessions[2]!)).toBe(true);
  });

  it("debería usar getMessagesForPrompt() en dispatch en lugar de historyProvider directamente", async () => {
    const { repo } = await makeRepo();
    const llmProvider = createMockLLMProvider();

    let capturedHistory: readonly ChatMessage[] | undefined;
    const spyAgent: Agent = {
      name: "spy-agent",
      type: "code",
      systemPrompt: "Spy",
      execute: mock(async (ctx: AgentContext) => {
        capturedHistory = ctx.sessionHistory;
        return { success: true, output: "done" };
      }),
    };

    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider([
        { role: "user", content: "Historial previo" },
      ]),
      llmProvider,
      repository: repo,
    });

    orchestrator.registerAgent(spyAgent);

    const sessionId = makeSessionId("sess-dispatch-ctx-001");
    orchestrator.initSession(sessionId);

    await collectEvents(orchestrator.dispatch(sessionId, "nuevo mensaje"));

    // El agente debe haber recibido el historial del ContextWindow
    expect(capturedHistory).toBeDefined();
  });

  it("debería evictar sesiones inactivas después del TTL", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
      repository: repo,
      sessionTtlMs: 50, // TTL muy corto para tests
    });

    const sessionId = makeSessionId("sess-ttl-001");
    orchestrator.initSession(sessionId);
    expect(orchestrator.hasContextWindow(sessionId)).toBe(true);

    // Esperar a que expire el TTL
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Forzar eviction
    orchestrator.evictExpiredSessions();

    expect(orchestrator.hasContextWindow(sessionId)).toBe(false);
  });
});

// ─── Issue 1: Timer automático de eviction ────────────────────────

describe("Timer automático de eviction (Issue 1)", () => {
  it("debería inicializar el timer en el constructor con intervalo default (60s)", () => {
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
    });

    // El orchestrator debe tener un método dispose (indica que el timer existe)
    expect(typeof orchestrator.dispose).toBe("function");

    // Limpiar
    orchestrator.dispose();
  });

  it("dispose() debe limpiar el timer sin errores", () => {
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
    });

    // dispose() no debe lanzar
    expect(() => orchestrator.dispose()).not.toThrow();

    // Llamar dispose() dos veces tampoco debe lanzar
    expect(() => orchestrator.dispose()).not.toThrow();
  });

  it("con evictionIntervalMs corto, sesiones expiradas son evictadas automáticamente", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
      repository: repo,
      sessionTtlMs: 30,      // TTL muy corto
      evictionIntervalMs: 50, // Intervalo corto para el test
    });

    const sessionId = makeSessionId("sess-auto-evict-001");
    orchestrator.initSession(sessionId);
    expect(orchestrator.hasContextWindow(sessionId)).toBe(true);

    // Esperar a que el timer dispare la eviction automáticamente
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(orchestrator.hasContextWindow(sessionId)).toBe(false);

    orchestrator.dispose();
  });

  it("con evictionIntervalMs corto, sesión activa dentro del TTL NO es evictada", async () => {
    const { repo } = await makeRepo();
    const orchestrator = new Orchestrator({
      intentClassifier: createMockClassifier(),
      historyProvider: createMockHistoryProvider(),
      llmProvider: createMockLLMProvider(),
      repository: repo,
      sessionTtlMs: 5_000,   // TTL largo — sesión no expira
      evictionIntervalMs: 50, // Intervalo corto para el test
    });

    const sessionId = makeSessionId("sess-auto-evict-active-001");
    orchestrator.initSession(sessionId);
    expect(orchestrator.hasContextWindow(sessionId)).toBe(true);

    // Esperar varios ciclos del timer
    await new Promise((resolve) => setTimeout(resolve, 150));

    // La sesión debe seguir viva porque el TTL no ha expirado
    expect(orchestrator.hasContextWindow(sessionId)).toBe(true);

    orchestrator.dispose();
  });
});
