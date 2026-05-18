/**
 * Tests for Anthropic + Bedrock prompt cache breakpoints and provider 429/5xx
 * retry-with-backoff. Uses a fetch stub so no real network calls are made.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnthropicProvider, BedrockProvider } from '../../../src/providers/index.js';

const ANTHROPIC_OK_RESPONSE = {
  id: 'msg_1',
  model: 'claude-sonnet-4',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 },
};

function jsonResponse(body: any, status = 200, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  const h = new Headers({ 'content-type': 'application/json', ...headers });
  return new Response(text, { status, headers: h });
}

describe('Anthropic prompt caching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not inject cache_control by default', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(ANTHROPIC_OK_RESPONSE));
    const provider = new AnthropicProvider({ provider: 'anthropic', apiKey: 'x' });
    await provider.complete({
      model: 'claude-sonnet-4',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ name: 't1', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    });
    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.system).toBe('sys');
    expect(body.tools[0]).not.toHaveProperty('cache_control');
  });

  it('adds cache_control breakpoints on system + final tool when caching enabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(ANTHROPIC_OK_RESPONSE));
    const provider = new AnthropicProvider({
      provider: 'anthropic', apiKey: 'x', prompt_caching: { enabled: true },
    });
    await provider.complete({
      model: 'claude-sonnet-4',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [
        { name: 't1', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 't2', description: 'y', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      ],
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    // breakpoint on the LAST tool, not the first.
    expect(body.tools[0]).not.toHaveProperty('cache_control');
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('Bedrock prompt caching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('adds cachePoint blocks on system + tools when caching enabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const provider = new BedrockProvider({
      provider: 'bedrock',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      prompt_caching: { enabled: true },
    });
    await provider.complete({
      model: 'anthropic.claude-sonnet-4-20250514-v1:0',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ name: 't1', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    // system has a cachePoint at the end
    expect(body.system).toContainEqual({ cachePoint: { type: 'default' } });
    // tools list has a cachePoint after the toolSpec entries
    expect(body.toolConfig.tools.at(-1)).toEqual({ cachePoint: { type: 'default' } });
  });
});

describe('provider retry-with-backoff', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on 429 and then succeeds', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limit' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(ANTHROPIC_OK_RESPONSE));
    const provider = new AnthropicProvider({
      provider: 'anthropic',
      apiKey: 'x',
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    });
    const res = await provider.complete({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res.content).toBe('hello');
  });

  it('gives up after maxRetries and surfaces the error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ error: 'server' }, 503));
    const provider = new AnthropicProvider({
      provider: 'anthropic',
      apiKey: 'x',
      retry: { maxRetries: 1, baseDelayMs: 1 },
    });
    await expect(provider.complete({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/Anthropic API error 503/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx non-429', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    const provider = new AnthropicProvider({
      provider: 'anthropic',
      apiKey: 'x',
      retry: { maxRetries: 3, baseDelayMs: 1 },
    });
    await expect(provider.complete({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/Anthropic API error 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
