import { describe, it, expect } from "bun:test";
import { createTuiOrchestrator, checkProviderConnectivity } from "../../scripts/tui-client.tsx";
import type {
  IAcpClient,
  IAgentProcess,
  IRenderer,
  IInput,
  IState,
  TuiOrchestratorDeps,
} from "../../scripts/tui-client.tsx";
import type { SessionUpdatePayload } from "../../scripts/tui/types.ts";

// ─── Minimal mocks ────────────────────────────────────────────────────────────

function makeAcpClient(): IAcpClient {
  return {
    initialize: async () => ({ protocolVersion: 1, serverInfo: {} }),
    newSession: async () => "84c3ffe2-abcd-1234-efgh-000000000000",
    sendPrompt: async () => {},
    onUpdate: () => {},
    onPermissionRequest: () => {},
    sendPermissionResponse: () => {},
  };
}

function makeAgentProcess(): IAgentProcess {
  return {
    spawn: () => {},
    kill: () => {},
    onExit: () => {},
  };
}

function makeRenderer() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const renderer: IRenderer = {
    renderHeader: (...args) => { calls.push({ method: "renderHeader", args }); },
    renderStatusBar: (...args) => { calls.push({ method: "renderStatusBar", args }); },
    renderUserMessage: (...args) => { calls.push({ method: "renderUserMessage", args }); },
    renderAgentMessageStart: (...args) => { calls.push({ method: "renderAgentMessageStart", args }); },
    renderStreamChunk: (...args) => { calls.push({ method: "renderStreamChunk", args }); },
    renderAgentMessageEnd: (...args) => { calls.push({ method: "renderAgentMessageEnd", args }); },
    renderSystemMessage: (...args) => { calls.push({ method: "renderSystemMessage", args }); },
    renderError: (...args) => { calls.push({ method: "renderError", args }); },
    renderPermissionRequest: (...args) => { calls.push({ method: "renderPermissionRequest", args }); },
    renderTurnSeparator: (...args) => { calls.push({ method: "renderTurnSeparator", args }); },
    startSpinner: (...args) => { calls.push({ method: "startSpinner", args }); },
    stopSpinner: (...args) => { calls.push({ method: "stopSpinner", args }); },
    renderRoutingInfo: (...args) => { calls.push({ method: "renderRoutingInfo", args }); },
    renderToolCall: (...args) => { calls.push({ method: "renderToolCall", args }); },
    renderToolResult: (...args) => { calls.push({ method: "renderToolResult", args }); },
    clearMessages: (...args) => { calls.push({ method: "clearMessages", args }); },
    resetScroll: (...args) => { calls.push({ method: "resetScroll", args }); },
  };
  return { renderer, calls };
}

function makeInput() {
  const handlers: {
    prompt: Array<(text: string) => void>;
    command: Array<(cmd: string) => void>;
    quit: Array<() => void>;
  } = { prompt: [], command: [], quit: [] };

  const input: IInput = {
    start: () => {},
    pause: () => {},
    resume: () => {},
    close: () => {},
    askPermission: async () => false,
    onPrompt: (h) => { handlers.prompt.push(h); },
    onCommand: (h) => { handlers.command.push(h); },
    onQuit: (h) => { handlers.quit.push(h); },
  };
  return { input, handlers };
}

function makeState(messageCount = 0): IState & { messageCount: number } {
  let _messageCount = messageCount;
  return {
    setStatus: () => {},
    addMessage: () => { _messageCount++; },
    appendStream: () => {},
    flushStream: () => {},
    setPendingPermission: () => {},
    clearPendingPermission: () => {},
    get messageCount() { return _messageCount; },
  };
}

function makeDeps(overrides: Partial<TuiOrchestratorDeps> = {}): TuiOrchestratorDeps {
  const { renderer } = makeRenderer();
  const { input } = makeInput();
  return {
    acpClient: makeAcpClient(),
    agentProcess: makeAgentProcess(),
    renderer,
    input,
    state: makeState(),
    version: "1.0.0",
    cwd: "/tmp",
    exit: () => { throw new Error("exit called"); },
    ...overrides,
  };
}

// ─── handleCommand("status") tests ───────────────────────────────────────────

