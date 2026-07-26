/**
 * Unit tests for file (document) and audio content parts across the native
 * providers, plus the adapter-level normalization of the shapes callers send
 * them in (unified `source`, LangChain-style standard data blocks, OpenAI
 * `input_audio`). All requests use mocked fetch.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fromNativeProvider,
  OpenAIProvider,
  AnthropicProvider,
  BedrockProvider,
  VertexProvider,
} from "../../../src/providers/index.js";
import type { ChatCompletionRequest } from "../../../src/providers/types.js";
import type { BaseProvider } from "../../../src/providers/base.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(response: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
  } as any);
}

function lastRequestBody(): any {
  const call = (globalThis.fetch as any).mock.calls.at(-1);
  return JSON.parse(call[1].body);
}

const PDF_B64 = "JVBERi0xLjQ...";
const MP3_B64 = "SUQzBAAAAAA...";

const fileAndAudioRequest: ChatCompletionRequest = {
  model: "test-model",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize the attachments." },
        {
          type: "file",
          source: { type: "base64", mediaType: "application/pdf", data: PDF_B64 },
          fileName: "report.pdf",
        },
        { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: MP3_B64 } },
      ],
    },
  ],
};

// ─── OpenAI ──────────────────────────────────────────────────────────────────

describe("OpenAIProvider media parts", () => {
  const provider = new OpenAIProvider({ provider: "openai", apiKey: "sk-test" });
  const okResponse = {
    id: "c1",
    model: "gpt-4o",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  it("maps file parts to Chat Completions file blocks and audio to input_audio", async () => {
    globalThis.fetch = mockFetch(okResponse);
    await provider.complete(fileAndAudioRequest);

    const content = lastRequestBody().messages[0].content;
    expect(content[1]).toEqual({
      type: "file",
      file: { filename: "report.pdf", file_data: `data:application/pdf;base64,${PDF_B64}` },
    });
    expect(content[2]).toEqual({
      type: "input_audio",
      input_audio: { data: MP3_B64, format: "wav" },
    });
  });

  it("degrades URL file sources to a visible text reference", async () => {
    globalThis.fetch = mockFetch(okResponse);
    await provider.complete({
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "file", source: { type: "url", url: "https://x.test/a.pdf" } },
          ],
        },
      ],
    });

    const content = lastRequestBody().messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("https://x.test/a.pdf");
  });
});

// ─── Anthropic ───────────────────────────────────────────────────────────────

describe("AnthropicProvider media parts", () => {
  const provider = new AnthropicProvider({ provider: "anthropic", apiKey: "sk-ant" });
  const okResponse = {
    id: "m1",
    model: "claude",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it("maps file parts to document blocks and audio to a text placeholder", async () => {
    globalThis.fetch = mockFetch(okResponse);
    await provider.complete(fileAndAudioRequest);

    const content = lastRequestBody().messages[0].content;
    expect(content[1]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: PDF_B64 },
      title: "report.pdf",
    });
    expect(content[2].type).toBe("text");
    expect(content[2].text).toContain("audio");
  });

  it("maps URL file sources to url document blocks", async () => {
    globalThis.fetch = mockFetch(okResponse);
    await provider.complete({
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [{ type: "file", source: { type: "url", url: "https://x.test/a.pdf" } }],
        },
      ],
    });

    const content = lastRequestBody().messages[0].content;
    expect(content[0]).toEqual({
      type: "document",
      source: { type: "url", url: "https://x.test/a.pdf" },
    });
  });
});

// ─── Bedrock ─────────────────────────────────────────────────────────────────

describe("BedrockProvider media parts", () => {
  const provider = new BedrockProvider({
    provider: "bedrock",
    region: "us-east-1",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret",
  });
  const okResponse = {
    output: { message: { role: "assistant", content: [{ text: "ok" }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };

  it("maps file parts to Converse document blocks with sanitized names", async () => {
    globalThis.fetch = mockFetch(okResponse);
    await provider.complete(fileAndAudioRequest);

    const content = lastRequestBody().messages[0].content;
    expect(content[1]).toEqual({
      document: {
        format: "pdf",
        name: "report",
        source: { bytes: PDF_B64 },
      },
    });
    // Audio is unsupported on Converse → text placeholder
    expect(content[2].text).toContain("audio");
  });
});

// ─── Vertex ──────────────────────────────────────────────────────────────────

describe("VertexProvider media parts", () => {
  const provider = new VertexProvider({
    provider: "vertex",
    projectId: "proj",
    accessToken: "tok",
  });
  const okResponse = {
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };

  it("maps file and audio parts to inlineData", async () => {
    globalThis.fetch = mockFetch(okResponse);
    await provider.complete(fileAndAudioRequest);

    const parts = lastRequestBody().contents[0].parts;
    expect(parts[1]).toEqual({
      inlineData: { mimeType: "application/pdf", data: PDF_B64 },
    });
    expect(parts[2]).toEqual({
      inlineData: { mimeType: "audio/wav", data: MP3_B64 },
    });
  });

  it("infers the mime type for URL images instead of hardcoding jpeg", async () => {
    globalThis.fetch = mockFetch(okResponse);
    await provider.complete({
      model: "test-model",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://x.test/pic.png" } },
            { type: "file", source: { type: "url", url: "https://x.test/doc.pdf" } },
          ],
        },
      ],
    });

    const parts = lastRequestBody().contents[0].parts;
    expect(parts[0]).toEqual({
      fileData: { mimeType: "image/png", fileUri: "https://x.test/pic.png" },
    });
    expect(parts[1]).toEqual({
      fileData: { mimeType: "application/pdf", fileUri: "https://x.test/doc.pdf" },
    });
  });
});

// ─── Adapter normalization ───────────────────────────────────────────────────

describe("fromNativeProvider content normalization", () => {
  function captureProvider(): { provider: BaseProvider; requests: ChatCompletionRequest[] } {
    const requests: ChatCompletionRequest[] = [];
    const provider = {
      providerName: "openai",
      complete: async (request: ChatCompletionRequest) => {
        requests.push(request);
        return {
          id: "r1",
          model: "test",
          content: "ok",
          toolCalls: [],
          usage: {
            inputTokens: 1, outputTokens: 1, totalTokens: 2,
            cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0,
          },
          finishReason: "stop" as const,
          raw: {},
        };
      },
      completeStream: async function* () {},
    } as unknown as BaseProvider;
    return { provider, requests };
  }

  it("normalizes LangChain-style standard data blocks into unified file/audio parts", async () => {
    const { provider, requests } = captureProvider();
    const model = fromNativeProvider(provider, { model: "test" });

    await model.invoke([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          {
            type: "file",
            source_type: "base64",
            data: PDF_B64,
            mime_type: "application/pdf",
            metadata: { filename: "rapor.pdf" },
          },
          { type: "file", source_type: "url", url: "https://x.test/a.pdf" },
          { type: "audio", source_type: "base64", data: MP3_B64, mime_type: "audio/wav" },
          { type: "input_audio", input_audio: { data: MP3_B64, format: "mp3" } },
        ],
      },
    ]);

    const content = requests[0].messages[0].content as any[];
    expect(content[1]).toEqual({
      type: "file",
      source: { type: "base64", mediaType: "application/pdf", data: PDF_B64 },
      fileName: "rapor.pdf",
    });
    expect(content[2]).toEqual({
      type: "file",
      source: { type: "url", url: "https://x.test/a.pdf" },
    });
    expect(content[3]).toEqual({
      type: "audio",
      source: { type: "base64", mediaType: "audio/wav", data: MP3_B64 },
    });
    expect(content[4]).toEqual({
      type: "audio",
      source: { type: "base64", mediaType: "audio/mpeg", data: MP3_B64 },
    });
  });

  it("keeps already-unified file parts intact (no JSON.stringify fallback)", async () => {
    const { provider, requests } = captureProvider();
    const model = fromNativeProvider(provider, { model: "test" });

    await model.invoke([
      {
        role: "user",
        content: [
          {
            type: "file",
            source: { type: "base64", mediaType: "application/pdf", data: PDF_B64 },
            fileName: "report.pdf",
          },
        ],
      },
    ]);

    const content = requests[0].messages[0].content as any[];
    expect(content[0].type).toBe("file");
    expect(content[0].source.data).toBe(PDF_B64);
  });
});
