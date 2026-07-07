import { describe, it, expect } from 'vitest';
import {
  validateSessionId,
  validateVote,
  validateRecommendation,
  validateConfidence,
  validateSeverity,
  validateParticipantCount,
  validateSignalType,
  validateTtlMs,
  validateMaxSuspendMs,
  validateParticipants,
  validateRequiredField,
  validateSessionStart,
} from '../../src/validation';
import { MacpSessionError } from '../../src/errors';

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

    it('rejects empty intent', () => {
      expect(() => validateSessionStart({ ...validInput, intent: '' })).toThrow(MacpSessionError);
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
});