describe("handleCommand status", () => {
  it("muestra sessionId (primeros 8 chars) y conteo de mensajes", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();
    const state = makeState(6);

    const deps = makeDeps({ renderer, input, state });
    // Override acpClient to return a known sessionId
    deps.acpClient = {
      ...makeAcpClient(),
      newSession: async () => "84c3ffe2-abcd-1234-efgh-000000000000",
    };

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    // Clear calls from start()
    calls.length = 0;

    // Trigger the status command
    for (const h of handlers.command) {
      await h("status");
    }

    // Wait for async handleCommand
    await new Promise((r) => setTimeout(r, 10));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("84c3ffe"))).toBe(true);
    expect(systemMessages.some((m) => m.includes("6 mensaje"))).toBe(true);
  });

  it("muestra 'Sin sesión activa' si sessionId está vacío", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();
    const state = makeState(0);

    const deps = makeDeps({ renderer, input, state });
    // Override acpClient to return empty sessionId
    deps.acpClient = {
      ...makeAcpClient(),
      newSession: async () => "",
    };

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("status");
    }

    await new Promise((r) => setTimeout(r, 10));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("Sin sesión activa"))).toBe(true);
  });

  it("muestra el provider cuando está disponible", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();
    const state = makeState(0);

    const deps = makeDeps({
      renderer,
      input,
      state,
      provider: "LM Studio (http://192.168.1.133:1234)",
    });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("status");
    }

    await new Promise((r) => setTimeout(r, 10));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("LM Studio"))).toBe(true);
  });

  it("muestra 'Provider: desconocido' si no hay provider", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();
    const state = makeState(0);

    const deps = makeDeps({ renderer, input, state });
    // No provider set (undefined)
    delete (deps as Partial<TuiOrchestratorDeps>).provider;

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("status");
    }

    await new Promise((r) => setTimeout(r, 10));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("desconocido"))).toBe(true);
  });

  it("pluraliza correctamente: '1 mensaje' (singular)", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();
    const state = makeState(1);

    const deps = makeDeps({ renderer, input, state });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("status");
    }

    await new Promise((r) => setTimeout(r, 10));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("1 mensaje") && !m.includes("mensajes"))).toBe(true);
  });
});

// ─── runHealthChecks tests ────────────────────────────────────────────────────

