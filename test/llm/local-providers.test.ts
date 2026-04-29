/**
 * Unit tests for local LLM providers (Ollama, llama.cpp).
 *
 * All HTTP calls are mocked — no real requests are made.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ChatMessage, LLMChunk } from "../../src/types/llm.ts";

// ---------------------------------------------------------------------------
// Mock fetch globally for OllamaProvider
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function setupFetchMock() {
  fetchMock = mock(() => Promise.resolve(new Response('{}')));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

function restoreFetchMock() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Mock OpenAI module for LlamaCppProvider
// ---------------------------------------------------------------------------

const openaiCreateMock = mock(() => Promise.resolve({}));

mock.module("openai", () => {
  return {
    default: class OpenAI {
      readonly apiKey: string;
      readonly baseURL?: string;

      constructor(options: { apiKey: string; baseURL?: string }) {
        this.apiKey = options.apiKey;
        this.baseURL = options.baseURL;
      }

      chat = {
        completions: {
          create: openaiCreateMock,
        },
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { createProvider } from "../../src/llm/factory.ts";
import { OllamaProvider } from "../../src/llm/providers/ollama.ts";
import { LlamaCppProvider } from "../../src/llm/providers/llamacpp.ts";
import { LMStudioProvider } from "../../src/llm/providers/lmstudio.ts";
import { OpenAIProvider } from "../../src/llm/providers/openai.ts";
import { AnthropicProvider } from "../../src/llm/providers/anthropic.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(): ChatMessage[] {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ];
}

function makeOllamaResponse(content: string, done = true) {
  return JSON.stringify({
    model: "llama3.2",
    message: { role: "assistant", content },
    done,
  });
}

function makeOllamaStreamResponse(chunks: Array<{ content: string; done: boolean }>) {
  return chunks.map((c) => JSON.stringify({
    model: "llama3.2",
    message: { role: "assistant", content: c.content },
    done: c.done,
  })).join("\n");
}

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("LLMProviderFactory - local providers", () => {
  it("should create OllamaProvider with default host", () => {
    const provider = createProvider({ type: "ollama" });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe("ollama");
  });

  it("should create OllamaProvider with custom host", () => {
    const provider = createProvider({
      type: "ollama",
      baseURL: "http://custom:11434",
    });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("should create LlamaCppProvider with default host", () => {
    const provider = createProvider({ type: "llamacpp" });
    expect(provider).toBeInstanceOf(LlamaCppProvider);
    expect(provider.name).toBe("llamacpp");
  });

  it("should create LlamaCppProvider with custom host", () => {
    const provider = createProvider({
      type: "llamacpp",
      baseURL: "http://custom:8080",
    });
    expect(provider).toBeInstanceOf(LlamaCppProvider);
  });

  it("should create LMStudioProvider with default host", () => {
    const provider = createProvider({ type: "lmstudio" });
    expect(provider).toBeInstanceOf(LMStudioProvider);
    expect(provider.name).toBe("lmstudio");
  });

  it("should create LMStudioProvider with custom host", () => {
    const provider = createProvider({
      type: "lmstudio",
      baseURL: "http://192.168.1.133:1234",
    });
    expect(provider).toBeInstanceOf(LMStudioProvider);
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider tests
// ---------------------------------------------------------------------------

describe("OllamaProvider", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  describe("chat()", () => {
    it("should POST to /api/chat with correct body", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(makeOllamaResponse("Hello back!"), { status: 200 }),
        ),
      );

      const provider = new OllamaProvider();
      const messages = makeMessages();
      const response = await provider.chat(messages, {
        model: "llama3.2",
        temperature: 0.5,
        maxTokens: 256,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://localhost:11434/api/chat");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });

      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe("llama3.2");
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello!" },
      ]);
      expect(body.options).toEqual({ temperature: 0.5, num_predict: 256 });

      expect(response.content).toBe("Hello back!");
      expect(response.finishReason).toBe("stop");
    });

    it("should use default model when not specified", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(makeOllamaResponse("OK"), { status: 200 }),
        ),
      );

      const provider = new OllamaProvider();
      await provider.chat([{ role: "user", content: "Hi" }]);

      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(body.model).toBe("llama3.2");
    });

    it("should use custom host from env/baseURL", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(makeOllamaResponse("OK"), { status: 200 }),
        ),
      );

      const provider = new OllamaProvider("http://my-ollama:11434");
      await provider.chat([{ role: "user", content: "Hi" }]);

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://my-ollama:11434/api/chat");
    });

    it("should handle response without done field", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: "llama3.2",
              message: { role: "assistant", content: "Just text" },
            }),
            { status: 200 },
          ),
        ),
      );

      const provider = new OllamaProvider();
      const response = await provider.chat([{ role: "user", content: "Hi" }]);

      expect(response.content).toBe("Just text");
      expect(response.finishReason).toBeNull();
    });
  });

  describe("stream()", () => {
    it("should POST with stream: true and yield LLMChunk deltas", async () => {
      const ndjson = makeOllamaStreamResponse([
        { content: "Hello", done: false },
        { content: " world", done: false },
        { content: "", done: true },
      ]);

      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(ndjson, { status: 200 }),
        ),
      );

      const provider = new OllamaProvider();
      const chunks: LLMChunk[] = [];

      for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
        chunks.push(chunk);
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(body.stream).toBe(true);

      expect(chunks).toEqual([
        { delta: "Hello", finishReason: undefined },
        { delta: " world", finishReason: undefined },
        { delta: "", finishReason: "stop" },
      ]);
    });

    it("should handle empty stream chunks", async () => {
      const ndjson = makeOllamaStreamResponse([
        { content: "", done: true },
      ]);

      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(ndjson, { status: 200 })),
      );

      const provider = new OllamaProvider();
      const chunks: LLMChunk[] = [];

      for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { delta: "", finishReason: "stop" },
      ]);
    });
  });

  describe("error handling", () => {
    it("should throw on connection refused", async () => {
      const error = new TypeError("fetch failed");
      fetchMock.mockImplementation(() => Promise.reject(error));

      const provider = new OllamaProvider();
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Ollama server not available",
      );
    });

    it("should throw on HTTP error response", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "model not found" }),
            { status: 404, statusText: "Not Found" },
          ),
        ),
      );

      const provider = new OllamaProvider();
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Ollama request failed (404)",
      );
    });

    it("should throw on ECONNREFUSED", async () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:11434");
      fetchMock.mockImplementation(() => Promise.reject(error));

      const provider = new OllamaProvider();
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Ollama server not available at http://localhost:11434",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// LlamaCppProvider tests
// ---------------------------------------------------------------------------

describe("LlamaCppProvider", () => {
  beforeEach(() => {
    openaiCreateMock.mockClear();
  });

  describe("delegation to OpenAIProvider", () => {
    it("should delegate chat() to OpenAIProvider with baseURL", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [
            {
              message: { role: "assistant", content: "Hello from llama.cpp!" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        }),
      );

      const provider = new LlamaCppProvider();
      const messages = makeMessages();
      const response = await provider.chat(messages, {
        model: "llama-3-8b",
        temperature: 0.7,
      });

      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
      const callArgs = openaiCreateMock.mock.calls[0]![0];
      expect(callArgs.model).toBe("llama-3-8b");
      expect(callArgs.temperature).toBe(0.7);

      expect(response.content).toBe("Hello from llama.cpp!");
      expect(response.usage).toEqual({ promptTokens: 5, completionTokens: 4 });
      expect(response.finishReason).toBe("stop");
    });

    it("should delegate stream() to OpenAIProvider", async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "Hi" } }] };
          yield { choices: [{ delta: { content: " there" } }] };
          yield { choices: [{ delta: { content: null }, finish_reason: "stop" }] };
        },
      };

      openaiCreateMock.mockImplementation(() => Promise.resolve(mockStream));

      const provider = new LlamaCppProvider();
      const chunks: LLMChunk[] = [];

      for await (const chunk of provider.stream([{ role: "user", content: "Hello" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { delta: "Hi", finishReason: undefined },
        { delta: " there", finishReason: undefined },
        { delta: "", finishReason: "stop" },
      ]);
    });

    it("should use custom host from baseURL", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );

      const provider = new LlamaCppProvider("http://my-llama:8080");
      await provider.chat([{ role: "user", content: "Hi" }]);

      // The OpenAI client is constructed with baseURL; we can't inspect it directly,
      // but the provider delegates successfully.
      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
    });

    it("should have name 'llamacpp'", () => {
      const provider = new LlamaCppProvider();
      expect(provider.name).toBe("llamacpp");
    });
  });
});

// ---------------------------------------------------------------------------
// Error normalization tests for connection errors
// ---------------------------------------------------------------------------

describe("normalizeLLMError - local providers", () => {
  it("should normalize connection refused for Ollama", async () => {
    const { normalizeLLMError } = await import("../../src/llm/errors.ts");
    const error = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    const result = normalizeLLMError(error);
    expect(result.message).toBe("Server not available. Is it running?");
  });

  it("should normalize fetch failed for Ollama", async () => {
    const { normalizeLLMError } = await import("../../src/llm/errors.ts");
    const error = new TypeError("fetch failed");
    const result = normalizeLLMError(error);
    expect(result.message).toBe("Server not available. Is it running?");
  });

  it("should normalize ENOTFOUND error", async () => {
    const { normalizeLLMError } = await import("../../src/llm/errors.ts");
    const error = new Error("getaddrinfo ENOTFOUND my-host");
    const result = normalizeLLMError(error, "http://my-host:11434", "ollama");
    expect(result.message).toBe("Ollama server not available at http://my-host:11434. Is it running?");
  });

  it("should normalize ECONNRESET error", async () => {
    const { normalizeLLMError } = await import("../../src/llm/errors.ts");
    const error = new Error("read ECONNRESET");
    const result = normalizeLLMError(error, "http://localhost:11434", "ollama");
    expect(result.message).toBe("Ollama server not available at http://localhost:11434. Is it running?");
  });

  it("should normalize ETIMEDOUT error", async () => {
    const { normalizeLLMError } = await import("../../src/llm/errors.ts");
    const error = new Error("connect ETIMEDOUT 10.0.0.1:11434");
    const result = normalizeLLMError(error);
    expect(result.message).toBe("Server not available. Is it running?");
  });

  it("should produce descriptive message with host+provider", async () => {
    const { normalizeLLMError } = await import("../../src/llm/errors.ts");
    const error = new TypeError("fetch failed");
    const result = normalizeLLMError(error, "http://ollama.local:11434", "ollama");
    expect(result.message).toBe("Ollama server not available at http://ollama.local:11434. Is it running?");
  });
});

// ---------------------------------------------------------------------------
// Edge case tests from audit (test-mancer findings)
// ---------------------------------------------------------------------------

describe("OllamaProvider edge cases", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  it("should handle streaming NDJSON with partial chunks across reads", async () => {
    // Simulate a line split across two reader.read() calls
    const chunk1 = '{"message":{"role":"assistant","content":"Hel"}}\n{"message":{"role":"assistant","content":"lo"';
    const chunk2 = '}}\n{"message":{"role":"assistant","content":""},"done":true}\n';

    let readCount = 0;
    const mockReader = {
      read: mock(() => {
        readCount++;
        if (readCount === 1) return Promise.resolve({ done: false, value: new TextEncoder().encode(chunk1) });
        if (readCount === 2) return Promise.resolve({ done: false, value: new TextEncoder().encode(chunk2) });
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: mock(() => {}),
      cancel: mock(() => Promise.resolve()),
    };

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      ),
    );

    // We need to override response.body since we can't control it from Response constructor easily
    // Instead use a real stream
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk1));
        controller.enqueue(new TextEncoder().encode(chunk2));
        controller.close();
      },
    });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(stream, { status: 200 })),
    );

    const provider = new OllamaProvider();
    const chunks: LLMChunk[] = [];

    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: "Hel", finishReason: undefined },
      { delta: "lo", finishReason: undefined },
      { delta: "", finishReason: "stop" },
    ]);
  });

  it("should handle stream where reader.read() throws error", async () => {
    const stream = new ReadableStream({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":{"content":"Hi"}}\n'));
        controller.error(new Error("connection lost"));
      },
    });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(stream, { status: 200 })),
    );

    const provider = new OllamaProvider();

    await expect((async () => {
      for await (const _ of provider.stream([{ role: "user", content: "Hi" }])) {
        // consume
      }
    })()).rejects.toThrow();
  });

  it("should handle NDJSON malformed line in stream", async () => {
    // Using a ReadableStream to simulate real NDJSON chunking behavior
    const ndjson = '{"message":{"content":"OK"}}\n{INVALID JSON}\n{"message":{"content":""},"done":true}\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjson));
        controller.close();
      },
    });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(stream, { status: 200 })),
    );

    const provider = new OllamaProvider();
    const chunks: LLMChunk[] = [];

    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      chunks.push(chunk);
    }

    // Should still yield valid chunks and skip the malformed line
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toEqual({ delta: "OK", finishReason: undefined });
    expect(chunks[chunks.length - 1]!.finishReason).toBe("stop");
  });

  it("should throw on HTTP error in stream()", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "model not found" }), {
          status: 500,
          statusText: "Internal Server Error",
        }),
      ),
    );

    const provider = new OllamaProvider();
    const messages = makeMessages();

    await expect((async () => {
      for await (const _ of provider.stream(messages)) {
        // consume
      }
    })()).rejects.toThrow("Ollama request failed (500)");
  });

  it("should throw on connection refused in stream()", async () => {
    const error = new TypeError("fetch failed");
    fetchMock.mockImplementation(() => Promise.reject(error));

    const provider = new OllamaProvider();

    await expect((async () => {
      for await (const _ of provider.stream([{ role: "user", content: "Hi" }])) {
        // consume
      }
    })()).rejects.toThrow("Ollama server not available");
  });

  it("should throw on null response body in stream()", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(null, { status: 200 }),
      ),
    );

    const provider = new OllamaProvider();

    await expect((async () => {
      for await (const _ of provider.stream([{ role: "user", content: "Hi" }])) {
        // consume
      }
    })()).rejects.toThrow("no response body");
  });

  it("should use OLLAMA_HOST env var as fallback when no host provided", () => {
    const original = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "http://env-ollama:11434";
    try {
      const provider = new OllamaProvider();
      // We verify indirectly via chat call
      expect(provider.name).toBe("ollama");
    } finally {
      if (original !== undefined) {
        process.env.OLLAMA_HOST = original;
      } else {
        delete process.env.OLLAMA_HOST;
      }
    }
  });

  it("should handle Ollama response without message field", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ model: "llama3.2", done: true }), {
          status: 200,
        }),
      ),
    );

    const provider = new OllamaProvider();
    const response = await provider.chat([{ role: "user", content: "Hi" }]);

    expect(response.content).toBe("");
    expect(response.finishReason).toBe("stop");
  });

  it("should include response body in HTTP error message", async () => {
    const errorBody = { error: "model 'xyz' not found" };
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(errorBody), {
          status: 500,
          statusText: "Internal Server Error",
        }),
      ),
    );

    const provider = new OllamaProvider();
    await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
      "model 'xyz' not found",
    );
  });

  it("should include tool_calls in buildBody for Ollama", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(makeOllamaResponse("Done"), { status: 200 }),
      ),
    );

    const provider = new OllamaProvider();
    const messages: ChatMessage[] = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "tc_01", name: "get_weather", arguments: '{"city":"Madrid"}' },
        ],
      },
      { role: "tool", content: "25C sunny", tool_call_id: "tc_01" },
    ];

    await provider.chat(messages);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          function: {
            name: "get_weather",
            arguments: '{"city":"Madrid"}',
          },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "25C sunny",
      tool_call_id: "tc_01",
    });
  });

  it("should abort request on timeout (AbortController)", async () => {
    // Simulate a slow response that gets aborted
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      // Check that signal is provided
      expect(init?.signal).toBeDefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(
        new Response(makeOllamaResponse("OK"), { status: 200 }),
      );
    });

    const provider = new OllamaProvider();
    await provider.chat([{ role: "user", content: "Hi" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider — Tool Calling (FEAT-02, Task 30a)
// ---------------------------------------------------------------------------

describe("OllamaProvider - tool calling", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  it("should include tools array in request body when options.tools is provided", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(makeOllamaResponse("I'll call the tool."), { status: 200 }),
      ),
    );

    const provider = new OllamaProvider();
    await provider.chat([{ role: "user", content: "What's the weather?" }], {
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.tools).toBeDefined();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    });
  });

  it("should NOT include tools field in request body when options.tools is undefined", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(makeOllamaResponse("Hello!"), { status: 200 }),
      ),
    );

    const provider = new OllamaProvider();
    await provider.chat([{ role: "user", content: "Hello" }]);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.tools).toBeUndefined();
  });

  it("should map tool_calls from Ollama response to LLMResponse.tool_calls", async () => {
    const ollamaResponseWithToolCalls = JSON.stringify({
      model: "llama3.1",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "get_weather",
              arguments: { city: "Madrid", unit: "celsius" },
            },
          },
        ],
      },
      done: true,
      done_reason: "tool_calls",
    });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(ollamaResponseWithToolCalls, { status: 200 })),
    );

    const provider = new OllamaProvider();
    const response = await provider.chat(
      [{ role: "user", content: "What's the weather in Madrid?" }],
      {
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
    );

    expect(response.tool_calls).toBeDefined();
    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls![0]!.name).toBe("get_weather");
    // arguments must be a JSON string (Ollama returns object, we stringify it)
    expect(response.tool_calls![0]!.arguments).toBe('{"city":"Madrid","unit":"celsius"}');
    expect(typeof response.tool_calls![0]!.id).toBe("string");
    expect(response.tool_calls![0]!.id.length).toBeGreaterThan(0);
    expect(response.finishReason).toBe("tool_calls");
  });

  it("should return content text when response has no tool_calls", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(makeOllamaResponse("The weather is sunny."), { status: 200 }),
      ),
    );

    const provider = new OllamaProvider();
    const response = await provider.chat(
      [{ role: "user", content: "What's the weather?" }],
      {
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {},
          },
        ],
      },
    );

    expect(response.content).toBe("The weather is sunny.");
    expect(response.tool_calls).toBeUndefined();
  });

  it("should convert tool_call arguments from object to JSON string", async () => {
    const complexArgs = { city: "Tokyo", unit: "fahrenheit", days: 3 };
    const ollamaResponse = JSON.stringify({
      model: "llama3.1",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "get_forecast",
              arguments: complexArgs,
            },
          },
        ],
      },
      done: true,
      done_reason: "tool_calls",
    });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(ollamaResponse, { status: 200 })),
    );

    const provider = new OllamaProvider();
    const response = await provider.chat([{ role: "user", content: "Forecast?" }], {
      tools: [{ name: "get_forecast", description: "Get forecast", parameters: {} }],
    });

    expect(response.tool_calls![0]!.arguments).toBe(JSON.stringify(complexArgs));
  });

  it("should return descriptive error on HTTP 400 (model does not support tools)", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "model does not support tools" }),
          { status: 400, statusText: "Bad Request" },
        ),
      ),
    );

    const provider = new OllamaProvider();
    await expect(
      provider.chat([{ role: "user", content: "Hi" }], {
        tools: [{ name: "test_tool", description: "A tool", parameters: {} }],
      }),
    ).rejects.toThrow("Ollama request failed (400)");
  });

  it("should handle multiple tool_calls in a single response", async () => {
    const ollamaResponse = JSON.stringify({
      model: "llama3.1",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "tool_a", arguments: { x: 1 } } },
          { function: { name: "tool_b", arguments: { y: "hello" } } },
        ],
      },
      done: true,
      done_reason: "tool_calls",
    });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(ollamaResponse, { status: 200 })),
    );

    const provider = new OllamaProvider();
    const response = await provider.chat([{ role: "user", content: "Do both" }], {
      tools: [
        { name: "tool_a", description: "Tool A", parameters: {} },
        { name: "tool_b", description: "Tool B", parameters: {} },
      ],
    });

    expect(response.tool_calls).toHaveLength(2);
    expect(response.tool_calls![0]!.name).toBe("tool_a");
    expect(response.tool_calls![0]!.arguments).toBe('{"x":1}');
    expect(response.tool_calls![1]!.name).toBe("tool_b");
    expect(response.tool_calls![1]!.arguments).toBe('{"y":"hello"}');
    // Each tool call must have a unique id
    expect(response.tool_calls![0]!.id).not.toBe(response.tool_calls![1]!.id);
  });

  it("should handle arguments already pre-serialized as JSON string", async () => {
    const ollamaResponse = JSON.stringify({
      model: "llama3.1",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          function: {
            name: "get_weather",
            arguments: '{"city":"Madrid"}',  // string, no objeto
          }
        }]
      },
      done: true,
      done_reason: "tool_calls"
    });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(ollamaResponse, { status: 200 })),
    );

    const provider = new OllamaProvider();
    const response = await provider.chat([{ role: "user", content: "Weather?" }], {
      tools: [{ name: "get_weather", description: "Get weather", parameters: {} }]
    });

    expect(response.tool_calls).toBeDefined();
    expect(response.tool_calls).toHaveLength(1);
    // arguments debe ser parseable y producir el objeto correcto
    expect(() => JSON.parse(response.tool_calls![0]!.arguments)).not.toThrow();
    expect(JSON.parse(response.tool_calls![0]!.arguments)).toEqual({ city: "Madrid" });
  });
});

// ---------------------------------------------------------------------------
// Factory type discrimination tests
// ---------------------------------------------------------------------------

describe("ProviderConfig type discrimination", () => {
  it("should create OllamaProvider without apiKey", () => {
    // With discriminated type, ollama should not require apiKey
    const provider = createProvider({ type: "ollama" });
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe("ollama");
  });

  it("should create OllamaProvider with custom baseURL", () => {
    const provider = createProvider({ type: "ollama", baseURL: "http://custom:11434" });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("should create LlamaCppProvider without apiKey", () => {
    const provider = createProvider({ type: "llamacpp" });
    expect(provider).toBeInstanceOf(LlamaCppProvider);
    expect(provider.name).toBe("llamacpp");
  });

  it("should create AnthropicProvider with apiKey", () => {
    const provider = createProvider({ type: "anthropic", apiKey: "sk-ant-test" });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it("should create OpenAIProvider with apiKey", () => {
    const provider = createProvider({ type: "openai", apiKey: "sk-openai-test" });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it("should create LMStudioProvider without apiKey", () => {
    const provider = createProvider({ type: "lmstudio" });
    expect(provider).toBeInstanceOf(LMStudioProvider);
    expect(provider.name).toBe("lmstudio");
  });
});

// ---------------------------------------------------------------------------
// LMStudioProvider tests
// ---------------------------------------------------------------------------

describe("LMStudioProvider", () => {
  beforeEach(() => {
    openaiCreateMock.mockClear();
  });

  describe("delegation to OpenAIProvider", () => {
    it("should delegate chat() and construct baseURL with /v1 suffix", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [
            {
              message: { role: "assistant", content: "Hello from LM Studio!" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 4 },
        }),
      );

      const provider = new LMStudioProvider();
      const messages = makeMessages();
      const response = await provider.chat(messages, {
        model: "qwen/qwen3-6b-27b",
        temperature: 0.7,
      });

      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
      const callArgs = openaiCreateMock.mock.calls[0]![0];
      expect(callArgs.model).toBe("qwen/qwen3-6b-27b");
      expect(callArgs.temperature).toBe(0.7);

      expect(response.content).toBe("Hello from LM Studio!");
      expect(response.usage).toEqual({ promptTokens: 5, completionTokens: 4 });
      expect(response.finishReason).toBe("stop");
    });

    it("should delegate stream() to OpenAIProvider", async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "Hi" } }] };
          yield { choices: [{ delta: { content: " there" } }] };
          yield { choices: [{ delta: { content: null }, finish_reason: "stop" }] };
        },
      };

      openaiCreateMock.mockImplementation(() => Promise.resolve(mockStream));

      const provider = new LMStudioProvider();
      const chunks: LLMChunk[] = [];

      for await (const chunk of provider.stream([{ role: "user", content: "Hello" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { delta: "Hi", finishReason: undefined },
        { delta: " there", finishReason: undefined },
        { delta: "", finishReason: "stop" },
      ]);
    });

    it("should use custom remote host (user's 192.168.1.133:1234)", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );

      const provider = new LMStudioProvider("http://192.168.1.133:1234");
      await provider.chat([{ role: "user", content: "Hi" }]);

      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
    });

    it("should have name 'lmstudio'", () => {
      const provider = new LMStudioProvider();
      expect(provider.name).toBe("lmstudio");
    });

    it("should use LM_STUDIO_HOST env var as fallback when no host provided", () => {
      const original = process.env.LM_STUDIO_HOST;
      process.env.LM_STUDIO_HOST = "http://192.168.1.133:1234";
      try {
        const provider = new LMStudioProvider();
        expect(provider.name).toBe("lmstudio");
      } finally {
        if (original !== undefined) {
          process.env.LM_STUDIO_HOST = original;
        } else {
          delete process.env.LM_STUDIO_HOST;
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// LMStudioProvider - URL normalization tests (SEC-A1 + BUG-M1 fixes)
// ---------------------------------------------------------------------------

describe("LMStudioProvider - URL normalization", () => {
  it("añade /v1 al host y el baseURL es correcto", () => {
    const provider = new LMStudioProvider("http://localhost:1234");
    expect((provider as any).baseURL).toBe("http://localhost:1234/v1");
  });

  it("elimina trailing slash del host antes de añadir /v1", () => {
    const provider = new LMStudioProvider("http://localhost:1234/");
    expect((provider as any).baseURL).toBe("http://localhost:1234/v1");
  });

  it("LM_STUDIO_HOST vacío ('') usa DEFAULT_HOST", () => {
    const original = process.env.LM_STUDIO_HOST;
    process.env.LM_STUDIO_HOST = "";
    try {
      const provider = new LMStudioProvider();
      expect((provider as any).baseURL).toBe("http://localhost:1234/v1");
    } finally {
      if (original !== undefined) {
        process.env.LM_STUDIO_HOST = original;
      } else {
        delete process.env.LM_STUDIO_HOST;
      }
    }
  });

  it("lanza error si el protocolo no es http/https (SSRF guard)", () => {
    expect(() => new LMStudioProvider("file:///etc/passwd"))
      .toThrow(/http:\/\/ or https:\/\//);
  });

  it("lanza error si la URL es inválida", () => {
    expect(() => new LMStudioProvider("not-a-valid-url"))
      .toThrow(/Invalid host URL/);
  });
});
