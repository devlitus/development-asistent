import pkg from "../package.json" with { type: "json" };
import { StdioTransport } from "./transport/stdio.ts";
import { AcpServer } from "./protocol/acp-server.ts";
import { createProvider } from "./llm/factory.ts";
import type { LLMProvider } from "./types/llm.ts";
import {
  Orchestrator,
  InMemoryHistoryProvider,
  CompositeIntentClassifier,
  LLMIntentClassifier,
  KeywordIntentClassifier,
} from "./orchestrator/index.ts";
import { CodeAgent, OSAgent, DocsAgent, GitAgent } from "./agents/index.ts";

// Redirigir console.log a stderr para no contaminar stdout
const originalLog = console.log;
console.log = (...args: unknown[]) => console.error(...args);

export async function startup(): Promise<void> {
  if (!pkg.version) {
    throw new Error("Missing version field in package.json");
  }
  console.error(`personal-asistent v${pkg.version} starting...`);

  // Detectar provider disponible (env vars)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const lmStudioHost = process.env.LM_STUDIO_HOST;
  const llamaCppHost = process.env.LLAMACPP_HOST;
  const ollamaHost = process.env.OLLAMA_HOST;

  if (!anthropicKey && !openaiKey && !lmStudioHost && !llamaCppHost && !ollamaHost) {
    console.error(
      "Error: No LLM provider configured. Set one of:\n" +
      "  ANTHROPIC_API_KEY  — Anthropic Claude (cloud)\n" +
      "  OPENAI_API_KEY     — OpenAI GPT (cloud)\n" +
      "  LM_STUDIO_HOST     — LM Studio local (e.g. http://localhost:1234)\n" +
      "  LLAMACPP_HOST      — llama.cpp server (e.g. http://localhost:8080)\n" +
      "  OLLAMA_HOST        — Ollama (e.g. http://localhost:11434)",
    );
    process.exit(1);
  }

  // Seleccionar provider (prioridad: cloud primero, luego locales)
  let provider: LLMProvider;
  if (anthropicKey) {
    provider = createProvider({ type: "anthropic", apiKey: anthropicKey });
  } else if (openaiKey) {
    provider = createProvider({ type: "openai", apiKey: openaiKey });
  } else if (lmStudioHost) {
    provider = createProvider({ type: "lmstudio", baseURL: lmStudioHost });
  } else if (llamaCppHost) {
    provider = createProvider({ type: "llamacpp", baseURL: llamaCppHost });
  } else {
    // ollamaHost is guaranteed defined by the guard above
    provider = createProvider({ type: "ollama", baseURL: ollamaHost! });
  }

  console.error(`Using LLM provider: ${provider.name}`);

  // Crear Orchestrator con classifier composite (LLM + keyword fallback)
  const classifier = new CompositeIntentClassifier(
    new LLMIntentClassifier(provider),
    new KeywordIntentClassifier(),
  );
  const historyProvider = new InMemoryHistoryProvider();
  const orchestrator = new Orchestrator({
    intentClassifier: classifier,
    historyProvider,
    llmProvider: provider,
  });

  // Registrar sub-agentes
  const codeAgent = new CodeAgent();
  orchestrator.registerAgent(codeAgent);
  console.error(`Registered agent: ${codeAgent.name} (${codeAgent.type})`);

  const osAgent = new OSAgent();
  orchestrator.registerAgent(osAgent);
  console.error(`Registered agent: ${osAgent.name} (${osAgent.type})`);

  const docsAgent = new DocsAgent();
  orchestrator.registerAgent(docsAgent);
  console.error(`Registered agent: ${docsAgent.name} (${docsAgent.type})`);

  const gitAgent = new GitAgent();
  orchestrator.registerAgent(gitAgent);
  console.error(`Registered agent: ${gitAgent.name} (${gitAgent.type})`);

  // Iniciar transporte y servidor
  const transport = new StdioTransport();
  const server = new AcpServer(transport, undefined, provider, orchestrator);

  // Manejar señales de cierre
  process.on("SIGINT", () => {
    console.error("Received SIGINT, shutting down...");
    server.stop();
  });
  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    server.stop();
  });

  await server.start();
  console.error("Server stopped.");
}

if (import.meta.main) {
  startup().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
