import { describe, it, expect } from "bun:test";
import { createTuiOrchestrator } from "../../scripts/tui-client.ts";
import type {
  IAcpClient,
  IAgentProcess,
  IRenderer,
  IInput,
  IState,
  TuiOrchestratorDeps,
} from "../../scripts/tui-client.ts";
import type { TuiStatus, TuiMessage, PermissionRequest, SessionUpdatePayload } from "../../scripts/tui/types.ts";

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
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const acpClient: IAcpClient = {
      ...makeAcpClient(),
      sendPrompt: async () => {},
    };

    const deps = makeDeps({ renderer, input, acpClient, env: {} });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("✓ Provider OK"))).toBe(true);
  });

  it("health check warns on provider timeout", async () => {
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const acpClient: IAcpClient = {
      ...makeAcpClient(),
      sendPrompt: async (_sessionId, text) => {
        if (text === "__health_check__") {
          throw new Error("timeout");
        }
      },
    };

    const deps = makeDeps({ renderer, input, acpClient, env: {} });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("⚠ Provider no responde"))).toBe(true);
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
    const { renderer, calls } = makeRenderer();
    const { input } = makeInput();

    const acpClient: IAcpClient = {
      ...makeAcpClient(),
      sendPrompt: async (_sessionId, text) => {
        if (text === "__health_check__") {
          throw new Error("connection refused");
        }
      },
    };

    const deps = makeDeps({ renderer, input, acpClient, env: {} });

    const orchestrator = createTuiOrchestrator(deps);
    await orchestrator.start();

    const systemMessages = calls
      .filter((c) => c.method === "renderSystemMessage")
      .map((c) => c.args[0] as string);

    expect(systemMessages.some((m) => m.includes("⚠ Provider error:"))).toBe(true);
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