describe("runHealthChecks", () => {
  it("health check warns when no search API keys", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ renderer, input, env: {} });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("sin API de búsqueda web"))).toBe(true);
  });

  it("health check OK when BRAVE_API_KEY present", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ renderer, input, env: { BRAVE_API_KEY: "test-key" } });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("✓ Docs agent"))).toBe(true);
  });

  it("health check OK when provider responds", async () => {
    // Tests checkProviderConnectivity directly (fire-and-forget probe, not acpClient)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 } as Response);
    try {
      const result = await checkProviderConnectivity({ LM_STUDIO_HOST: "http://localhost:1234" });
      expect(result.ok).toBe(true);
      expect(result.message).toBe("✓ Provider OK");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("health check warns on provider timeout", async () => {
    // Tests checkProviderConnectivity directly — simulates AbortError (timeout)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    };
    try {
      const result = await checkProviderConnectivity({ LM_STUDIO_HOST: "http://localhost:1234" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("⚠ Provider no responde");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("health check OK when TAVILY_API_KEY present (without BRAVE)", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ renderer, input, env: { TAVILY_API_KEY: "test-key" } });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("✓ Docs agent"))).toBe(true);
  });

  it("health check warns on provider generic error", async () => {
    // Tests checkProviderConnectivity directly — simulates network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    try {
      const result = await checkProviderConnectivity({ LM_STUDIO_HOST: "http://localhost:1234" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("⚠ Provider error:");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("SSRF: LM_STUDIO_HOST con protocolo file:// no hace fetch y retorna null-like", async () => {
    // file:// no es http/https — detectLlmProviderUrl debe ignorarlo
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200 } as Response;
    };
    try {
      const result = await checkProviderConnectivity({ LM_STUDIO_HOST: "file:///etc/passwd" });
      expect(fetchCalled).toBe(false);
      // Sin URL válida, cae en la rama de API-key providers → ok: false, no provider
      expect(result.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("SSRF: OLLAMA_HOST con esquema javascript: no hace fetch", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200 } as Response;
    };
    try {
      const result = await checkProviderConnectivity({ OLLAMA_HOST: "javascript:alert(1)" });
      expect(fetchCalled).toBe(false);
      expect(result.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── onUpdate markers tests ───────────────────────────────────────────────────

describe("onUpdate markers", () => {
  /** Helper: capture the onUpdate handler registered by createTuiOrchestrator */
  function makeAcpClientWithUpdateCapture() {
    let capturedHandler: ((payload: SessionUpdatePayload) => void) | null = null;
    const acpClient: IAcpClient = {
      ...makeAcpClient(),
      onUpdate: (h) => { capturedHandler = h; },
    };
    return {
      acpClient,
      triggerUpdate(text: string) {
        capturedHandler?.({
          sessionId: "test-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      },
    };
  }

  it("routing chunk calls renderRoutingInfo, not renderStreamChunk", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    triggerUpdate("\x00ROUTING\x00code-agent");

    expect(calls.some((c) => c.method === "renderRoutingInfo" && c.args[0] === "code-agent")).toBe(true);
    expect(calls.some((c) => c.method === "renderStreamChunk")).toBe(false);
  });

  it("TOOL_CALL chunk calls renderToolCall, not renderStreamChunk", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    triggerUpdate("\x00TOOL_CALL\x00read_file");

    expect(calls.some((c) => c.method === "renderToolCall" && c.args[0] === "read_file")).toBe(true);
    expect(calls.some((c) => c.method === "renderStreamChunk")).toBe(false);
  });

  it("TOOL_RESULT completed chunk calls renderToolResult with 'completed'", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    triggerUpdate("\x00TOOL_RESULT\x00read_file\x00completed");

    expect(calls.some((c) => c.method === "renderToolResult" && c.args[0] === "read_file" && c.args[1] === "completed")).toBe(true);
    expect(calls.some((c) => c.method === "renderStreamChunk")).toBe(false);
  });

  it("TOOL_RESULT failed chunk calls renderToolResult with 'failed'", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    triggerUpdate("\x00TOOL_RESULT\x00read_file\x00failed");

    expect(calls.some((c) => c.method === "renderToolResult" && c.args[0] === "read_file" && c.args[1] === "failed")).toBe(true);
    expect(calls.some((c) => c.method === "renderStreamChunk")).toBe(false);
  });
});

// ─── handleCommand("help") tests ─────────────────────────────────────────────

describe("handleCommand help", () => {
  it("llama a renderSystemMessage con el texto de ayuda", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("help");
    }

    await new Promise((r) => setTimeout(r, 10));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.length).toBeGreaterThan(0);
    const helpText = systemMessages.join("\n");
    expect(helpText).toContain("/help");
    expect(helpText).toContain("/clear");
    expect(helpText).toContain("/new");
    expect(helpText).toContain("/status");
    expect(helpText).toContain("/quit");
  });
});

// ─── handleCommand("clear") tests ────────────────────────────────────────────

describe("handleCommand clear", () => {
  it("llama a clearMessages en el renderer (no escribe ANSI a stdout)", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("clear");
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(calls.some((c) => c.method === "clearMessages")).toBe(true);
  });

  it("re-renderiza header y status bar después de clear", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input, version: "2.0.0" });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("clear");
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(calls.some((c) => c.method === "renderHeader" && c.args[0] === "2.0.0")).toBe(true);
    expect(calls.some((c) => c.method === "renderStatusBar" && c.args[0] === "idle")).toBe(true);
  });
});

// ─── handleCommand("sessions") tests ─────────────────────────────────────────

describe("handleCommand sessions", () => {
  it("renderiza mensaje de error/info cuando la DB no existe", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("sessions");
    }

    await new Promise((r) => setTimeout(r, 50));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    // Debe haber al menos un mensaje (error de DB o "no hay sesiones")
    expect(systemMessages.length).toBeGreaterThan(0);
    // No debe crashear — el mensaje debe ser un string
    expect(typeof systemMessages[0]).toBe("string");
  });

  it("no llama a renderError cuando la DB no existe (manejo gracioso)", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("sessions");
    }

    await new Promise((r) => setTimeout(r, 50));

    // El error se muestra via renderSystemMessage, no renderError
    const errorCalls = calls.filter((c) => c.method === "renderError");
    expect(errorCalls.length).toBe(0);
  });
});

// ─── handleCommand("resume:<id>") tests ──────────────────────────────────────

