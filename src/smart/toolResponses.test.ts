import { describe, expect, it } from 'vitest';

import { normalizeSmartAgentOptions } from './runtimeConfig.js';
import { classifyToolResponse, resolveSummarizationRetention, renderRetainedToolMessage } from './toolResponses.js';

describe('toolResponses', () => {
  it('classifies critical tools regardless of payload size', () => {
    const config = normalizeSmartAgentOptions({ model: {} as any } as any);
    const classification = classifyToolResponse('get_tool_response', { ok: true, rows: [1, 2, 3] }, config);
    expect(classification).toBe('critical');
  });

  it('keeps critical tool responses full at summarization time', () => {
    const config = normalizeSmartAgentOptions({
      model: {} as any,
      toolResponses: { defaultPolicy: 'summarize_archive' },
    } as any);

    const policy = resolveSummarizationRetention('get_tool_response', config);
    expect(policy).toBe('keep_full');
  });

  it('honors per-tool override over the default policy', () => {
    const config = normalizeSmartAgentOptions({
      model: {} as any,
      toolResponses: {
        defaultPolicy: 'summarize_archive',
        toolResponseRetentionByTool: { read_skills: 'keep_full' },
      },
    } as any);

    expect(resolveSummarizationRetention('read_skills', config)).toBe('keep_full');
    expect(resolveSummarizationRetention('some_other_tool', config)).toBe('summarize_archive');
  });

  it('renders archive placeholder with executionId pointer', () => {
    const message = renderRetainedToolMessage({
      policy: 'summarize_archive',
      toolName: 'crm_list_logs',
      toolCallId: 'call_123',
      executionId: 'exec_123',
      rawOutput: { rows: Array.from({ length: 50 }, (_, i) => ({ id: i })) },
    });

    expect(message).toContain('ARCHIVED_TOOL_RESPONSE');
    expect(message).toContain('toolName=crm_list_logs');
    expect(message).toContain('executionId=exec_123');
    expect(message).toContain('get_tool_response');
  });
});
