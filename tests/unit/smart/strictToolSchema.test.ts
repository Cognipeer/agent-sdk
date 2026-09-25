/**
 * Tool schemas in a provider's STRICT tool mode.
 *
 * OpenAI strict mode requires every property in `required` and every object —
 * including every union branch — closed. Tools with optional arguments made
 * the provider reject the whole request; `manage_plan`'s `todoList` union did
 * so for every run with planning on (`… anyOf 0 … Missing 'step'`). These
 * tests check the wire schema against the rules themselves and that the tool
 * still runs with its original arguments after a strict-shaped call.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSmartAgent, createTool } from '../../../src/index.js';
import { toToolDefinition } from '../../../src/providers/adapter.js';
import { getModelCapabilities, isOpenAIHostedEndpoint } from '../../../src/structuredOutput/resolver.js';
import {
  prepareStrictToolMenu,
  restoreToolCalls,
  toStrictCompatible,
  toStrictToolSchema,
} from '../../../src/smart/strictToolSchema.js';

type JsonSchema = {
  type?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

/** OpenAI strict mode's own rules, checked recursively (union branches too). */
function violations(schema: JsonSchema, path = 'root'): string[] {
  const out: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object')) {
    const props = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    for (const key of props) if (!required.includes(key)) out.push(`${path}.${key} not required`);
    if (schema.additionalProperties !== false) out.push(`${path} not closed`);
    for (const key of props) out.push(...violations(schema.properties![key], `${path}.${key}`));
  }
  if (schema.items) out.push(...violations(schema.items, `${path}[]`));
  schema.anyOf?.forEach((branch, index) => out.push(...violations(branch, `${path}|${index}`)));
  return out;
}

/** What LangChain-style strict conversion (zod-to-json-schema) sends, without the adapter's own normalization. */
async function lcStrictParams(schema: z.ZodTypeAny): Promise<JsonSchema> {
  const { zodToJsonSchema } = await import('zod-to-json-schema');
  const converted = zodToJsonSchema(schema, { $refStrategy: 'none', openaiStrictMode: true }) as JsonSchema & { $schema?: string };
  delete converted.$schema;
  return converted;
}

describe('toStrictCompatible', () => {
  const readLines = z.object({
    documentId: z.string(),
    offset: z.number().int().optional(),
    limit: z.number().int().optional(),
  });

  it('the original schema breaks strict mode — the bug', async () => {
    expect(violations(await lcStrictParams(readLines))).toEqual(['root.offset not required', 'root.limit not required']);
  });

  it('the transformed one satisfies it and drops the "not given" nulls', async () => {
    const t = toStrictCompatible(readLines);
    expect(violations(await lcStrictParams(t.schema))).toEqual([]);
    expect(t.restore({ documentId: 'd1', offset: null, limit: 50 })).toEqual({ documentId: 'd1', limit: 50 });
  });

  it('closes nested objects and keeps nested optionals optional', async () => {
    const schema = z.object({ filter: z.object({ tag: z.string().optional() }).optional() });
    const t = toStrictCompatible(schema);
    expect(violations(await lcStrictParams(t.schema))).toEqual([]);
    expect(t.restore({ filter: { tag: null } })).toEqual({ filter: {} });
    expect(t.restore({ filter: null })).toEqual({});
  });

  it('closes the branches of a union — manage_plan\'s todoList', async () => {
    const writeItem = z.object({ id: z.number().int(), step: z.string().optional(), status: z.enum(['a', 'b']) });
    const updateItem = z.object({ id: z.number().int(), step: z.string().optional(), status: z.enum(['a', 'b']).optional() });
    const schema = z.object({
      operation: z.enum(['write', 'update']),
      todoList: z.array(z.union([writeItem, updateItem])).optional(),
    });
    expect(violations(await lcStrictParams(schema))).not.toEqual([]);
    const t = toStrictCompatible(schema);
    expect(violations(await lcStrictParams(t.schema))).toEqual([]);
    // Only the update branch accepts a missing status: that branch's restore wins.
    const restored = t.restore({ operation: 'update', todoList: [{ id: 1, step: null, status: null }] });
    expect(restored).toEqual({ operation: 'update', todoList: [{ id: 1 }] });
    expect(schema.safeParse(restored).success).toBe(true);
  });

  it('carries a free-form object as JSON text and decodes it for the executor', async () => {
    const schema = z.object({ body: z.record(z.any()) });
    const t = toStrictCompatible(schema);
    expect(violations(await lcStrictParams(t.schema))).toEqual([]);
    expect(t.restore({ body: '{"q":1}' })).toEqual({ body: { q: 1 } });
  });

  it('wraps a non-object top level in a required `input` field', () => {
    const t = toStrictToolSchema(z.any());
    expect(t.restore({ input: '{"a":1}' })).toEqual({ a: 1 });
  });
});

