/**
 * Unit Tests for utils/toolApprovals.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveToolApprovalState } from '../../../src/utils/toolApprovals.js';
import type { SmartState, ToolApprovalResolution } from '../../../src/types.js';

describe('toolApprovals', () => {
  describe('resolveToolApprovalState', () => {
    let baseState: SmartState;

    beforeEach(() => {
      baseState = {
        messages: [
          { role: 'user', content: 'Execute some actions' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'dangerous_action',
                  arguments: JSON.stringify({ target: 'system' }),
                },
              },
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'safe_action',
                  arguments: JSON.stringify({ data: 'test' }),
                },
              },
            ],
          },
        ],
        pendingApprovals: [
          {
            id: 'approval_1',
            toolCallId: 'call_1',
            toolName: 'dangerous_action',
            args: { target: 'system' },
            requestedAt: new Date().toISOString(),
            status: 'pending',
          },
          {
            id: 'approval_2',
            toolCallId: 'call_2',
            toolName: 'safe_action',
            args: { data: 'test' },
            requestedAt: new Date().toISOString(),
            status: 'pending',
          },
        ],
      } as SmartState;
    });

    it('should approve a single tool call', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_1'
      );
      expect(resolved?.status).toBe('approved');
    });

    it('should reject a single tool call', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: false,
        comment: 'Too risky',
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_1'
      );
      expect(resolved?.status).toBe('rejected');
    });

    it('should preserve other pending approvals', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const other = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_2'
      );
      expect(other?.status).toBe('pending');
    });

    it('should throw for non-existent tool call id', () => {
      const resolution: ToolApprovalResolution = {
        id: 'non_existent',
        approved: true,
      };

      expect(() => resolveToolApprovalState(baseState, resolution)).toThrow(
        'Pending approval not found'
      );
    });

    it('should throw for already executed approvals', () => {
      const executedState: SmartState = {
        ...baseState,
        pendingApprovals: [
          {
            id: 'approval_1',
            toolCallId: 'call_1',
            toolName: 'dangerous_action',
            args: { target: 'system' },
            requestedAt: new Date().toISOString(),
            status: 'executed',
          },
        ],
      } as SmartState;

      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      expect(() => resolveToolApprovalState(executedState, resolution)).toThrow(
        'already completed'
      );
    });

    it('should not mutate original state', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      resolveToolApprovalState(baseState, resolution);

      expect(baseState.pendingApprovals![0].status).toBe('pending');
    });

    it('should store decidedBy information', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
        decidedBy: 'user@example.com',
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_1'
      );
      expect(resolved?.decidedBy).toBe('user@example.com');
    });

    it('should store comment for rejection', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: false,
        comment: 'Security policy violation',
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_1'
      );
      expect(resolved?.comment).toBe('Security policy violation');
    });

    it('should store approvedArgs when provided', () => {
      const modifiedArgs = { target: 'sandbox' };
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
        approvedArgs: modifiedArgs,
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_1'
      );
      expect(resolved?.approvedArgs).toEqual(modifiedArgs);
    });

    it('should use original args if approvedArgs not provided', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_1'
      );
      expect(resolved?.approvedArgs).toEqual({ target: 'system' });
    });

    it('should set decidedAt timestamp', () => {
      const beforeTime = new Date().toISOString();
      
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.id === 'approval_1'
      );
      expect(resolved?.decidedAt).toBeDefined();
      expect(resolved?.decidedAt! >= beforeTime).toBe(true);
    });

    it('should update ctx with resume stage', () => {
      const resolution: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      expect(newState.ctx?.__resumeStage).toBe('tools');
      expect(newState.ctx?.__approvalResolved).toEqual({
        id: 'approval_1',
        status: 'approved',
      });
    });

    it('should handle multiple sequential resolutions', () => {
      const resolution1: ToolApprovalResolution = {
        id: 'approval_1',
        approved: true,
      };

      const resolution2: ToolApprovalResolution = {
        id: 'approval_2',
        approved: false,
      };

      let newState = resolveToolApprovalState(baseState, resolution1);
      newState = resolveToolApprovalState(newState, resolution2);

      const first = newState.pendingApprovals?.find((p) => p.id === 'approval_1');
      const second = newState.pendingApprovals?.find((p) => p.id === 'approval_2');

      expect(first?.status).toBe('approved');
      expect(second?.status).toBe('rejected');
    });

    it('should resolve by toolCallId as fallback', () => {
      const resolution: ToolApprovalResolution = {
        id: 'call_1', // Using toolCallId instead of approval id
        approved: true,
      };

      const newState = resolveToolApprovalState(baseState, resolution);

      const resolved = newState.pendingApprovals?.find(
        (p) => p.toolCallId === 'call_1'
      );
      expect(resolved?.status).toBe('approved');
    });
  });

  describe('approval workflow scenarios', () => {
    it('should support approve all workflow', () => {
      const state: SmartState = {
        messages: [],
        pendingApprovals: [
          { id: 'a1', toolCallId: 'call_1', toolName: 'tool1', args: {}, requestedAt: '', status: 'pending' },
          { id: 'a2', toolCallId: 'call_2', toolName: 'tool2', args: {}, requestedAt: '', status: 'pending' },
          { id: 'a3', toolCallId: 'call_3', toolName: 'tool3', args: {}, requestedAt: '', status: 'pending' },
        ],
      } as SmartState;

      let newState = state;
      for (const pending of state.pendingApprovals!) {
        newState = resolveToolApprovalState(newState, {
          id: pending.id,
          approved: true,
        });
      }

      const allApproved = newState.pendingApprovals!.every((p) => p.status === 'approved');
      expect(allApproved).toBe(true);
    });

    it('should support reject all workflow', () => {
      const state: SmartState = {
        messages: [],
        pendingApprovals: [
          { id: 'a1', toolCallId: 'call_1', toolName: 'tool1', args: {}, requestedAt: '', status: 'pending' },
          { id: 'a2', toolCallId: 'call_2', toolName: 'tool2', args: {}, requestedAt: '', status: 'pending' },
        ],
      } as SmartState;

      let newState = state;
      for (const pending of state.pendingApprovals!) {
        newState = resolveToolApprovalState(newState, {
          id: pending.id,
          approved: false,
          comment: 'Batch rejection',
        });
      }

      const allRejected = newState.pendingApprovals!.every((p) => p.status === 'rejected');
      expect(allRejected).toBe(true);
    });

    it('should support selective approval workflow', () => {
      const state: SmartState = {
        messages: [],
        pendingApprovals: [
          { id: 'a1', toolCallId: 'call_1', toolName: 'read_file', args: {}, requestedAt: '', status: 'pending' },
          { id: 'a2', toolCallId: 'call_2', toolName: 'delete_file', args: {}, requestedAt: '', status: 'pending' },
          { id: 'a3', toolCallId: 'call_3', toolName: 'read_file', args: {}, requestedAt: '', status: 'pending' },
        ],
      } as SmartState;

      let newState = state;
      for (const pending of state.pendingApprovals!) {
        const shouldApprove = pending.toolName === 'read_file';
        newState = resolveToolApprovalState(newState, {
          id: pending.id,
          approved: shouldApprove,
          comment: shouldApprove ? undefined : 'Delete operations not allowed',
        });
      }

      const readApprovals = newState.pendingApprovals!.filter(p => p.toolName === 'read_file');
      const deleteApprovals = newState.pendingApprovals!.filter(p => p.toolName === 'delete_file');

      expect(readApprovals.every(p => p.status === 'approved')).toBe(true);
      expect(deleteApprovals.every(p => p.status === 'rejected')).toBe(true);
    });
  });
});
