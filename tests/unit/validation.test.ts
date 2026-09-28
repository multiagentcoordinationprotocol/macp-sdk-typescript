import { describe, it, expect } from 'vitest';
import {
  validateSessionId,
  validateVote,
  validateRecommendation,
  validateConfidence,
  validateSeverity,
  validateParticipantCount,
  validateSignalType,
  validateProgressScope,
  validateTtlMs,
  validateMaxSuspendMs,
  validateParticipants,
  validateRequiredField,
  validateSessionStart,
  validateCommitmentHash,
} from '../../src/validation';
import { MacpSessionError } from '../../src/errors';
import { newSessionId } from '../../src/envelope';

describe('validation', () => {
  describe('validateSessionId', () => {
    it('accepts UUID v4', () => {
      expect(() => validateSessionId('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
    });

    it('accepts base64url (22+ chars)', () => {
      expect(() => validateSessionId('abcdefghij1234567890_-')).not.toThrow();
      expect(() => validateSessionId('abcdefghij1234567890_-extra')).not.toThrow();
    });

    it('accepts a 36-char base64url token containing a hyphen (runtime 0.5.0 A4)', () => {
      // Regression for the runtime fix: 36-char base64url IDs with `-` are
      // accepted, no longer mis-routed to UUID validation. This token is 36
      // chars, contains a hyphen, and is deliberately NOT UUID-shaped (no
      // 8-4-4-4-12 dash grouping), so it exercises the base64url branch.
      const id = 'Zm9vYmFyLWJhemJhdF9xdXV4MTIzNDU2Nzg5'; // 37? ensure 36 below
      const token36 = 'ab_cd-efghij0123456789ABCDEFGHIJ-klm'; // 36 chars, has '-'
      expect(token36.length).toBe(36);
      expect(() => validateSessionId(token36)).not.toThrow();
      expect(() => validateSessionId(id)).not.toThrow();
    });

    it('rejects short strings', () => {
      expect(() => validateSessionId('short')).toThrow(MacpSessionError);
    });

    it('rejects invalid UUID format', () => {
      expect(() => validateSessionId('not-a-uuid-at-all-xx')).toThrow(MacpSessionError);
    });

    it('rejects empty string', () => {
      expect(() => validateSessionId('')).toThrow(MacpSessionError);
    });

    // Issue #108.1: the runtime's rule is no-fall-through — a UUID-shaped
    // string is validated strictly as a lowercase v4/v7 UUID, never
    // reinterpreted as base64url. All four of these are accepted by the
    // pre-fix code (verified in the plan) because they satisfy the old
    // combined-regex OR: they are 36-char, hyphenated, hex-only strings,
    // which the base64url branch's charset also happens to accept.
    it.each([
      ['an uppercase UUID', '550E8400-E29B-41D4-A716-446655440000'],
      ['a lowercase v1 UUID', '550e8400-e29b-11d4-a716-446655440000'],
      ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
      ['a UUID with variant nibble c', '550e8400-e29b-41d4-c716-446655440000'],
    ])('issue #108.1: rejects %s (UUID-shaped but not v4/v7) — fails on old code', (_label, sid) => {
      expect(() => validateSessionId(sid)).toThrow(MacpSessionError);
    });

    it('accepts a lowercase v7 UUID', () => {
      // Version nibble 7, variant nibble in [89ab].
      expect(() => validateSessionId('017f22e2-79b0-7cc3-98c4-dc0c0c07398f')).not.toThrow();
    });

    it('issue #108.1 no-fall-through pin: an uppercase UUID is rejected even though it satisfies the base64url charset', () => {
      // This is the test that fails if someone reinstates the old `||`
      // (try-UUID-then-fall-through-to-base64url) structure: the string
      // below is 36 chars of [A-Za-z0-9_-], so the base64url regex alone
      // would accept it. The no-fall-through rule must reject it anyway,
      // because it is UUID-shaped and not a valid v4/v7 UUID.
      const uppercaseUuid = '550E8400-E29B-41D4-A716-446655440000';
      expect(uppercaseUuid).toMatch(/^[A-Za-z0-9_-]{22,}$/);
      expect(() => validateSessionId(uppercaseUuid)).toThrow(MacpSessionError);
    });

    it("the UUID-shaped rejection message differs from the not-an-id-shape message, and neither claims a check the code doesn't perform", () => {
      let uuidShapedMessage = '';
      try {
        validateSessionId('550E8400-E29B-41D4-A716-446655440000');
      } catch (err) {
        uuidShapedMessage = (err as Error).message;
      }
      let notIdShapedMessage = '';
      try {
        validateSessionId('not-a-uuid-at-all-xx');
      } catch (err) {
        notIdShapedMessage = (err as Error).message;
      }
      expect(uuidShapedMessage).not.toBe('');
      expect(notIdShapedMessage).not.toBe('');
      expect(uuidShapedMessage).not.toBe(notIdShapedMessage);
      expect(uuidShapedMessage).toContain('UUID-shaped');
      expect(uuidShapedMessage).toContain('no fall-through to base64url');
    });

    it('newSessionId() output passes validateSessionId (100 consecutive draws)', () => {
      for (let i = 0; i < 100; i++) {
        expect(() => validateSessionId(newSessionId())).not.toThrow();
      }
    });
  });

  describe('validateVote', () => {
    it('accepts valid votes and normalizes to uppercase', () => {
      expect(validateVote('approve')).toBe('APPROVE');
      expect(validateVote('REJECT')).toBe('REJECT');
      expect(validateVote('Abstain')).toBe('ABSTAIN');
    });

    it('rejects invalid vote values', () => {
      expect(() => validateVote('yes')).toThrow(MacpSessionError);
      expect(() => validateVote('maybe')).toThrow(MacpSessionError);
    });
  });

  describe('validateRecommendation', () => {
    it('accepts valid recommendations and normalizes', () => {
      expect(validateRecommendation('approve')).toBe('APPROVE');
      expect(validateRecommendation('REVIEW')).toBe('REVIEW');
      expect(validateRecommendation('block')).toBe('BLOCK');
      expect(validateRecommendation('Reject')).toBe('REJECT');
    });

    it('rejects invalid recommendations', () => {
      expect(() => validateRecommendation('accept')).toThrow(MacpSessionError);
      expect(() => validateRecommendation('deny')).toThrow(MacpSessionError);
    });
  });

  describe('validateConfidence', () => {
    it('accepts values in [0.0, 1.0]', () => {
      expect(() => validateConfidence(0)).not.toThrow();
      expect(() => validateConfidence(0.5)).not.toThrow();
      expect(() => validateConfidence(1.0)).not.toThrow();
    });

    it('rejects values outside range', () => {
      expect(() => validateConfidence(-0.1)).toThrow(MacpSessionError);
      expect(() => validateConfidence(1.1)).toThrow(MacpSessionError);
    });

    // Issue #108.2: `NaN < 0` and `NaN > 1.0` are both `false`, so a bare
    // range check silently accepted NaN — verified by execution on the
    // pre-fix code. This is the only behavior change; fails on old code.
    it('issue #108.2: rejects NaN — fails on old code', () => {
      expect(() => validateConfidence(NaN)).toThrow(MacpSessionError);
    });

    it('regression pin (already green pre-fix, not a repro): rejects +/-Infinity and accepts the exact boundaries', () => {
      expect(() => validateConfidence(Infinity)).toThrow(MacpSessionError);
      expect(() => validateConfidence(-Infinity)).toThrow(MacpSessionError);
      expect(() => validateConfidence(0)).not.toThrow();
      expect(() => validateConfidence(1)).not.toThrow();
    });
  });

  describe('validateSeverity', () => {
    it('accepts valid severities and normalizes to lowercase', () => {
      expect(validateSeverity('Critical')).toBe('critical');
      expect(validateSeverity('HIGH')).toBe('high');
      expect(validateSeverity('medium')).toBe('medium');
      expect(validateSeverity('Low')).toBe('low');
    });

    it('rejects invalid severities', () => {
      expect(() => validateSeverity('block')).toThrow(MacpSessionError);
      expect(() => validateSeverity('urgent')).toThrow(MacpSessionError);
    });
  });

  describe('validateParticipantCount', () => {
    it('accepts counts up to 1000', () => {
      expect(() => validateParticipantCount(1)).not.toThrow();
      expect(() => validateParticipantCount(1000)).not.toThrow();
    });

    it('rejects counts over 1000', () => {
      expect(() => validateParticipantCount(1001)).toThrow(MacpSessionError);
    });
  });

  describe('validateSignalType', () => {
    it('allows empty signalType when no data', () => {
      expect(() => validateSignalType('', undefined)).not.toThrow();
      expect(() => validateSignalType('', Buffer.alloc(0))).not.toThrow();
    });

    it('allows non-empty signalType with data', () => {
      expect(() => validateSignalType('heartbeat', Buffer.from('data'))).not.toThrow();
    });

    it('rejects empty signalType when data is present', () => {
      expect(() => validateSignalType('', Buffer.from('data'))).toThrow(MacpSessionError);
      expect(() => validateSignalType('  ', Buffer.from('data'))).toThrow(MacpSessionError);
    });
  });

  describe('validateTtlMs', () => {
    it('accepts valid TTL values', () => {
      expect(() => validateTtlMs(1)).not.toThrow();
      expect(() => validateTtlMs(60_000)).not.toThrow();
      expect(() => validateTtlMs(86_400_000)).not.toThrow();
    });

    it('rejects zero', () => {
      expect(() => validateTtlMs(0)).toThrow(MacpSessionError);
    });

    it('rejects negative values', () => {
      expect(() => validateTtlMs(-1)).toThrow(MacpSessionError);
    });

    it('rejects values exceeding 24 hours', () => {
      expect(() => validateTtlMs(86_400_001)).toThrow(MacpSessionError);
    });

    it('rejects non-finite values', () => {
      expect(() => validateTtlMs(Infinity)).toThrow(MacpSessionError);
      expect(() => validateTtlMs(NaN)).toThrow(MacpSessionError);
    });
  });

  describe('validateMaxSuspendMs', () => {
    it('accepts 0 (runtime default) and positive values', () => {
      expect(() => validateMaxSuspendMs(0)).not.toThrow();
      expect(() => validateMaxSuspendMs(60_000)).not.toThrow();
    });

    it('rejects negative values', () => {
      expect(() => validateMaxSuspendMs(-1)).toThrow(MacpSessionError);
    });

    it('rejects non-finite values', () => {
      expect(() => validateMaxSuspendMs(Infinity)).toThrow(MacpSessionError);
      expect(() => validateMaxSuspendMs(NaN)).toThrow(MacpSessionError);
    });
  });

  describe('validateParticipants', () => {
    it('accepts non-empty unique lists', () => {
      expect(() => validateParticipants(['agent://a'])).not.toThrow();
      expect(() => validateParticipants(['agent://a', 'agent://b'])).not.toThrow();
    });

    it('rejects empty list', () => {
      expect(() => validateParticipants([])).toThrow(MacpSessionError);
    });

    it('rejects duplicate participants', () => {
      expect(() => validateParticipants(['agent://a', 'agent://a'])).toThrow(MacpSessionError);
    });
  });

  describe('validateRequiredField', () => {
    it('accepts non-empty strings', () => {
      expect(() => validateRequiredField('field', 'value')).not.toThrow();
    });

    it('rejects empty strings', () => {
      expect(() => validateRequiredField('field', '')).toThrow(MacpSessionError);
    });

    it('rejects whitespace-only strings', () => {
      expect(() => validateRequiredField('field', '   ')).toThrow(MacpSessionError);
    });
  });

  describe('validateSessionStart', () => {
    const validInput = {
      intent: 'test intent',
      participants: ['agent://a', 'agent://b'],
      ttlMs: 60_000,
      modeVersion: '1.0.0',
      configurationVersion: 'config.default',
    };

    it('accepts valid input', () => {
      expect(() => validateSessionStart(validInput)).not.toThrow();
    });

    it('accepts an empty intent (issue #124 item 3 -- RFC-MACP-0001 §7.1: a runtime "MUST NOT reject a SessionStart solely because intent is empty")', () => {
      expect(() => validateSessionStart({ ...validInput, intent: '' })).not.toThrow();
    });

    it('accepts an omitted intent (issue #124 item 3 AC4 -- proto3 implicit presence makes omitted and "" wire-identical)', () => {
      const { intent: _intent, ...withoutIntent } = validInput;
      expect(() => validateSessionStart(withoutIntent as typeof validInput)).not.toThrow();
    });

    it('rejects empty participants', () => {
      expect(() => validateSessionStart({ ...validInput, participants: [] })).toThrow(MacpSessionError);
    });

    it('rejects invalid TTL', () => {
      expect(() => validateSessionStart({ ...validInput, ttlMs: 0 })).toThrow(MacpSessionError);
    });

    it('rejects empty modeVersion', () => {
      expect(() => validateSessionStart({ ...validInput, modeVersion: '' })).toThrow(MacpSessionError);
    });

    it('rejects empty configurationVersion', () => {
      expect(() => validateSessionStart({ ...validInput, configurationVersion: '' })).toThrow(MacpSessionError);
    });

    it('accepts a valid maxSuspendMs', () => {
      expect(() => validateSessionStart({ ...validInput, maxSuspendMs: 60_000 })).not.toThrow();
      expect(() => validateSessionStart({ ...validInput, maxSuspendMs: 0 })).not.toThrow();
    });

    it('rejects a negative maxSuspendMs', () => {
      expect(() => validateSessionStart({ ...validInput, maxSuspendMs: -1 })).toThrow(MacpSessionError);
    });
  });

  describe('validateCommitmentHash', () => {
    it('accepts sha256: followed by 64 lowercase hex chars', () => {
      expect(() => validateCommitmentHash('sha256:' + '0'.repeat(64))).not.toThrow();
      expect(() => validateCommitmentHash('sha256:' + 'ab12cd34'.repeat(8))).not.toThrow();
    });

    it('rejects a value missing the sha256: prefix', () => {
      expect(() => validateCommitmentHash('0'.repeat(64))).toThrow(MacpSessionError);
    });

    it('rejects uppercase hex (case-sensitive)', () => {
      expect(() => validateCommitmentHash('sha256:' + 'A'.repeat(64))).toThrow(MacpSessionError);
    });

    it('rejects a hash that is one character short', () => {
      expect(() => validateCommitmentHash('sha256:' + '0'.repeat(63))).toThrow(MacpSessionError);
    });

    it('rejects a hash that is one character too long', () => {
      expect(() => validateCommitmentHash('sha256:' + '0'.repeat(65))).toThrow(MacpSessionError);
    });

    it('rejects an empty string', () => {
      expect(() => validateCommitmentHash('')).toThrow(MacpSessionError);
    });

    it('rejects a whitespace-padded otherwise-valid hash', () => {
      expect(() => validateCommitmentHash(' sha256:' + '0'.repeat(64))).toThrow(MacpSessionError);
      expect(() => validateCommitmentHash('sha256:' + '0'.repeat(64) + ' ')).toThrow(MacpSessionError);
    });

    it('includes the field name and offending value in the error message', () => {
      expect(() => validateCommitmentHash('abc123', 'myField')).toThrow(/myField/);
      expect(() => validateCommitmentHash('abc123', 'myField')).toThrow(/abc123/);
    });

    it('defaults the field name to "commitmentHash" when omitted', () => {
      expect(() => validateCommitmentHash('abc123')).toThrow(/commitmentHash/);
    });
  });

  // RFC-MACP-0001 §6 tri-state rule for `Progress` (spec PR #91, issue #73).
  // Mirrors macp-runtime's `validate_envelope_shape` (PR #137).
  describe('validateProgressScope', () => {
    const SID = '550e8400-e29b-41d4-a716-446655440000';

    it('accepts the ambient form (both empty)', () => {
      expect(() => validateProgressScope('', '')).not.toThrow();
    });

    it('accepts the session-scoped form (both non-empty)', () => {
      expect(() => validateProgressScope(SID, 'macp.mode.task.v1')).not.toThrow();
    });

    it('rejects a populated sessionId with an empty mode', () => {
      expect(() => validateProgressScope(SID, '')).toThrow(MacpSessionError);
      expect(() => validateProgressScope(SID, '')).toThrow(/sessionId is .* but mode is empty/);
    });

    it('rejects a populated mode with an empty sessionId', () => {
      expect(() => validateProgressScope('', 'macp.mode.task.v1')).toThrow(MacpSessionError);
      expect(() => validateProgressScope('', 'macp.mode.task.v1')).toThrow(/mode is .* but sessionId is empty/);
    });

    it('names the offending field values in the error message', () => {
      expect(() => validateProgressScope(SID, '')).toThrow(new RegExp(SID));
      expect(() => validateProgressScope('', 'macp.mode.task.v1')).toThrow(/macp\.mode\.task\.v1/);
    });

    // The runtime compares `session_id.is_empty()` against
    // `mode.trim().is_empty()`. That asymmetry is mirrored, not normalised, so
    // the SDK's verdict matches the runtime's on every input.
    it('treats a whitespace-only mode as empty, like the runtime', () => {
      expect(() => validateProgressScope('', '   ')).not.toThrow();
      expect(() => validateProgressScope(SID, '   ')).toThrow(MacpSessionError);
    });

    it('does NOT trim sessionId, like the runtime', () => {
      // Whitespace-only sessionId is non-empty to the runtime, so pairing it
      // with a real mode passes the shape check (it fails later, on session
      // lookup — not our rule to enforce).
      expect(() => validateProgressScope('   ', 'macp.mode.task.v1')).not.toThrow();
      expect(() => validateProgressScope('   ', '')).toThrow(MacpSessionError);
    });
  });
});
