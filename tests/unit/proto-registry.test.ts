import { describe, it, expect } from 'vitest';
import { ProtoRegistry } from '../../src/proto-registry';
import {
  MODE_DECISION,
  MODE_PROPOSAL,
  MODE_TASK,
  MODE_HANDOFF,
  MODE_QUORUM,
  MODE_MULTI_ROUND,
} from '../../src/constants';

const registry = new ProtoRegistry();

describe('ProtoRegistry', () => {
  describe('getKnownTypeName', () => {
    it('resolves core message types', () => {
      expect(registry.getKnownTypeName('', 'SessionStart')).toBe('macp.v1.SessionStartPayload');
      expect(registry.getKnownTypeName('', 'Commitment')).toBe('macp.v1.CommitmentPayload');
      expect(registry.getKnownTypeName('', 'Signal')).toBe('macp.v1.SignalPayload');
      expect(registry.getKnownTypeName('', 'Progress')).toBe('macp.v1.ProgressPayload');
    });

    it('resolves decision mode types', () => {
      expect(registry.getKnownTypeName(MODE_DECISION, 'Proposal')).toBe('macp.modes.decision.v1.ProposalPayload');
      expect(registry.getKnownTypeName(MODE_DECISION, 'Vote')).toBe('macp.modes.decision.v1.VotePayload');
    });

    it('resolves proposal mode types', () => {
      expect(registry.getKnownTypeName(MODE_PROPOSAL, 'Proposal')).toBe('macp.modes.proposal.v1.ProposalPayload');
      expect(registry.getKnownTypeName(MODE_PROPOSAL, 'CounterProposal')).toBe(
        'macp.modes.proposal.v1.CounterProposalPayload',
      );
    });

    it('resolves task mode types', () => {
      expect(registry.getKnownTypeName(MODE_TASK, 'TaskRequest')).toBe('macp.modes.task.v1.TaskRequestPayload');
      expect(registry.getKnownTypeName(MODE_TASK, 'TaskComplete')).toBe('macp.modes.task.v1.TaskCompletePayload');
    });

    it('resolves handoff mode types', () => {
      expect(registry.getKnownTypeName(MODE_HANDOFF, 'HandoffOffer')).toBe('macp.modes.handoff.v1.HandoffOfferPayload');
      expect(registry.getKnownTypeName(MODE_HANDOFF, 'HandoffAccept')).toBe(
        'macp.modes.handoff.v1.HandoffAcceptPayload',
      );
    });

    it('resolves quorum mode types', () => {
      expect(registry.getKnownTypeName(MODE_QUORUM, 'ApprovalRequest')).toBe(
        'macp.modes.quorum.v1.ApprovalRequestPayload',
      );
      expect(registry.getKnownTypeName(MODE_QUORUM, 'Approve')).toBe('macp.modes.quorum.v1.ApprovePayload');
    });

    it('returns __json__ for multi-round Contribute', () => {
      expect(registry.getKnownTypeName(MODE_MULTI_ROUND, 'Contribute')).toBe('__json__');
    });

    it('returns undefined for unknown types', () => {
      expect(registry.getKnownTypeName('unknown.mode', 'Unknown')).toBeUndefined();
    });
  });

  describe('encode/decode roundtrip', () => {
    const roundtrips: Array<{ mode: string; type: string; payload: Record<string, unknown> }> = [
      { mode: MODE_DECISION, type: 'Proposal', payload: { proposalId: 'p1', option: 'deploy', rationale: 'ready' } },
      {
        mode: MODE_DECISION,
        type: 'Evaluation',
        payload: { proposalId: 'p1', recommendation: 'approve', confidence: 0.95 },
      },
      { mode: MODE_DECISION, type: 'Objection', payload: { proposalId: 'p1', reason: 'risk', severity: 'high' } },
      { mode: MODE_DECISION, type: 'Vote', payload: { proposalId: 'p1', vote: 'approve', reason: 'ok' } },
      { mode: MODE_PROPOSAL, type: 'Proposal', payload: { proposalId: 'p1', title: 'Plan A', summary: 'do it' } },
      {
        mode: MODE_PROPOSAL,
        type: 'CounterProposal',
        payload: { proposalId: 'p2', supersedesProposalId: 'p1', title: 'Plan B' },
      },
      { mode: MODE_PROPOSAL, type: 'Accept', payload: { proposalId: 'p1', reason: 'yes' } },
      { mode: MODE_PROPOSAL, type: 'Reject', payload: { proposalId: 'p1', terminal: true, reason: 'no' } },
      { mode: MODE_PROPOSAL, type: 'Withdraw', payload: { proposalId: 'p1', reason: 'changed mind' } },
      { mode: MODE_TASK, type: 'TaskRequest', payload: { taskId: 't1', title: 'Build', instructions: 'do it' } },
      { mode: MODE_TASK, type: 'TaskAccept', payload: { taskId: 't1', assignee: 'w' } },
      { mode: MODE_TASK, type: 'TaskComplete', payload: { taskId: 't1', assignee: 'w', summary: 'done' } },
      { mode: MODE_TASK, type: 'TaskFail', payload: { taskId: 't1', assignee: 'w', errorCode: 'E1', retryable: true } },
      {
        mode: MODE_HANDOFF,
        type: 'HandoffOffer',
        payload: { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' },
      },
      { mode: MODE_HANDOFF, type: 'HandoffContext', payload: { handoffId: 'h1', contentType: 'application/json' } },
      { mode: MODE_HANDOFF, type: 'HandoffAccept', payload: { handoffId: 'h1', acceptedBy: 'bob' } },
      { mode: MODE_HANDOFF, type: 'HandoffDecline', payload: { handoffId: 'h1', declinedBy: 'bob', reason: 'busy' } },
      {
        mode: MODE_QUORUM,
        type: 'ApprovalRequest',
        payload: { requestId: 'r1', action: 'deploy', summary: 'v2', requiredApprovals: 2 },
      },
      { mode: MODE_QUORUM, type: 'Approve', payload: { requestId: 'r1', reason: 'ok' } },
      { mode: MODE_QUORUM, type: 'Reject', payload: { requestId: 'r1', reason: 'no' } },
      { mode: MODE_QUORUM, type: 'Abstain', payload: { requestId: 'r1', reason: 'neutral' } },
    ];

    for (const { mode, type, payload } of roundtrips) {
      it(`${mode.split('.').pop()} / ${type}`, () => {
        const encoded = registry.encodeKnownPayload(mode, type, payload);
        expect(encoded).toBeInstanceOf(Buffer);
        expect(encoded.length).toBeGreaterThan(0);

        const decoded = registry.decodeKnownPayload(mode, type, encoded);
        for (const [key, value] of Object.entries(payload)) {
          expect(decoded).toHaveProperty(key, value);
        }
      });
    }
  });

  describe('Commitment supersession (proto 0.1.3)', () => {
    it('roundtrips a CommitmentPayload with a supersedes CommitmentRef', () => {
      const payload = {
        commitmentId: 'c1',
        action: 'decision.approved',
        authorityScope: 'session',
        reason: 'revised',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
        policyVersion: 'policy.default',
        outcomePositive: true,
        supersedes: { sessionId: 'prior-session', commitmentHash: 'abc123' },
      };
      const encoded = registry.encodeKnownPayload('', 'Commitment', payload);
      const decoded = registry.decodeKnownPayload('', 'Commitment', encoded);
      expect(decoded).toHaveProperty('supersedes', { sessionId: 'prior-session', commitmentHash: 'abc123' });
      expect(decoded).toHaveProperty('action', 'decision.approved');
    });

    it('omits supersedes when absent', () => {
      const payload = {
        commitmentId: 'c2',
        action: 'task.completed',
        authorityScope: 'session',
        reason: 'done',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
        policyVersion: 'policy.default',
        outcomePositive: true,
      };
      const encoded = registry.encodeKnownPayload('', 'Commitment', payload);
      const decoded = registry.decodeKnownPayload('', 'Commitment', encoded);
      expect(decoded).not.toHaveProperty('supersedes');
    });
  });

  describe('JSON fallback', () => {
    it('encodes multi-round Contribute as JSON', () => {
      const payload = { round: 1, content: 'hello' };
      const encoded = registry.encodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', payload);
      expect(JSON.parse(encoded.toString('utf8'))).toEqual(payload);
    });

    it('decodes multi-round Contribute as JSON', () => {
      const payload = { round: 1, content: 'hello' };
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
      const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', encoded);
      expect(decoded).toHaveProperty('encoding', 'json');
      expect(decoded).toHaveProperty('json');
    });

    it('returns undefined for empty unknown payload', () => {
      const decoded = registry.decodeKnownPayload('unknown', 'Unknown', Buffer.alloc(0));
      expect(decoded).toBeUndefined();
    });
  });
});
