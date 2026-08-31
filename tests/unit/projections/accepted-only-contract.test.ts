/**
 * `applyEnvelope`'s accepted-only input contract, made executable.
 *
 * Every mode projection's `applyEnvelope` (see the docblocks on
 * `BaseProjection.applyEnvelope` in `src/projections/base.ts`, and the
 * one-line pointers on the five mode projections) assumes it is fed only
 * envelopes a conforming MACP runtime ACCEPTED. `Envelope` (`src/types.ts`)
 * carries no acceptance marker, so this is a caller-maintained invariant, not
 * something `applyEnvelope` can check for itself. Canonical source, verbatim:
 * `schemas/conformance/README.md` "Notes:" — "SDKs replay only `accept`
 * messages through their projections (reject-path fixtures replay their
 * accepted *prefix*)." — and RFC-MACP-0007 §5 rule 3 / RFC-MACP-0011 §5 rule 3,
 * which describe what a conforming runtime enforces on ACCEPTED history.
 *
 * This file does not test any new behavior (see issue #55). It proves, for
 * the record, that the contract is load-bearing: replaying a rejected
 * envelope through `applyEnvelope` fabricates projection state that no
 * conforming runtime ever held, and respecting the contract avoids exactly
 * that corruption. Every test below builds a small SYNTHETIC transcript
 * (never read from `tests/conformance/` — those fixtures are owned by
 * `make verify-fixtures` and their content changes upstream, independent of
 * this file) representing a session whose final `Commitment` was REJECTED by
 * the runtime (e.g. an unauthorized sender, per RFC-MACP-0007 §5 rule 4 /
 * RFC-MACP-0011 §5 — the specific reject reason is irrelevant here; only
 * "the runtime said no" matters), then applies it two ways:
 *
 * - **unfiltered** — every captured envelope, including the rejected one —
 *   the mistake this contract exists to name.
 * - **accepted-only** — only the envelopes the runtime actually accepted —
 *   the behavior the contract requires of every caller.
 *
 * Each test is deliberately independent of vote/ballot cardinality (it uses
 * exactly one `Vote`/`Approve`), so first-vote/first-ballot-stands changes
 * tracked under issue #55 cannot disturb these assertions.
 */
import { describe, expect, it } from 'vitest';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_DECISION, MODE_QUORUM } from '../../../src/constants';
import { ProtoRegistry } from '../../../src/proto-registry';
import { BaseProjection } from '../../../src/projections/base';
import { DecisionProjection } from '../../../src/projections/decision';
import { QuorumProjection } from '../../../src/projections/quorum';
import type { Envelope } from '../../../src/types';

const registry = new ProtoRegistry();

function makeEnvelope(
  mode: string,
  messageType: string,
  payload: Record<string, unknown>,
  sender = 'agent-a',
): Envelope {
  return buildEnvelope({
    mode,
    messageType,
    sessionId: 'test-session',
    sender,
    payload: registry.encodeKnownPayload(mode, messageType, payload),
  });
}

// A minimal, otherwise-valid Commitment payload. What matters for these tests
// is not its content but whether the runtime accepted it — here, by
// construction of the scenario, it did not.
function rejectedCommitmentEnvelope(mode: string, sender = 'agent-a'): Envelope {
  return makeEnvelope(
    mode,
    'Commitment',
    {
      commitmentId: 'c1',
      action: 'resolve',
      authorityScope: 'ops',
      reason: 'attempted by a sender the runtime does not authorize',
      modeVersion: '1.0.0',
      configurationVersion: 'config.default',
    },
    sender,
  );
}

// `BaseProjection` is the ext-mode extension point (see
// `tests/unit/base-session.test.ts`'s `SmokeProjection`); the accepted-only
// contract lives on `BaseProjection.applyEnvelope` itself, so out-of-tree
// custom modes inherit it for free without repeating any of this file's
// scaffolding.
const EXT_MODE = 'ext.smoke.v1';

class SmokeProjection extends BaseProjection {
  protected readonly mode = EXT_MODE;
  readonly events: string[] = [];

  protected applyMode(envelope: Envelope): void {
    this.events.push(envelope.messageType);
  }
}

