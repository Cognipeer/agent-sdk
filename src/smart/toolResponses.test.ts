import { describe, expect, it } from 'vitest';

import { normalizeSmartAgentOptions } from './runtimeConfig.js';
import { resolveToolResponsePolicy } from './toolResponses.js';

describe('toolResponses', () => {
  it('uses fallback policy for critical tools when no per-tool override is present', () => {
    const config = normalizeSmartAgentOptions({
      model: {} as any,
      toolResponses: {
        defaultPolicy: 'keep_full',
        largeResponsePolicy: 'keep_full',
        fallbackPolicy: 'keep_full',
      },
    } as any);

    const result = resolveToolResponsePolicy('get_tool_response', { ok: true, rows: [1, 2, 3] }, config);

    expect(result.classification).toBe('critical');
    expect(result.retentionPolicy).toBe('keep_full');
    expect(result.content).toContain('"ok":true');
  });
});