describe('restoreToolCalls', () => {
  it('restores SDK-form, raw OpenAI-form and additional_kwargs tool calls', () => {
    const restorers = new Map([['read', toStrictCompatible(z.object({ id: z.string(), offset: z.number().optional() })).restore]]);
    expect(restoreToolCalls({ tool_calls: [{ name: 'read', args: { id: 'a', offset: null } }] }, restorers))
      .toEqual({ tool_calls: [{ name: 'read', args: { id: 'a' } }] });
    expect(restoreToolCalls({ tool_calls: [{ function: { name: 'read', arguments: '{"id":"a","offset":null}' } }] }, restorers))
      .toEqual({ tool_calls: [{ function: { name: 'read', arguments: '{"id":"a"}' } }] });
    expect(restoreToolCalls({ additional_kwargs: { tool_calls: [{ function: { name: 'read', arguments: '{"id":"a","offset":null}' } }] } }, restorers))
      .toEqual({ additional_kwargs: { tool_calls: [{ function: { name: 'read', arguments: '{"id":"a"}' } }] } });
  });
});

describe('prepareStrictToolMenu', () => {
  it('binds a view with the strict schema and leaves the tool itself untouched', async () => {
    const schema = z.object({ q: z.string(), limit: z.number().optional() });
    const tool = createTool({ name: 'search', description: 'd', schema, func: async ({ q }) => q });
    const { menu, restorers } = prepareStrictToolMenu([tool]);
    expect((tool as any).schema).toBe(schema);
    expect((menu[0] as any).schema).not.toBe(schema);
    expect((menu[0] as any).name).toBe('search');
    expect(restorers.has('search')).toBe(true);
    // Same tool, same schema: the view is reused across model calls.
    expect(prepareStrictToolMenu([tool]).menu[0]).toBe(menu[0]);
  });
});

/**
 * The whole point: EVERY tool the provider sees in strict mode — the caller's
 * and the ones the SDK injects for planning, skills and sub-agents — is
 * strict-valid on the wire, and a strict-shaped call still runs the tool with
 * its original arguments.
 */
