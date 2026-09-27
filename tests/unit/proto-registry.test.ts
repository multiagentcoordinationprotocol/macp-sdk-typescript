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

    it('returns the canonical protobuf type for multi-round Contribute', () => {
      expect(registry.getKnownTypeName(MODE_MULTI_ROUND, 'Contribute')).toBe(
        'macp.modes.multi_round.v1.ContributePayload',
      );
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

  describe('multi-round Contribute (protobuf + legacy JSON fallback)', () => {
    it('encodes Contribute as canonical protobuf and roundtrips', () => {
      const payload = { value: 'option_a' };
      const encoded = registry.encodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', payload);
      // Canonical protobuf: first byte is the field-1 tag (0x0A), never JSON `{`.
      expect(encoded[0]).toBe(0x0a);
      const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', encoded);
      expect(decoded).toEqual({ value: 'option_a' });
    });

    it('decodes a legacy JSON Contribute payload to { value }', () => {
      const encoded = Buffer.from('{"value":"x"}', 'utf8');
      const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', encoded);
      expect(decoded).toEqual({ value: 'x' });
    });

    it('coerces a non-string legacy JSON value to a string', () => {
      const encoded = Buffer.from('{"value":123}', 'utf8');
      const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', encoded);
      expect(decoded).toEqual({ value: '123' });
    });

    it('decodes a legacy JSON Contribute payload with leading whitespace (issue #93)', () => {
      // A first-byte `{` check (rather than parse-then-fallback) misses this:
      // the leading whitespace used to fall through to a protobuf decode of
      // non-protobuf bytes and throw, instead of decoding the JSON.
      const encoded = Buffer.from('  \n\t{"value":"deploy"}', 'utf8');
      const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', encoded);
      expect(decoded).toEqual({ value: 'deploy' });
    });

    it('decodes an empty Contribute payload via protobuf (default)', () => {
      const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', Buffer.alloc(0));
      expect(decoded).toEqual({});
    });

    describe('canonicality tie-break (issue #104)', () => {
      // Before the fix, decodeMultiRoundContribute tried JSON.parse first and
      // trusted any successful parse unconditionally. The canonical proto tag
      // byte for field 1 (0x0A) is itself insignificant JSON whitespace, so a
      // canonical ContributePayload at specific value byte-lengths silently
      // misread as a JSON number/string/object — most collapsing to total
      // data loss (`String(undefined ?? '') === ''`). isCanonicalProto closes
      // this by only trusting a JSON parse when the same bytes are NOT also
      // the exact canonical proto encoding.

      it('decodes the exact collision bytes from issue #104 instead of losing the value', () => {
        // Canonical wire bytes for ContributePayload{ value: "9".repeat(45) }:
        // tag 0x0a, length 0x2d (=45), then 45 '9' bytes (0x39). Length 45
        // makes the length byte '-' (0x2d), a JSON-significant sign, so
        // JSON.parse used to succeed on a bare JSON number and silently
        // return { value: '' }.
        const wire = Buffer.from('0a2d' + '39'.repeat(45), 'hex');
        const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', wire);
        expect(decoded).toEqual({ value: '9'.repeat(45) });
      });

      it('round-trips canonical Contribute values at every collision-prone length, 1-127, across seven value shapes', () => {
        // Mirrors macp-sdk-python's test_canonical_proto_round_trips_at_every_collision_length.
        // The two collision mechanisms: (1) the single-byte length varint is
        // itself a JSON-significant opener (digit, '-', '"', '{'), so the
        // value's own bytes continue that literal; (2) the length varint is
        // itself JSON whitespace (0x09/0x0A/0x0D/0x20), handing the opening
        // character to the value's own first byte. Every length >= 128 is
        // immune: at 128-16383 the two-byte varint is never valid UTF-8 (a
        // lead-byte/continuation mismatch), and at >= 16384 the three-byte
        // varint sometimes is, but only ever decodes to a non-ASCII char that
        // can never open a JSON value. So 1-127 is the complete risk range.
        // Verified non-empty (corrupting)
        // before this fix — across these seven shapes specifically — at
        // lengths 9, 10, 13, 32, 34 (quoteShaped), 45, 48 (decimalShaped),
        // 49-57, and 123; empty (zero corruption) after.
        const shapeBuilders: Record<string, (len: number) => string | undefined> = {
          digitsNonzero: (len) => '9'.repeat(len),
          digitsZero: (len) => '0'.repeat(len),
          leadingNonzeroDigit: (len) => '1' + '2'.repeat(Math.max(len - 1, 0)),
          jsonObjectShaped: (len) => (len >= 8 ? '{"a":"' + 'x'.repeat(len - 8) + '"}' : undefined),
          jsonValueKeyShaped: (len) => (len >= 11 ? '"value":"' + 'x'.repeat(len - 11) + '"}' : undefined),
          // quote-shaped (issue #104's own reproducer table): the length
          // varint at 34 is itself '"' (0x22), so a 34-byte value ending in
          // a literal quote continues the JSON string literal.
          quoteShaped: (len) => (len >= 1 ? 'x'.repeat(len - 1) + '"' : undefined),
          // decimal-shaped (issue #104's own reproducer table): the length
          // varint at 48 is itself '0' (0x30), so a 48-byte value starting
          // with '.' continues that digit as a JSON decimal-number literal.
          decimalShaped: (len) => (len >= 1 ? '.' + '1'.repeat(len - 1) : undefined),
        };

        const failures: string[] = [];
        for (let len = 1; len <= 127; len++) {
          for (const [shapeName, build] of Object.entries(shapeBuilders)) {
            const value = build(len);
            if (value === undefined || value.length !== len) continue;
            const wire = registry.encodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', { value });
            const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', wire);
            if (!decoded || decoded.value !== value) {
              failures.push(`${shapeName} len=${len}: got ${JSON.stringify(decoded)}`);
            }
          }
        }
        expect(failures).toEqual([]);
      });

      it('does not change decoding of non-canonical, non-dict JSON values', () => {
        // These never collided (they aren't canonical proto bytes for any
        // ContributePayload), so isCanonicalProto must return false and the
        // existing coercion-to-string behavior must be unchanged.
        expect(registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', Buffer.from('0'))).toEqual({
          value: '',
        });
        expect(registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', Buffer.from('[]'))).toEqual({
          value: '',
        });
        expect(registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', Buffer.from('true'))).toEqual({
          value: '',
        });
        expect(registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', Buffer.from('"x"'))).toEqual({
          value: '',
        });
      });

      it.each([
        { prefix: '\t', length: 29 },
        { prefix: ' ', length: 108 },
        { prefix: '   ', length: 108 },
      ])(
        'treats whitespace-prefixed legacy JSON as JSON, not proto (prefix=$prefix length=$length)',
        ({ prefix, length }) => {
          // Regression pin for the false-positive class a naive round-trip
          // check (without protobufjs discarding unknown fields on decode)
          // would be vulnerable to: these bytes are NOT canonical proto (the
          // prefix byte isn't field 1's tag 0x0A), so a round-trip through
          // ContributePayload must fail and the JSON reading must win.
          const value = 'z'.repeat(length);
          const legacy = Buffer.from(prefix + JSON.stringify({ value }), 'utf8');
          const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', legacy);
          expect(decoded).toEqual({ value });
        },
      );

      it.each([
        { extra: '', length: 112 },
        { extra: '\r', length: 1 },
        { extra: ' ', length: 20 },
      ])(
        'documents the one residual: a literal-newline-prefixed legacy JSON that exactly matches a proto field-1 string misreads as proto (extra=$extra length=$length)',
        ({ extra, length }) => {
          // Genuinely irreducible, not a gap this tie-break merely fails to
          // close (macp-sdk-python has the symmetric case with its own
          // pinned lengths — offset by one byte here because JSON.stringify,
          // unlike Python's json.dumps, omits the space after ':'). A
          // payload whose first byte is literal 0x0A and whose remainder is
          // a complete, well-formed proto field-1 string has no unknown
          // field left to expose a round-trip mismatch on: it IS, byte for
          // byte, both a legal JSON reading and the canonical proto encoding
          // of some string. No known encoder (including this SDK's own)
          // emits a leading newline before legacy JSON, so this is priced
          // and accepted, not fixed.
          const value = 'z'.repeat(length);
          const legacy = Buffer.from('\n' + extra + JSON.stringify({ value }), 'utf8');
          const decoded = registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', legacy);
          expect(decoded).not.toEqual({ value });
        },
      );
    });

    it('returns undefined for empty unknown payload', () => {
      const decoded = registry.decodeKnownPayload('unknown', 'Unknown', Buffer.alloc(0));
      expect(decoded).toBeUndefined();
    });
  });
});
