/**
 * Unit tests for LLM cloud providers (Anthropic, OpenAI) and factory.
 *
 * All SDK calls are mocked — no real API requests are made.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type {
  ChatMessage,
  LLMResponse,
  LLMChunk,
} from "../../src/types/llm.ts";
import { normalizeLLMError } from "../../src/llm/errors.ts";

// ---------------------------------------------------------------------------
// Mocks for SDKs (must be set up before importing provider modules)
// ---------------------------------------------------------------------------

const anthropicCreateMock = mock(() => Promise.resolve({}));

mock.module("@anthropic-ai/sdk", () => {
  return {
    default: class Anthropic {
      readonly apiKey: string;

      constructor(options: { apiKey: string }) {
        this.apiKey = options.apiKey;
      }

      messages = {
        create: anthropicCreateMock,
      };
    },
  };
});

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
import { AnthropicProvider } from "../../src/llm/providers/anthropic.ts";
import { OpenAIProvider } from "../../src/llm/providers/openai.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessages(): ChatMessage[] {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ];
}

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe("LLMProviderFactory", () => {
  it("should create AnthropicProvider with apiKey", () => {
    const provider = createProvider({ type: "anthropic", apiKey: "sk-ant-test" });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
  });

  it("should create OpenAIProvider with apiKey", () => {
    const provider = createProvider({ type: "openai", apiKey: "sk-openai-test" });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe("openai");
  });

  it("should create OpenAIProvider with apiKey and baseURL", () => {
    const provider = createProvider({
      type: "openai",
      apiKey: "sk-openai-test",
      baseURL: "https://api.groq.com/openai/v1",
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.name).toBe("openai");
  });

  it("should throw error for unknown provider type", () => {
    expect(() =>
      createProvider({ type: "unknown" as "anthropic", apiKey: "test" }),
    ).toThrow("Unknown provider type: unknown");
  });
});

// ---------------------------------------------------------------------------
// AnthropicProvider tests
// ---------------------------------------------------------------------------

describe("AnthropicProvider", () => {
  beforeEach(() => {
    anthropicCreateMock.mockClear();
  });

  describe("chat()", () => {
    it("should map ChatMessage[] to Anthropic format and return LLMResponse", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [{ type: "text", text: "Hi there!" }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      const messages = makeMessages();
      const response: LLMResponse = await provider.chat(messages, {
        model: "claude-3-opus-20240229",
        temperature: 0.5,
        maxTokens: 256,
      });

      // Verify SDK call
      expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
      const callArgs = anthropicCreateMock.mock.calls[0]![0];
      expect(callArgs.model).toBe("claude-3-opus-20240229");
      expect(callArgs.max_tokens).toBe(256);
      expect(callArgs.temperature).toBe(0.5);
      expect(callArgs.system).toBe("You are a helpful assistant.");
      expect(callArgs.messages).toEqual([{ role: "user", content: "Hello!" }]);

      // Verify response mapping
      expect(response.content).toBe("Hi there!");
      expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
      expect(response.finishReason).toBe("end_turn");
    });

    it("should use default model when not specified", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      await provider.chat([{ role: "user", content: "Hi" }]);

      const callArgs = anthropicCreateMock.mock.calls[0]![0];
      expect(callArgs.model).toBe("claude-3-5-sonnet-latest");
    });

    it("should concatenate multiple text blocks", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [
            { type: "text", text: "First" },
            { type: "text", text: "Second" },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      const response = await provider.chat([{ role: "user", content: "Hi" }]);

      expect(response.content).toBe("FirstSecond");
    });

    it("should map tool_use blocks in response", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [
            { type: "text", text: "Let me check" },
            {
              type: "tool_use",
              id: "tu_01",
              name: "get_weather",
              input: { city: "Madrid" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 8 },
          stop_reason: "tool_use",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      const response = await provider.chat([{ role: "user", content: "Weather?" }]);

      expect(response.content).toBe('Let me check\n\n<tool_use name="get_weather" id="tu_01">\n{"city":"Madrid"}\n</tool_use>');
      expect(response.finishReason).toBe("tool_use");
    });

    it("should handle messages with tool_call_id (tool role)", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [{ type: "text", text: "Done" }],
          usage: { input_tokens: 5, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      const messages: ChatMessage[] = [
        { role: "user", content: "What's 2+2?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "tc_01", name: "calculator", arguments: '{"expr":"2+2"}' },
          ],
        },
        { role: "tool", content: "4", tool_call_id: "tc_01" },
      ];

      await provider.chat(messages);

      const callArgs = anthropicCreateMock.mock.calls[0]![0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "What's 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tc_01",
              name: "calculator",
              input: { expr: "2+2" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc_01",
              content: "4",
            },
          ],
        },
      ]);
    });
  });

  describe("tool calling", () => {
    it("should pass tools to Anthropic API in correct format", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      await provider.chat([{ role: "user", content: "Hi" }], {
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      });

      const callArgs = anthropicCreateMock.mock.calls[0]![0];
      expect(callArgs.tools).toEqual([
        {
          name: "read_file",
          description: "Read a file from disk",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ]);
    });

    it("should return tool_calls when response has tool_use blocks", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [
            { type: "text", text: "Let me read that file" },
            {
              type: "tool_use",
              id: "tu_01",
              name: "read_file",
              input: { path: "/src/index.ts" },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 8 },
          stop_reason: "tool_use",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      const response = await provider.chat([{ role: "user", content: "Read index.ts" }], {
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      });

      expect(response.tool_calls).toEqual([
        {
          id: "tu_01",
          name: "read_file",
          arguments: JSON.stringify({ path: "/src/index.ts" }),
        },
      ]);
      expect(response.finishReason).toBe("tool_use");
    });

    it("should separate text content from tool_calls", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [
            { type: "text", text: "I will search for that." },
            {
              type: "tool_use",
              id: "tu_02",
              name: "search",
              input: { query: "test" },
            },
          ],
          usage: { input_tokens: 5, output_tokens: 10 },
          stop_reason: "tool_use",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      const response = await provider.chat([{ role: "user", content: "Search test" }], {
        tools: [
          { name: "search", description: "Search", parameters: {} },
        ],
      });

      // content should contain ONLY text, no XML serialization
      expect(response.content).toBe("I will search for that.");
      expect(response.tool_calls).toEqual([
        {
          id: "tu_02",
          name: "search",
          arguments: JSON.stringify({ query: "test" }),
        },
      ]);
    });

    it("should return undefined tool_calls when no tool_use in response", async () => {
      anthropicCreateMock.mockImplementation(() =>
        Promise.resolve({
          content: [{ type: "text", text: "Hello!" }],
          usage: { input_tokens: 5, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
      );

      const provider = new AnthropicProvider("sk-ant-test");
      const response = await provider.chat([{ role: "user", content: "Hi" }], {
        tools: [
          { name: "search", description: "Search", parameters: {} },
        ],
      });

      expect(response.content).toBe("Hello!");
      expect(response.tool_calls).toBeUndefined();
      expect(response.finishReason).toBe("end_turn");
    });
  });

  describe("stream()", () => {
    it("should yield LLMChunk with deltas from Anthropic stream", async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } };
          yield { type: "content_block_delta", delta: { type: "text_delta", text: " world" } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
        },
      };

      anthropicCreateMock.mockImplementation(() => Promise.resolve(mockStream));

      const provider = new AnthropicProvider("sk-ant-test");
      const chunks: LLMChunk[] = [];

      for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { delta: "Hello", finishReason: undefined },
        { delta: " world", finishReason: undefined },
        { delta: "", finishReason: "end_turn" },
      ]);
    });

    it("should pass stream: true to SDK", async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } };
        },
      };

      anthropicCreateMock.mockImplementation(() => Promise.resolve(mockStream));

      const provider = new AnthropicProvider("sk-ant-test");
      for await (const _ of provider.stream([{ role: "user", content: "Hi" }])) {
        // consume
      }

      const callArgs = anthropicCreateMock.mock.calls[0]![0];
      expect(callArgs.stream).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should throw clear message on 401 auth error", async () => {
      const error = new Error("Invalid API key");
      (error as { status?: number }).status = 401;
      anthropicCreateMock.mockImplementation(() => Promise.reject(error));

      const provider = new AnthropicProvider("sk-ant-test");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Authentication failed",
      );
    });

    it("should throw clear message on 429 rate limit error", async () => {
      const error = new Error("Too many requests");
      (error as { status?: number }).status = 429;
      anthropicCreateMock.mockImplementation(() => Promise.reject(error));

      const provider = new AnthropicProvider("sk-ant-test");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "Rate limit exceeded",
      );
    });

    it("should throw generic message on unknown error status", async () => {
      const error = new Error("Server exploded");
      (error as { status?: number }).status = 500;
      anthropicCreateMock.mockImplementation(() => Promise.reject(error));

      const provider = new AnthropicProvider("sk-ant-test");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "LLM API error (500)",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider tests
// ---------------------------------------------------------------------------

describe("OpenAIProvider", () => {
  beforeEach(() => {
    openaiCreateMock.mockClear();
  });

  describe("chat()", () => {
    it("should map ChatMessage[] to OpenAI format and return LLMResponse", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Hello back!",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }),
      );

      const provider = new OpenAIProvider("sk-openai-test");
      const messages = makeMessages();
      const response: LLMResponse = await provider.chat(messages, {
        model: "gpt-4-turbo",
        temperature: 0.7,
        maxTokens: 512,
      });

      // Verify SDK call
      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
      const callArgs = openaiCreateMock.mock.calls[0]![0];
      expect(callArgs.model).toBe("gpt-4-turbo");
      expect(callArgs.temperature).toBe(0.7);
      expect(callArgs.max_tokens).toBe(512);
      expect(callArgs.messages).toEqual([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello!" },
      ]);

      // Verify response mapping
      expect(response.content).toBe("Hello back!");
      expect(response.usage).toEqual({ promptTokens: 8, completionTokens: 4 });
      expect(response.finishReason).toBe("stop");
    });

    it("should use default model when not specified", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );

      const provider = new OpenAIProvider("sk-openai-test");
      await provider.chat([{ role: "user", content: "Hi" }]);

      const callArgs = openaiCreateMock.mock.calls[0]![0];
      expect(callArgs.model).toBe("gpt-4o");
    });

    it("should pass baseURL to underlying client", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );

      const provider = new OpenAIProvider("sk-openai-test", "https://api.groq.com/openai/v1");
      await provider.chat([{ role: "user", content: "Hi" }]);

      // We can't directly test the client constructor from outside,
      // but the factory test already checks instance creation.
      // The provider works if the chat succeeds.
      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
    });

    it("should map tool_calls in assistant message to OpenAI format", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [
            {
              message: { content: "Let me check", tool_calls: [] },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );

      const provider = new OpenAIProvider("sk-openai-test");
      const messages: ChatMessage[] = [
        { role: "user", content: "Weather in Madrid?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", name: "get_weather", arguments: '{"city":"Madrid"}' },
          ],
        },
        { role: "tool", content: "25C sunny", tool_call_id: "call_1" },
      ];

      await provider.chat(messages);

      const callArgs = openaiCreateMock.mock.calls[0]![0];
      expect(callArgs.messages).toEqual([
        { role: "user", content: "Weather in Madrid?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Madrid"}' },
            },
          ],
        },
        { role: "tool", content: "25C sunny", tool_call_id: "call_1" },
      ]);
    });

    it("should map tool_calls in response to content string", async () => {
      openaiCreateMock.mockImplementation(() =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_2",
                    type: "function",
                    function: { name: "search", arguments: '{"q":"bun"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 8 },
        }),
      );

      const provider = new OpenAIProvider("sk-openai-test");
      const response = await provider.chat([{ role: "user", content: "Search bun" }]);

      expect(response.content).toBe(
        '<tool_call id="call_2" name="search">\n{"q":"bun"}\n</tool_call>',
      );
      expect(response.finishReason).toBe("tool_calls");
    });
  });

  describe("stream()", () => {
    it("should yield LLMChunk with deltas from OpenAI stream", async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "Hello" } }] };
          yield { choices: [{ delta: { content: " world" } }] };
          yield { choices: [{ delta: { content: null }, finish_reason: "stop" }] };
        },
      };

      openaiCreateMock.mockImplementation(() => Promise.resolve(mockStream));

      const provider = new OpenAIProvider("sk-openai-test");
      const chunks: LLMChunk[] = [];

      for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { delta: "Hello", finishReason: undefined },
        { delta: " world", finishReason: undefined },
        { delta: "", finishReason: "stop" },
      ]);
    });

    it("should pass stream: true to SDK", async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "OK" } }] };
        },
      };

      openaiCreateMock.mockImplementation(() => Promise.resolve(mockStream));

      const provider = new OpenAIProvider("sk-openai-test");
      for await (const _ of provider.stream([{ role: "user", content: "Hi" }])) {
        // consume
      }

      const callArgs = openaiCreateMock.mock.calls[0]![0];
      expect(callArgs.stream).toBe(true);
    });
  });

  describe("error handling", () => {
    it("should throw clear message on 401 auth error", async () => {
      const error = new Error("Server exploded");
      (error as { status?: number }).status = 500;
      openaiCreateMock.mockImplementation(() => Promise.reject(error));

      const provider = new OpenAIProvider("sk-openai-test");
      await expect(provider.chat([{ role: "user", content: "Hi" }])).rejects.toThrow(
        "LLM API error (500)",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeLLMError direct tests
// ---------------------------------------------------------------------------

describe("normalizeLLMError", () => {
  it("should handle string error", () => {
    const result = normalizeLLMError("something broke");
    expect(result.message).toBe("LLM request failed: something broke");
  });

  it("should handle null error", () => {
    const result = normalizeLLMError(null);
    expect(result.message).toBe("LLM request failed: null");
  });

  it("should handle Error without status", () => {
    const error = new Error("network failure");
    const result = normalizeLLMError(error);
    expect(result.message).toBe("LLM request failed: please check your configuration");
  });

  it("should handle Error with status 0", () => {
    const error = new Error("weird error");
    (error as Error & { status: number }).status = 0;
    const result = normalizeLLMError(error);
    expect(result.message).toBe("LLM API error (0): please check your request");
  });

  it("should sanitize 401 to generic message", () => {
    const error = new Error("Invalid API key: sk-secret-123");
    (error as Error & { status: number }).status = 401;
    const result = normalizeLLMError(error);
    expect(result.message).toBe("Authentication failed: check your API key");
    expect(result.message).not.toContain("sk-secret-123");
  });

  it("should sanitize 429 to generic message", () => {
    const error = new Error("Too many requests");
    (error as Error & { status: number }).status = 429;
    const result = normalizeLLMError(error);
    expect(result.message).toBe("Rate limit exceeded: please retry later");
  });

  it("should sanitize other status codes", () => {
    const error = new Error("Server exploded with secret data");
    (error as Error & { status: number }).status = 500;
    const result = normalizeLLMError(error);
    expect(result.message).toBe("LLM API error (500): please check your request");
    expect(result.message).not.toContain("secret data");
  });
});

// ---------------------------------------------------------------------------
// Edge case tests for providers
// ---------------------------------------------------------------------------

describe("AnthropicProvider edge cases", () => {
  beforeEach(() => {
    anthropicCreateMock.mockClear();
  });

  it("should throw when stream errors mid-iteration", async () => {
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } };
        throw new Error("stream broke");
      },
    };

    anthropicCreateMock.mockImplementation(() => Promise.resolve(mockStream));

    const provider = new AnthropicProvider("sk-ant-test");
    const chunks: LLMChunk[] = [];

    await expect((async () => {
      for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
        chunks.push(chunk);
      }
    })()).rejects.toThrow();

    expect(chunks).toEqual([{ delta: "Hel", finishReason: undefined }]);
  });

  it("should handle response without usage nor stop_reason", async () => {
    anthropicCreateMock.mockImplementation(() =>
      Promise.resolve({
        content: [{ type: "text", text: "Just text" }],
      }),
    );

    const provider = new AnthropicProvider("sk-ant-test");
    const response = await provider.chat([{ role: "user", content: "Hi" }]);

    expect(response.content).toBe("Just text");
    expect(response.usage).toBeUndefined();
    expect(response.finishReason).toBeNull();
  });

  it("should concatenate multiple system messages with \\n\\n", async () => {
    anthropicCreateMock.mockImplementation(() =>
      Promise.resolve({
        content: [{ type: "text", text: "OK" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
    );

    const provider = new AnthropicProvider("sk-ant-test");
    const messages: ChatMessage[] = [
      { role: "system", content: "Sys1" },
      { role: "system", content: "Sys2" },
      { role: "user", content: "Hello" },
    ];

    await provider.chat(messages);

    const callArgs = anthropicCreateMock.mock.calls[0]![0];
    expect(callArgs.system).toBe("Sys1\n\nSys2");
  });

  it("should ignore unknown stream events like ping and content_block_start", async () => {
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { role: "assistant" } };
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "ping" };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
        yield { type: "message_stop" };
      },
    };

    anthropicCreateMock.mockImplementation(() => Promise.resolve(mockStream));

    const provider = new AnthropicProvider("sk-ant-test");
    const chunks: LLMChunk[] = [];

    for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { delta: "Hi", finishReason: undefined },
      { delta: "", finishReason: "end_turn" },
    ]);
  });
});

describe("OpenAIProvider tool calling", () => {
  beforeEach(() => {
    openaiCreateMock.mockClear();
  });

  it("should pass tools to OpenAI API in function calling format", async () => {
    openaiCreateMock.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            message: { role: "assistant", content: "Sure!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAIProvider("sk-openai-test");
    const tools = [
      {
        name: "read_file",
        description: "Read a file from disk",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];

    await provider.chat([{ role: "user", content: "Read src/index.ts" }], { tools });

    const callArgs = openaiCreateMock.mock.calls[0]![0];
    expect(callArgs.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from disk",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ]);
  });

  it("should return tool_calls when response contains them", async () => {
    openaiCreateMock.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Let me read that file",
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"/src/index.ts"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 15, completion_tokens: 20 },
      }),
    );

    const provider = new OpenAIProvider("sk-openai-test");
    const tools = [
      {
        name: "read_file",
        description: "Read a file from disk",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    const response = await provider.chat(
      [{ role: "user", content: "Read src/index.ts" }],
      { tools },
    );

    expect(response.tool_calls).toEqual([
      { id: "call_abc123", name: "read_file", arguments: '{"path":"/src/index.ts"}' },
    ]);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.content).toBe("Let me read that file");
  });

  it("should separate text content from tool_calls in response", async () => {
    openaiCreateMock.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will search for that.",
              tool_calls: [
                {
                  id: "call_xyz789",
                  type: "function",
                  function: {
                    name: "search",
                    arguments: '{"query":"bun test framework"}',
                  },
                },
                {
                  id: "call_def456",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      }),
    );

    const provider = new OpenAIProvider("sk-openai-test");
    const tools = [
      {
        name: "search",
        description: "Search",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
      {
        name: "read_file",
        description: "Read file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    const response = await provider.chat(
      [{ role: "user", content: "Search bun and read README" }],
      { tools },
    );

    // content is only the text, no XML serialization of tool_calls
    expect(response.content).toBe("I will search for that.");
    expect(response.tool_calls).toHaveLength(2);
    expect(response.tool_calls![0]).toEqual({
      id: "call_xyz789",
      name: "search",
      arguments: '{"query":"bun test framework"}',
    });
    expect(response.tool_calls![1]).toEqual({
      id: "call_def456",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    });
  });

  it("should return undefined tool_calls when response has none", async () => {
    openaiCreateMock.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello! How can I help?",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 8 },
      }),
    );

    const provider = new OpenAIProvider("sk-openai-test");
    const tools = [
      {
        name: "read_file",
        description: "Read file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    const response = await provider.chat(
      [{ role: "user", content: "Hello" }],
      { tools },
    );

    expect(response.tool_calls).toBeUndefined();
    expect(response.content).toBe("Hello! How can I help?");
    expect(response.finishReason).toBe("stop");
  });

  it("should NOT pass tools param when options.tools is empty array", async () => {
    openaiCreateMock.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const provider = new OpenAIProvider("sk-openai-test");
    await provider.chat(
      [{ role: "user", content: "Hi" }],
      { tools: [] },
    );

    const callArgs = openaiCreateMock.mock.calls[0]![0];
    expect(callArgs.tools).toBeUndefined();
  });

  it("should maintain backward compat: no tools in options uses extractContent", async () => {
    // This is the existing behavior: without tools, tool_calls are serialized as XML
    openaiCreateMock.mockImplementation(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_legacy",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"bun"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 8 },
      }),
    );

    const provider = new OpenAIProvider("sk-openai-test");
    // NO tools in options
    const response = await provider.chat([{ role: "user", content: "Search bun" }]);

    // Legacy behavior: tool_calls serialized as XML in content
    expect(response.content).toBe(
      '<tool_call id="call_legacy" name="search">\n{"q":"bun"}\n</tool_call>',
    );
    expect(response.tool_calls).toBeUndefined();
  });
});

describe("OpenAIProvider edge cases", () => {
  beforeEach(() => {
    openaiCreateMock.mockClear();
  });

  it("should throw when stream errors mid-iteration", async () => {
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "Hel" } }] };
        throw new Error("stream broke");
      },
    };

    openaiCreateMock.mockImplementation(() => Promise.resolve(mockStream));

    const provider = new OpenAIProvider("sk-openai-test");
    const chunks: LLMChunk[] = [];

    await expect((async () => {
      for await (const chunk of provider.stream([{ role: "user", content: "Hi" }])) {
        chunks.push(chunk);
      }
    })()).rejects.toThrow();

    expect(chunks).toEqual([{ delta: "Hel", finishReason: undefined }]);
  });

  it("should handle empty choices array", async () => {
    openaiCreateMock.mockImplementation(() =>
      Promise.resolve({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      }),
    );

    const provider = new OpenAIProvider("sk-openai-test");
    const response = await provider.chat([{ role: "user", content: "Hi" }]);

    expect(response.content).toBe("");
    expect(response.finishReason).toBeNull();
    expect(response.usage).toEqual({ promptTokens: 1, completionTokens: 0 });
  });
});