describe("handleCommand resume", () => {
  it("renderiza mensaje de error/info cuando la DB no existe", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("resume:abc12345");
    }

    await new Promise((r) => setTimeout(r, 50));

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.length).toBeGreaterThan(0);
    expect(typeof systemMessages[0]).toBe("string");
  });

  it("no llama a renderError cuando la DB no existe (manejo gracioso)", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    for (const h of handlers.command) {
      await h("resume:abc12345");
    }

    await new Promise((r) => setTimeout(r, 50));

    const errorCalls = calls.filter((c) => c.method === "renderError");
    expect(errorCalls.length).toBe(0);
  });
});

describe("handlePrompt resetScroll", () => {
  it("handlePrompt llama a renderer.resetScroll() antes de enviar el prompt", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    const deps = makeDeps({ renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    // Trigger a prompt via the input handler
    for (const h of handlers.prompt) {
      await h("hola agente");
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(calls.some((c) => c.method === "resetScroll")).toBe(true);
    // resetScroll debe llamarse antes de renderUserMessage
    const resetIdx = calls.findIndex((c) => c.method === "resetScroll");
    const userMsgIdx = calls.findIndex((c) => c.method === "renderUserMessage");
    expect(resetIdx).toBeLessThan(userMsgIdx);
  });
});

// ─── C-4: Recovery tras crash ─────────────────────────────────────────────────

describe("C4: recovery tras crash del agente", () => {
  it("onExit NO llama doExit — pone estado error y muestra opciones", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    let exitCalled = false;
    let capturedExitHandler: ((code: number | null) => void) | null = null;

    const agentProcess: IAgentProcess = {
      spawn: () => {},
      kill: () => {},
      onExit: (h) => { capturedExitHandler = h; },
    };

    const deps = makeDeps({
      renderer,
      input,
      agentProcess,
      exit: () => { exitCalled = true; },
    });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;

    // Simular crash del agente
    capturedExitHandler?.(1);

    await new Promise((r) => setTimeout(r, 10));

    expect(exitCalled).toBe(false);
    expect(calls.some((c) => c.method === "renderError")).toBe(true);
    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);
    expect(systemMessages.some((m) => m.includes("/new"))).toBe(true);
    expect(systemMessages.some((m) => m.includes("/quit"))).toBe(true);
  });

  it("C4: new-session tras crash llama agentProcess.spawn()", async () => {
    const { renderer, calls } = makeRenderer();
    const { input, handlers } = makeInput();

    let spawnCallCount = 0;
    let capturedExitHandler: ((code: number | null) => void) | null = null;

    const agentProcess: IAgentProcess = {
      spawn: () => { spawnCallCount++; },
      kill: () => {},
      onExit: (h) => { capturedExitHandler = h; },
    };

    const deps = makeDeps({
      renderer,
      input,
      agentProcess,
      exit: () => {},
    });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    // Simular crash
    capturedExitHandler?.(1);
    await new Promise((r) => setTimeout(r, 10));

    const spawnBeforeNew = spawnCallCount;
    calls.length = 0;

    // Ejecutar /new
    for (const h of handlers.command) {
      await h("new-session");
    }
    await new Promise((r) => setTimeout(r, 10));

    // spawn() debe haberse llamado de nuevo
    expect(spawnCallCount).toBeGreaterThan(spawnBeforeNew);
  });
});

// ─── C1: SIGINT ─────────────────────────────────────────────────────────────

describe("C1: SIGINT llama shutdown", () => {
  it("SIGINT emitido llama agentProcess.kill()", async () => {
    // Limpiar handlers SIGINT previos para evitar interferencias
    process.removeAllListeners("SIGINT");

    const { renderer } = makeRenderer();
    const { input } = makeInput();

    let killCalled = false;
    const agentProcess: IAgentProcess = {
      spawn: () => {},
      kill: () => { killCalled = true; },
      onExit: () => {},
    };

    let exitCalled = false;
    const deps = makeDeps({
      renderer,
      input,
      agentProcess,
      exit: () => { exitCalled = true; },
    });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    // Emitir SIGINT
    process.emit("SIGINT");

    await new Promise((r) => setTimeout(r, 10));

    expect(killCalled).toBe(true);
    expect(exitCalled).toBe(true);

    // Limpiar el handler para no afectar otros tests
    process.removeAllListeners("SIGINT");
  });
});

// ─── D-02: Health check sin sendPrompt ───────────────────────────────────────