describe('applyEnvelope accepted-only input contract (RFC-MACP-0007 §5.3 / RFC-MACP-0011 §5)', () => {
  it('DecisionProjection: an unfiltered replay of a rejected Commitment fabricates a resolved session; an accepted-only replay does not', () => {
    const envelopes: Envelope[] = [
      makeEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'deploy-v2' }),
      makeEnvelope(MODE_DECISION, 'Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'),
      // The runtime rejected this Commitment (e.g. unauthorized sender) — it
      // never entered accepted history. A conforming caller must not replay it.
      rejectedCommitmentEnvelope(MODE_DECISION),
    ];

    // Caller mistake: feed every captured envelope, rejected ones included.
    const unfiltered = new DecisionProjection();
    for (const envelope of envelopes) unfiltered.applyEnvelope(envelope, registry);
    expect(unfiltered.isCommitted).toBe(true);
    expect(unfiltered.phase).toBe('Committed');

    // Contract-respecting caller: feed only the accepted prefix.
    const acceptedOnly = new DecisionProjection();
    for (const envelope of envelopes.slice(0, 2)) acceptedOnly.applyEnvelope(envelope, registry);
    expect(acceptedOnly.isCommitted).toBe(false);
    expect(acceptedOnly.phase).toBe('Voting');
  });

  it('QuorumProjection: an unfiltered replay of a rejected Commitment fabricates a resolved session; an accepted-only replay does not', () => {
    const envelopes: Envelope[] = [
      makeEnvelope(MODE_QUORUM, 'ApprovalRequest', {
        requestId: 'r1',
        action: 'deploy',
        summary: 'deploy v2',
        requiredApprovals: 2,
      }),
      makeEnvelope(MODE_QUORUM, 'Approve', { requestId: 'r1' }, 'alice'),
      // Rejected by the runtime — same reasoning as the Decision case above.
      rejectedCommitmentEnvelope(MODE_QUORUM),
    ];

    const unfiltered = new QuorumProjection();
    for (const envelope of envelopes) unfiltered.applyEnvelope(envelope, registry);
    expect(unfiltered.isCommitted).toBe(true);
    expect(unfiltered.phase).toBe('Committed');

    const acceptedOnly = new QuorumProjection();
    for (const envelope of envelopes.slice(0, 2)) acceptedOnly.applyEnvelope(envelope, registry);
    expect(acceptedOnly.isCommitted).toBe(false);
    expect(acceptedOnly.phase).toBe('Voting');
  });

  it('BaseProjection subclass (ext-mode, e.g. a custom/out-of-tree mode): an unfiltered replay of a rejected Commitment fabricates a resolved session; an accepted-only replay does not', () => {
    const envelopes: Envelope[] = [
      buildEnvelope({
        mode: EXT_MODE,
        messageType: 'SomeExtEvent',
        sessionId: 'test-session',
        sender: 'agent-a',
        payload: Buffer.alloc(0),
      }),
      // Rejected by the runtime, same as the two mode-specific cases above.
      // `Commitment` resolves through the CORE_MAP regardless of `mode`
      // (`src/proto-registry.ts`), so this decodes for an ext mode too.
      rejectedCommitmentEnvelope(EXT_MODE),
    ];

    const unfiltered = new SmokeProjection();
    for (const envelope of envelopes) unfiltered.applyEnvelope(envelope, registry);
    expect(unfiltered.isCommitted).toBe(true);
    expect(unfiltered.phase).toBe('Committed');

    const acceptedOnly = new SmokeProjection();
    for (const envelope of envelopes.slice(0, 1)) acceptedOnly.applyEnvelope(envelope, registry);
    expect(acceptedOnly.isCommitted).toBe(false);
    expect(acceptedOnly.phase).toBe('');
    // Prove the accepted envelope was actually applied via `applyMode`
    // (not just that the rejected Commitment was skipped) — otherwise the
    // two assertions above would pass identically for a no-op `applyMode`.
    expect(acceptedOnly.events).toEqual(['SomeExtEvent']);
    expect(acceptedOnly.transcript.length).toBe(1);
  });
});
