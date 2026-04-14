import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { NativeJsonSchemaStrategy } from '../../src/structuredOutput/nativeStrategy.js';

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