describe("D-02: runHealthChecks usa env vars, no sendPrompt", () => {
  it("start() no llama a sendPrompt durante el health check", async () => {
    const { renderer } = makeRenderer();
    const { input } = makeInput();

    let sendPromptCalled = false;
    const acpClient: IAcpClient = {
      ...makeAcpClient(),
      sendPrompt: async () => { sendPromptCalled = true; },
    };

    const deps = makeDeps({ renderer, input, acpClient, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    expect(sendPromptCalled).toBe(false);
  });

  it("muestra '✓ LLM provider configurado: Anthropic' cuando ANTHROPIC_API_KEY está definida", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ renderer, input, env: { ANTHROPIC_API_KEY: "sk-test" } });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("✓ LLM provider configurado: Anthropic"))).toBe(true);
  });

  it("muestra '✓ LLM provider configurado: OpenAI' cuando OPENAI_API_KEY está definida", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ renderer, input, env: { OPENAI_API_KEY: "sk-test" } });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("✓ LLM provider configurado: OpenAI"))).toBe(true);
  });

  it("muestra '⚠ Sin provider LLM configurado' cuando no hay env vars LLM", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("⚠ Sin provider LLM configurado"))).toBe(true);
  });
});

// ─── D-01: STATUS y ERR markers en onUpdate ──────────────────────────────────

describe("D-01: STATUS_MARKER y ERR_MARKER en onUpdate", () => {
  function makeAcpClientWithUpdateCapture() {
    let capturedHandler: ((payload: SessionUpdatePayload) => void) | null = null;
    const acpClient: IAcpClient = {
      ...makeAcpClient(),
      onUpdate: (h) => { capturedHandler = h; },
    };
    return {
      acpClient,
      triggerUpdate(text: string) {
        capturedHandler?.({
          sessionId: "test-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      },
    };
  }

  it("STATUS_MARKER chunk llama renderSystemMessage, no renderStreamChunk", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    triggerUpdate("\x00STATUS\x00Analizando tu solicitud...");

    expect(calls.some((c) => c.method === "renderSystemMessage" && (c.args[0] as string).includes("Analizando"))).toBe(true);
    expect(calls.some((c) => c.method === "renderStreamChunk")).toBe(false);
  });

  it("ERR_MARKER chunk llama renderError, no renderStreamChunk", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    triggerUpdate("\x00ERR\x00Algo salió mal");

    expect(calls.some((c) => c.method === "renderError" && (c.args[0] as string).includes("Algo salió mal"))).toBe(true);
    expect(calls.some((c) => c.method === "renderStreamChunk")).toBe(false);
  });
});

// ─── D-04: agentName prefix en mensajes del agente ───────────────────────────

describe("D-04: agentName prefix en renderAgentMessageStart", () => {
  function makeAcpClientWithUpdateCapture() {
    let capturedHandler: ((payload: SessionUpdatePayload) => void) | null = null;
    const acpClient: IAcpClient = {
      ...makeAcpClient(),
      onUpdate: (h) => { capturedHandler = h; },
    };
    return {
      acpClient,
      triggerUpdate(text: string) {
        capturedHandler?.({
          sessionId: "test-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });
      },
    };
  }

  it("ROUTING_MARKER actualiza lastRoutedAgent y se pasa a renderAgentMessageStart", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    // Primero llega el routing marker
    triggerUpdate("\x00ROUTING\x00code-agent");
    // Luego llega texto normal
    triggerUpdate("Aquí está la respuesta");

    // renderAgentMessageStart debe haberse llamado con "code-agent"
    const startCall = calls.find((c) => c.method === "renderAgentMessageStart");
    expect(startCall).toBeDefined();
    expect(startCall?.args[0]).toBe("code-agent");
  });

  it("sin ROUTING_MARKER previo, renderAgentMessageStart se llama con 'Agent' (default)", async () => {
    const { acpClient, triggerUpdate } = makeAcpClientWithUpdateCapture();
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const deps = makeDeps({ acpClient, renderer, input, env: {} });
    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    calls.length = 0;
    // Texto normal sin routing previo
    triggerUpdate("Respuesta directa");

    const startCall = calls.find((c) => c.method === "renderAgentMessageStart");
    expect(startCall).toBeDefined();
    expect(startCall?.args[0]).toBe("Agent");
  });
});
