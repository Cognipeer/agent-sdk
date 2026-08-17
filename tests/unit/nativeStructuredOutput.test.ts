import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StructuredOutputManager } from '../../src/structuredOutput/manager.js';
import { NativeJsonSchemaStrategy } from '../../src/structuredOutput/nativeStrategy.js';
import { ToolBasedStrategy } from '../../src/structuredOutput/toolStrategy.js';

function findObjectSchemaWithProperty(schema: any, propertyName: string): any | undefined {
  if (!schema || typeof schema !== 'object') return undefined;

  if (schema.properties && typeof schema.properties === 'object' && propertyName in schema.properties) {
    return schema;
  }

  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findObjectSchemaWithProperty(item, propertyName);
        if (found) return found;
      }
      continue;
    }

    const found = findObjectSchemaWithProperty(value, propertyName);
    if (found) return found;
  }

  return undefined;
}

describe('NativeJsonSchemaStrategy', () => {
  it('should emit a top-level object schema for OpenAI response_format', () => {
    const strategy = new NativeJsonSchemaStrategy();
    const schema = z.object({
      toolNames: z.array(z.string().min(1)).max(24),
      complexity: z.enum(['simple', 'moderate', 'complex']),
      planningMode: z.enum(['off', 'todo']),
    }).strict();

    const responseFormat = strategy.buildResponseFormat(schema, 'structured_response');
    const jsonSchema = responseFormat.response_format.json_schema.schema;

    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();
    expect(jsonSchema.$ref).toBeUndefined();
  });

  it('should normalize default+nullable fields into OpenAI strict-compatible required properties', () => {
    const strategy = new NativeJsonSchemaStrategy();
    const schema = z.object({
      actions: z.array(z.object({
        owner: z.enum(['user', 'assistant', 'worker']).default('user').nullable(),
        text: z.string().min(1),
      })),
    }).strict();

    const responseFormat = strategy.buildResponseFormat(schema, 'structured_response');
    const jsonSchema = responseFormat.response_format.json_schema.schema;
    const actionItemSchema = findObjectSchemaWithProperty(jsonSchema, 'owner');

    expect(actionItemSchema).toBeDefined();
    expect(actionItemSchema.required).toEqual(expect.arrayContaining(['owner', 'text']));
  });
});

describe('StructuredOutputManager retry messages', () => {
  const schema = z.object({ answer: z.string() });

  it.each([
    ['native', new NativeJsonSchemaStrategy()],
    ['tool-based', new ToolBasedStrategy()],
  ])('uses user role for %s nudges so system remains first-only', (_name, strategy) => {
    const manager = new StructuredOutputManager(schema, strategy);

    expect(manager.buildNudgeMessage(false).role).toBe('user');
    expect(manager.buildNudgeMessage(true).role).toBe('user');
  });

  it('uses user role for schema-validation corrections', () => {
    const manager = new StructuredOutputManager(schema, new ToolBasedStrategy());

    expect(manager.buildCorrectionMessage({
      type: 'validation_error',
      message: 'Invalid answer.',
      fieldErrors: [{
        path: 'answer',
        expected: 'string',
        received: 'number',
        message: 'Expected string.',
      }],
    }).role).toBe('user');
  });
});
/**
 * Regressions from the schema-conversion options that never existed in the
 * pinned zod-to-json-schema (`openaiStrictMode`, `$refStrategy:
 * "extract-to-root"`, …). They were silently ignored, so strict mode never
 * ran and an unrecognised $refStrategy disabled $ref emission entirely.
 */
describe('NativeJsonSchemaStrategy — strict-mode schema conversion', () => {
  const strategy = new NativeJsonSchemaStrategy();

  it('marks a plain .optional() field required WITH a null branch', () => {
    // Forcing it required without allowing null makes the model invent a value
    // for a field the developer marked optional.
    const schema = strategy.toJsonSchema(
      z.object({ name: z.string(), nickname: z.string().optional() }),
      'user',
    );
    const obj = findObjectSchemaWithProperty(schema, 'nickname');
    expect(obj.required).toContain('nickname');
    expect(obj.properties.nickname.type).toEqual(['string', 'null']);
  });

  it('sets additionalProperties:false at every level', () => {
    const schema = strategy.toJsonSchema(
      z.object({ name: z.string(), meta: z.object({ a: z.number() }) }),
      'nested',
    );
    const root = findObjectSchemaWithProperty(schema, 'meta');
    expect(root.additionalProperties).toBe(false);
    expect(root.properties.meta.additionalProperties).toBe(false);
  });

  it('converts a recursive schema instead of blowing the stack', () => {
    // z.lazy is ordinary (comment trees, categories, org charts). With the old
    // options this threw RangeError before any request left the process.
    const Node: z.ZodType<any> = z.lazy(() =>
      z.object({ label: z.string(), children: z.array(Node).optional() }),
    );
    expect(() => strategy.toJsonSchema(z.object({ root: Node }), 'tree')).not.toThrow();
  });

  it('emits response_format with strict:true and the given name', () => {
    const rf = strategy.buildResponseFormat(z.object({ ok: z.boolean() }), 'my_contract');
    expect(rf.response_format.type).toBe('json_schema');
    expect(rf.response_format.json_schema.name).toBe('my_contract');
    expect(rf.response_format.json_schema.strict).toBe(true);
    expect(rf.response_format.json_schema.schema.type).toBe('object');
  });

  it('emits a self-consistent schema — every $ref resolves inside it', () => {
    // The unwrapped root carries `definitions` along BECAUSE the remaining
    // $refs point into it. Dropping it as "duplicate" would ship a schema the
    // provider cannot resolve.
    const collectRefs = (node: any, out: string[] = []): string[] => {
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) { node.forEach((n) => collectRefs(n, out)); return out; }
      if (typeof node.$ref === 'string') out.push(node.$ref);
      for (const value of Object.values(node)) collectRefs(value, out);
      return out;
    };
    const resolve = (root: any, pointer: string) =>
      pointer.slice(2).split('/').reduce<any>((node, seg) => node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')], root);

    const Address = z.object({ city: z.string(), zip: z.string() });
    for (const schema of [
      strategy.toJsonSchema(z.object({ billing: Address, shipping: Address }), 'order'),
      strategy.toJsonSchema(z.object({ root: z.lazy((): any => z.object({ label: z.string() })) }), 'tree'),
    ]) {
      for (const ref of collectRefs(schema)) {
        expect(resolve(schema, ref), `unresolvable $ref: ${ref}`).toBeDefined();
      }
    }
  });
});
