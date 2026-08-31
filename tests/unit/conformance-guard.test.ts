/**
 * Unit tests for the Phase 6 (issue #55) duplicate-vote/-ballot predicate,
 * `duplicateAcceptedBallots` (`tests/conformance/duplicate-ballots.ts`),
 * against synthetic input.
 *
 * Deliberately NOT importing from `tests/conformance/conformance.test.ts` —
 * that file registers three module-scope `describe` blocks over the real
 * fixture set, and importing anything from it here would re-register the
 * whole conformance suite inside this unit test file. The predicate lives in
 * its own non-test module for exactly this reason; see that module's
 * docblock.
 */
import { describe, expect, it } from 'vitest';
import { duplicateAcceptedBallots, type DuplicateBallotCandidateMessage } from '../conformance/duplicate-ballots';

describe('duplicateAcceptedBallots', () => {
  it('returns [] for no messages', () => {
    expect(duplicateAcceptedBallots([])).toEqual([]);
  });

  it('detects a duplicate accepted Vote (same sender, same proposal_id)', () => {
    const messages: DuplicateBallotCandidateMessage[] = [
      {
        sender: 'agent://alice',
        message_type: 'Vote',
        payload_type: 'macp.modes.decision.v1.VotePayload',
        payload: { proposal_id: 'p1', vote: 'reject' },
        expect: 'accept',
      },
      {
        sender: 'agent://alice',
        message_type: 'Vote',
        payload_type: 'macp.modes.decision.v1.VotePayload',
        payload: { proposal_id: 'p1', vote: 'approve' },
        expect: 'accept',
      },
    ];
    const result = duplicateAcceptedBallots(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ sender: 'agent://alice', id: 'p1', messageType: 'Vote' });
  });

  it('detects a duplicate accepted ballot ACROSS types (Approve then Abstain)', () => {
    const messages: DuplicateBallotCandidateMessage[] = [
      {
        sender: 'agent://alice',
        message_type: 'Approve',
        payload_type: 'macp.modes.quorum.v1.ApprovePayload',
        payload: { request_id: 'r1', reason: 'lgtm' },
        expect: 'accept',
      },
      {
        sender: 'agent://alice',
        message_type: 'Abstain',
        payload_type: 'macp.modes.quorum.v1.AbstainPayload',
        payload: { request_id: 'r1' },
        expect: 'accept',
      },
    ];
    const result = duplicateAcceptedBallots(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ sender: 'agent://alice', id: 'r1', messageType: 'Abstain' });
  });

  it('does not count a duplicate when one of the pair is expect: reject', () => {
    const messages: DuplicateBallotCandidateMessage[] = [
      {
        sender: 'agent://alice',
        message_type: 'Vote',
        payload_type: 'macp.modes.decision.v1.VotePayload',
        payload: { proposal_id: 'p1', vote: 'reject' },
        expect: 'reject',
      },
      {
        sender: 'agent://alice',
        message_type: 'Vote',
        payload_type: 'macp.modes.decision.v1.VotePayload',
        payload: { proposal_id: 'p1', vote: 'approve' },
        expect: 'accept',
      },
    ];
    expect(duplicateAcceptedBallots(messages)).toEqual([]);
  });

  it('same sender on two DIFFERENT request_ids is not a duplicate (different message types, mutation-b-safe)', () => {
    const messages: DuplicateBallotCandidateMessage[] = [
      {
        sender: 'agent://alice',
        message_type: 'Approve',
        payload_type: 'macp.modes.quorum.v1.ApprovePayload',
        payload: { request_id: 'r1' },
        expect: 'accept',
      },
      {
        sender: 'agent://alice',
        message_type: 'Reject',
        payload_type: 'macp.modes.quorum.v1.RejectPayload',
        payload: { request_id: 'r2' },
        expect: 'accept',
      },
    ];
    expect(duplicateAcceptedBallots(messages)).toEqual([]);
  });

  it('the real quorum_reject_paths.json shape: two Approve from agent://alice on r1, the first expect: reject', () => {
    const messages: DuplicateBallotCandidateMessage[] = [
      {
        sender: 'agent://alice',
        message_type: 'Approve',
        payload_type: 'macp.modes.quorum.v1.ApprovePayload',
        payload: { request_id: 'r1', reason: 'lgtm' },
        expect: 'reject',
      },
      {
        sender: 'agent://coordinator',
        message_type: 'ApprovalRequest',
        payload_type: 'macp.modes.quorum.v1.ApprovalRequestPayload',
        payload: { request_id: 'r1', action: 'deploy', summary: 'Deploy v2', required_approvals: 2 },
        expect: 'accept',
      },
      {
        sender: 'agent://alice',
        message_type: 'Approve',
        payload_type: 'macp.modes.quorum.v1.ApprovePayload',
        payload: { request_id: 'r1', reason: 'lgtm' },
        expect: 'accept',
      },
    ];
    expect(duplicateAcceptedBallots(messages)).toEqual([]);
  });

  // Trap (see the plan's Context / duplicate-ballots.ts docblock): `Reject`
  // is ALSO a Proposal-mode message type with no `request_id`
  // (`proposal_negative_outcome.json`). Two accepted Proposal `Reject`s from
  // the same sender must NOT be flagged as a duplicate ballot — the mode gate
  // (payload_type prefix) excludes them from the ballot bucket entirely,
  // regardless of what their (nonexistent) request_id would resolve to.
  it('a proposal-mode Reject pair does not collide via the ballot arm (trap)', () => {
    const messages: DuplicateBallotCandidateMessage[] = [
      {
        sender: 'agent://buyer',
        message_type: 'Reject',
        payload_type: 'macp.modes.proposal.v1.RejectPayload',
        payload: { proposal_id: 'p1', reason: 'terms unacceptable', terminal: true },
        expect: 'accept',
      },
      {
        sender: 'agent://buyer',
        message_type: 'Reject',
        payload_type: 'macp.modes.proposal.v1.RejectPayload',
        payload: { proposal_id: 'p2', reason: 'still unacceptable', terminal: true },
        expect: 'accept',
      },
    ];
    expect(duplicateAcceptedBallots(messages)).toEqual([]);
  });
});
