import { describe, it, expect, beforeEach } from 'vitest';
import { ProposalProjection } from '../../../src/projections/proposal';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_PROPOSAL } from '../../../src/constants';

const registry = new ProtoRegistry();

function makeEnvelope(messageType: string, payload: Record<string, unknown>, sender = 'agent-a') {
  return buildEnvelope({
    mode: MODE_PROPOSAL,
    messageType,
    sessionId: 'test-session',
    sender,
    payload: registry.encodeKnownPayload(MODE_PROPOSAL, messageType, payload),
  });
}

describe('ProposalProjection', () => {
  let projection: ProposalProjection;

  beforeEach(() => {
    projection = new ProposalProjection();
  });

  it('starts in Negotiating phase', () => {
    expect(projection.phase).toBe('Negotiating');
  });

  it('tracks proposals', () => {
    projection.applyEnvelope(
      makeEnvelope('Proposal', { proposalId: 'p1', title: 'Plan A', summary: 'do it', tags: ['urgent'] }),
      registry,
    );
    expect(projection.proposals.size).toBe(1);
    expect(projection.proposals.get('p1')).toMatchObject({
      proposalId: 'p1',
      title: 'Plan A',
      status: 'open',
      sender: 'agent-a',
    });
    expect(projection.phase).toBe('Negotiating');
  });

  it('tracks counter-proposals with supersedes link', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'Plan A' }), registry);
    projection.applyEnvelope(
      makeEnvelope('CounterProposal', { proposalId: 'p2', supersedesProposalId: 'p1', title: 'Plan B' }, 'bob'),
      registry,
    );
    expect(projection.proposals.size).toBe(2);
    expect(projection.proposals.get('p2')?.supersedes).toBe('p1');
    expect(projection.proposals.get('p2')?.sender).toBe('bob');
  });

  it('tracks accepts', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'X' }), registry);
    projection.applyEnvelope(makeEnvelope('Accept', { proposalId: 'p1', reason: 'looks good' }, 'bob'), registry);
    expect(projection.accepts).toHaveLength(1);
    expect(projection.isAccepted('p1')).toBe(true);
    expect(projection.isAccepted('p2')).toBe(false);
  });

  // RFC-MACP-0008 §5 rule 5 (`:70`): "The latest accepted Accept from a
  // participant supersedes earlier accepts from the same participant."
  it('a later Accept from the same sender supersedes their earlier one', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'A' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', title: 'B' }), registry);
    projection.applyEnvelope(makeEnvelope('Accept', { proposalId: 'p1', reason: 'first choice' }, 'bob'), registry);
    projection.applyEnvelope(makeEnvelope('Accept', { proposalId: 'p2', reason: 'changed my mind' }, 'bob'), registry);

    // Full history is retained for audit...
    expect(projection.accepts).toHaveLength(2);
    // ...but the live acceptance set reflects only bob's current accept.
    expect(projection.isAccepted('p1')).toBe(false);
    expect(projection.isAccepted('p2')).toBe(true);
    expect(projection.acceptedProposal()).toBe('p2');
  });

  // Old (wrong) behaviour: acceptedProposal() used to build a Set of every
  // historical accept's proposalId and return undefined once that set held
  // more than one entry — even though the RFC makes the acceptance set
  // unambiguously {p2} after a legal re-accept. This is the shipped
  // violation the triage table (Phase 3, site 3) identified.
  it('acceptedProposal is no longer fooled by a superseded accept into returning undefined', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'A' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', title: 'B' }), registry);
    projection.applyEnvelope(makeEnvelope('Accept', { proposalId: 'p1', reason: 'first choice' }, 'bob'), registry);
    projection.applyEnvelope(makeEnvelope('Accept', { proposalId: 'p2', reason: 'changed my mind' }, 'bob'), registry);

    expect(projection.acceptedProposal()).not.toBeUndefined();
    expect(projection.acceptedProposal()).toBe('p2');
  });

  it('acceptedProposal stays undefined when two different senders currently accept different proposals', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'A' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', title: 'B' }), registry);
    projection.applyEnvelope(makeEnvelope('Accept', { proposalId: 'p1', reason: 'ok' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Accept', { proposalId: 'p2', reason: 'ok' }, 'bob'), registry);

    expect(projection.acceptedProposal()).toBeUndefined();
  });

  it('tracks terminal rejections and transitions to TerminalRejected phase', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'X' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Reject', { proposalId: 'p1', terminal: true, reason: 'no' }, 'bob'),
      registry,
    );
    expect(projection.isTerminallyRejected('p1')).toBe(true);
    expect(projection.proposals.get('p1')?.status).toBe('rejected');
    expect(projection.phase).toBe('TerminalRejected');
    expect(projection.hasTerminalRejection()).toBe(true);
  });

  it('non-terminal rejections do not change proposal status or phase', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'X' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Reject', { proposalId: 'p1', terminal: false, reason: 'not yet' }, 'bob'),
      registry,
    );
    expect(projection.isTerminallyRejected('p1')).toBe(false);
    expect(projection.proposals.get('p1')?.status).toBe('open');
    expect(projection.phase).toBe('Negotiating');
    expect(projection.hasTerminalRejection()).toBe(false);
  });

  it('tracks withdrawals', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'X' }), registry);
    projection.applyEnvelope(makeEnvelope('Withdraw', { proposalId: 'p1', reason: 'changed mind' }), registry);
    expect(projection.proposals.get('p1')?.status).toBe('withdrawn');
  });

  it('activeProposals returns only open proposals', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'A' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', title: 'B' }), registry);
    projection.applyEnvelope(makeEnvelope('Withdraw', { proposalId: 'p1' }), registry);
    expect(projection.activeProposals()).toHaveLength(1);
    expect(projection.activeProposals()[0].proposalId).toBe('p2');
  });

  it('latestProposal returns most recently added', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', title: 'A' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', title: 'B' }), registry);
    expect(projection.latestProposal()?.proposalId).toBe('p2');
  });

  it('commitment transitions to Committed phase', () => {
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'proposal.accepted',
        authorityScope: 'team',
        reason: 'done',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.phase).toBe('Committed');
    expect(projection.commitment).toBeDefined();
  });
});
