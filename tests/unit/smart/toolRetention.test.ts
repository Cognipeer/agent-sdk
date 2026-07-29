/**
 * Two-axis tool retention: policy resolution + field-level argument digest.
 *
 * The design these tests pin:
 *  - the INPUT axis (arguments) and the OUTPUT axis (result) are independent,
 *    because value density is per-tool — a file writer carries its payload in the
 *    request, a search tool carries it in the response;
 *  - the input axis defaults to "keep", so argument digesting is always a
 *    deliberate opt-in (backward compatible with every pre-existing caller);
 *  - digesting is FIELD-level, never whole-object: identifying scalars survive so
 *    the model can still state what it did, and each digest names an executionId
 *    so the original is recoverable;
 *  - control-plane and delegation tools are never digested, whatever the config
 *    says — their arguments are how the loop steers itself.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  CONTROL_PLANE_TOOL_NAMES,
  DELEGATION_TOOL_NAMES,
  collectToolRetentionDeclarations,
  createTool,
  digestToolInputArguments,
  digestToolInputValue,
  normalizeSmartAgentOptions,
  resolveInputRetention,
  resolveSummarizationRetention,
} from '../../../src/index.js';
import type { ResolvedSmartAgentConfig, SmartAgentOptions } from '../../../src/types.js';

const config = (toolResponses: SmartAgentOptions['toolResponses']): ResolvedSmartAgentConfig =>
  normalizeSmartAgentOptions({ model: {} as never, toolResponses } as SmartAgentOptions);

const BIG = 'x'.repeat(5000);

describe('resolveInputRetention', () => {
  it('defaults to keep — argument digesting never happens implicitly', () => {
    expect(resolveInputRetention('any_tool', config({}))).toBe('keep');
  });

  it('honors a tool-definition declaration', () => {
    const declarations = collectToolRetentionDeclarations([
      createTool({
        name: 'create_text_file',
        schema: z.object({ filePath: z.string(), content: z.string() }),
        func: async () => ({ ok: true }),
        retention: { input: 'digest' },
      }),
    ]);

    expect(resolveInputRetention('create_text_file', config({}), declarations)).toBe('digest');
    expect(resolveInputRetention('other_tool', config({}), declarations)).toBe('keep');
  });

  it('lets the caller override the tool definition per axis', () => {
    const declarations = collectToolRetentionDeclarations([
      createTool({
        name: 'create_text_file',
        schema: z.object({ content: z.string() }),
        func: async () => ({ ok: true }),
        retention: { input: 'digest' },
      }),
    ]);
    const resolved = config({ retentionByTool: { create_text_file: { input: 'keep' } } });

    expect(resolveInputRetention('create_text_file', resolved, declarations)).toBe('keep');
  });

  it('applies defaultInputPolicy when nothing more specific is set', () => {
    const resolved = config({ defaultInputPolicy: 'digest' });
    expect(resolveInputRetention('some_writer', resolved)).toBe('digest');
  });

  it('never digests control-plane or delegation tools, even when forced', () => {
    const forced = config({
      defaultInputPolicy: 'digest',
      retentionByTool: Object.fromEntries(
        [...CONTROL_PLANE_TOOL_NAMES, ...DELEGATION_TOOL_NAMES].map((name) => [name, { input: 'digest' as const }]),
      ),
    });

    for (const name of [...CONTROL_PLANE_TOOL_NAMES, ...DELEGATION_TOOL_NAMES]) {
      expect(resolveInputRetention(name, forced)).toBe('keep');
    }
  });

  it('never digests the arguments of a critical tool', () => {
    const resolved = config({ defaultInputPolicy: 'digest', criticalTools: ['audit_trail'] });
    expect(resolveInputRetention('audit_trail', resolved)).toBe('keep');
  });
});

describe('resolveSummarizationRetention', () => {
  it('keeps critical tools full regardless of any override', () => {
    const resolved = config({
      criticalTools: ['response'],
      retentionByTool: { response: { output: 'drop' } },
    });
    expect(resolveSummarizationRetention('response', resolved)).toBe('keep_full');
  });

  it('prefers the two-axis map over the legacy single-axis map', () => {
    const resolved = config({
      toolResponseRetentionByTool: { web_search: 'drop' },
      retentionByTool: { web_search: { output: 'keep_structured' } },
    });
    expect(resolveSummarizationRetention('web_search', resolved)).toBe('keep_structured');
  });

  it('still honors the legacy single-axis map (backward compatible)', () => {
    const resolved = config({ toolResponseRetentionByTool: { read_skills: 'keep_full' } });
    expect(resolveSummarizationRetention('read_skills', resolved)).toBe('keep_full');
  });

  it('falls back to a tool-definition declaration, then to defaultPolicy', () => {
    const declarations = collectToolRetentionDeclarations([
      createTool({
        name: 'fetch_page',
        schema: z.object({ url: z.string() }),
        func: async () => ({ ok: true }),
        retention: { output: 'keep_structured' },
      }),
    ]);
    const resolved = config({ defaultPolicy: 'summarize_archive' });

    expect(resolveSummarizationRetention('fetch_page', resolved, declarations)).toBe('keep_structured');
    expect(resolveSummarizationRetention('unknown_tool', resolved, declarations)).toBe('summarize_archive');
  });

  it('defaults control-plane tool output to keep_full, but stays overridable', () => {
    expect(resolveSummarizationRetention('open_skill', config({}))).toBe('keep_full');
    expect(
      resolveSummarizationRetention('open_skill', config({ retentionByTool: { open_skill: { output: 'drop' } } })),
    ).toBe('drop');
  });
});

describe('digestToolInputValue', () => {
  it('replaces only oversized string fields and preserves everything else', () => {
    const { value, digestedPaths } = digestToolInputValue(
      { filePath: '/a/b.md', mode: 'append', section: 3, dryRun: false, content: BIG },
      { maxFieldChars: 2000, headChars: 10, executionId: 'exec_1' },
    );

    expect(digestedPaths).toEqual(['content']);
    const out = value as any;
    expect(out.filePath).toBe('/a/b.md');
    expect(out.mode).toBe('append');
    expect(out.section).toBe(3);
    expect(out.dryRun).toBe(false);
    expect(out.content.__digest).toMatchObject({ chars: BIG.length, head: 'xxxxxxxxxx' });
    expect(out.content.__digest.recover).toContain('exec_1');
  });

  it('leaves a value alone when nothing exceeds the threshold (same reference)', () => {
    const input = { query: 'short', limit: 10 };
    const { value, digestedPaths } = digestToolInputValue(input, { maxFieldChars: 2000 });

    expect(digestedPaths).toEqual([]);
    expect(value).toBe(input);
  });

  it('recurses into nested objects and arrays', () => {
    const { digestedPaths } = digestToolInputValue(
      { files: [{ path: 'a', body: BIG }, { path: 'b', body: 'small' }], meta: { note: BIG } },
      { maxFieldChars: 2000 },
    );

    expect(digestedPaths).toEqual(['files[0].body', 'meta.note']);
  });

  it('is idempotent — an existing digest marker is not re-digested', () => {
    const once = digestToolInputValue({ content: BIG }, { maxFieldChars: 2000 });
    const twice = digestToolInputValue(once.value, { maxFieldChars: 2000 });

    expect(twice.digestedPaths).toEqual([]);
    expect(twice.value).toBe(once.value);
  });

  it('hashes deterministically so identical payloads are recognizable', () => {
    const a = digestToolInputValue({ content: BIG }, { maxFieldChars: 2000 }).value as any;
    const b = digestToolInputValue({ content: BIG }, { maxFieldChars: 2000 }).value as any;
    expect(a.content.__digest.sha256).toBe(b.content.__digest.sha256);
  });
});

describe('digestToolInputArguments', () => {
  it('rewrites the serialized arguments and reports what it reclaimed', () => {
    const original = JSON.stringify({ filePath: '/x.md', content: BIG });
    const result = digestToolInputArguments(original, { maxFieldChars: 2000, executionId: 'e1' });

    expect(result.digestedPaths).toEqual(['content']);
    expect(result.reclaimedChars).toBeGreaterThan(4000);
    // Must remain valid JSON: provider adapters parse tool-call arguments.
    const parsed = JSON.parse(result.arguments);
    expect(parsed.filePath).toBe('/x.md');
    expect(parsed.content.__digest.chars).toBe(BIG.length);
  });

  it('returns the input untouched when it is not parseable JSON', () => {
    const notJson = `not json ${BIG}`;
    const result = digestToolInputArguments(notJson, { maxFieldChars: 10 });

    expect(result.arguments).toBe(notJson);
    expect(result.digestedPaths).toEqual([]);
  });

  it('returns the input untouched when the rewrite would not be smaller', () => {
    const original = JSON.stringify({ content: 'x'.repeat(30) });
    const result = digestToolInputArguments(original, { maxFieldChars: 10, headChars: 200 });

    expect(result.arguments).toBe(original);
    expect(result.digestedPaths).toEqual([]);
  });
});