describe('strict by default — every tool the provider sees', () => {
  function fakeStrictModel(script: Array<Record<string, unknown>>) {
    const bound: Array<{ tools: any[]; options?: Record<string, unknown> }> = [];
    let turn = 0;
    const model: any = {
      capabilities: { structuredOutput: 'native', strictToolCalling: true, provider: 'openai' },
      bindTools(tools: any[], options?: Record<string, unknown>) {
        bound.push({ tools, options });
        return model;
      },
      async invoke() {
        const next = script[Math.min(turn, script.length - 1)];
        turn += 1;
        return next;
      },
    };
    return { model, bound };
  }

  it('binds every tool — caller and SDK alike — in strict-valid form', async () => {
    const { model, bound } = fakeStrictModel([{ role: 'assistant', content: 'done' }]);
    const readLines = createTool({
      name: 'knowledge_read_document_lines',
      description: 'read lines',
      schema: z.object({ documentId: z.string(), offset: z.number().int().optional() }),
      func: async () => 'ok',
    });
    const post = createTool({
      name: 'post_comment',
      description: 'post',
      schema: z.object({ incidentId: z.string(), body: z.record(z.any()) }),
      func: async () => 'ok',
    });
    const agent = createSmartAgent({
      name: 'strict-probe',
      model,
      tools: [readLines, post],
      planning: { mode: 'todo' },
      skills: [{ key: 'triage', title: 'Triage', header: 'How to triage', prompt: 'Look at logs.' }] as any,
      subagents: [{ name: 'reader', description: 'reads logs', systemPrompt: 'read' }] as any,
    } as any);
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);

    expect(bound.length).toBeGreaterThan(0);
    const names = new Set<string>();
    for (const call of bound) {
      expect(call.options?.strict).toBe(true);
      for (const tool of call.tools) {
        names.add(tool.name);
        // Both wire paths: the native adapter's conversion and LangChain's.
        const native = toToolDefinition(tool, true).parameters as JsonSchema;
        expect({ tool: tool.name, violations: violations(native) }).toEqual({ tool: tool.name, violations: [] });
        expect({ tool: tool.name, violations: violations(await lcStrictParams(tool.schema)) })
          .toEqual({ tool: tool.name, violations: [] });
      }
    }
    expect([...names]).toEqual(expect.arrayContaining([
      'knowledge_read_document_lines', 'post_comment', 'manage_plan', 'spawn_subagent', 'open_skill',
    ]));
  });

  it('runs a tool with its original arguments after a strict-shaped call', async () => {
    const seen: unknown[] = [];
    const tool = createTool({
      name: 'knowledge_read_document_lines',
      description: 'read lines',
      schema: z.object({ documentId: z.string(), offset: z.number().int().optional(), body: z.record(z.any()).optional() }),
      func: async (args: unknown) => { seen.push(args); return 'line 1'; },
    });
    const { model } = fakeStrictModel([
      // What a strict provider returns: every argument present, nulls for "not given", free-form as text.
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'knowledge_read_document_lines', args: { documentId: 'd1', offset: null, body: '{"k":1}' } }] },
      { role: 'assistant', content: 'done' },
    ]);
    const agent = createSmartAgent({ name: 'p', model, tools: [tool] } as any);
    await agent.invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    expect(seen).toEqual([{ documentId: 'd1', body: { k: 1 } }]);
  });

  it('leaves the menu alone for a model without strict support', async () => {
    const schema = z.object({ q: z.string().optional() });
    const tool = createTool({ name: 's', description: 'd', schema, func: async () => 'ok' });
    const { model, bound } = fakeStrictModel([{ role: 'assistant', content: 'done' }]);
    model.capabilities.strictToolCalling = false;
    await createSmartAgent({ name: 'p', model, tools: [tool] } as any)
      .invoke({ messages: [{ role: 'user', content: 'go' }] } as any);
    const bs = bound[0].tools.find((t: any) => t.name === 's');
    expect(bs.schema).toBe(schema);
    expect(bound[0].options?.strict).toBeUndefined();
  });
});

describe('which endpoints count as strict', () => {
  class ChatOpenAI {
    constructor(public clientConfig: Record<string, unknown> = {}) {}
  }
  const caps = (lc: unknown) => getModelCapabilities({ invoke: async () => ({}), _lc: lc });

  it('OpenAI and Azure OpenAI hosts are strict', () => {
    expect(caps(new ChatOpenAI()).strictToolCalling).toBe(true);
    expect(caps(new ChatOpenAI({ baseURL: 'https://api.openai.com/v1' })).strictToolCalling).toBe(true);
    expect(isOpenAIHostedEndpoint({ clientConfig: { baseURL: 'https://acme.openai.azure.com/openai' } })).toBe(true);
  });

  it('an OpenAI-compatible server behind ChatOpenAI is not', () => {
    expect(caps(new ChatOpenAI({ baseURL: 'http://vllm:8000/v1' })).strictToolCalling).toBe(false);
    expect(caps(new ChatOpenAI({ baseURL: 'http://localhost:11434/v1' })).strictToolCalling).toBe(false);
    // Still OpenAI wire format, so native structured output stays on.
    expect(caps(new ChatOpenAI({ baseURL: 'http://vllm:8000/v1' })).structuredOutput).toBe('native');
  });

});
