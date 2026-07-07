import { describe, it, expect } from 'vitest';
import { Auth, assertSenderMatchesIdentity, authSender, metadataFromAuth, validateAuth } from '../../src/auth';
import { MacpIdentityMismatchError } from '../../src/errors';

describe('Auth', () => {
  describe('Auth.devAgent', () => {
    it('creates a bearer-only config using the agent id as the token (runtime 0.5.0)', () => {
      const config = Auth.devAgent('alice');
      expect(config.bearerToken).toBe('alice');
      expect(config.senderHint).toBe('alice');
      expect(config.expectedSender).toBeUndefined();
    });

    it('emits an Authorization: Bearer <agentId> frame, not x-macp-agent-id', () => {
      const metadata = metadataFromAuth(Auth.devAgent('alice'));
      expect(metadata.get('authorization')).toEqual(['Bearer alice']);
      expect(metadata.get('x-macp-agent-id')).toEqual([]);
    });
  });

  describe('Auth.bearer', () => {
    it('returns a plain bearer config when no options given', () => {
      const config = Auth.bearer('tok123');
      expect(config.bearerToken).toBe('tok123');
      expect(config.senderHint).toBeUndefined();
      expect(config.expectedSender).toBeUndefined();
    });

    it('accepts a legacy senderHint string', () => {
      const config = Auth.bearer('tok123', 'alice');
      expect(config.senderHint).toBe('alice');
      expect(config.expectedSender).toBeUndefined();
    });

    it('accepts a structured options object with expectedSender', () => {
      const config = Auth.bearer('tok123', { expectedSender: 'alice' });
      expect(config.expectedSender).toBe('alice');
      // expectedSender doubles as a default senderHint so envelopes auto-fill
      expect(config.senderHint).toBe('alice');
    });

    it('honours an explicit senderHint override when set alongside expectedSender', () => {
      const config = Auth.bearer('tok123', { expectedSender: 'alice', senderHint: 'alias' });
      expect(config.expectedSender).toBe('alice');
      expect(config.senderHint).toBe('alias');
    });
  });

  describe('validateAuth', () => {
    it('throws when no bearer token is present', () => {
      expect(() => validateAuth({})).toThrow('bearerToken is required');
    });

    it('passes for valid bearer', () => {
      expect(() => validateAuth({ bearerToken: 'tok' })).not.toThrow();
    });

    it('passes for a dev-agent credential (bearer-backed)', () => {
      expect(() => validateAuth(Auth.devAgent('alice'))).not.toThrow();
    });
  });

  describe('authSender', () => {
    it('prefers expectedSender when set', () => {
      expect(authSender({ bearerToken: 'tok', expectedSender: 'alice', senderHint: 'alias' })).toBe('alice');
    });

    it('falls back to senderHint', () => {
      expect(authSender({ senderHint: 'alice', bearerToken: 'tok' })).toBe('alice');
    });

    it('resolves a dev-agent credential to its agent id', () => {
      expect(authSender(Auth.devAgent('bob'))).toBe('bob');
    });

    it('returns undefined when no auth', () => {
      expect(authSender(undefined)).toBeUndefined();
    });
  });

  describe('metadataFromAuth', () => {
    it('sets authorization header for bearer', () => {
      const metadata = metadataFromAuth({ bearerToken: 'tok123' });
      expect(metadata.get('authorization')).toEqual(['Bearer tok123']);
    });

    it('does not include expectedSender in the metadata frame', () => {
      const metadata = metadataFromAuth(Auth.bearer('tok', { expectedSender: 'alice' }));
      expect(metadata.get('authorization')).toEqual(['Bearer tok']);
      // expectedSender is an SDK-level guard, not a wire field
      expect(metadata.get('x-macp-expected-sender')).toEqual([]);
    });
  });

  describe('assertSenderMatchesIdentity', () => {
    it('is a no-op when auth is undefined', () => {
      expect(() => assertSenderMatchesIdentity(undefined, 'alice')).not.toThrow();
    });

    it('is a no-op when expectedSender is undefined (legacy bearer)', () => {
      const auth = Auth.bearer('tok', 'alice');
      expect(() => assertSenderMatchesIdentity(auth, 'mallory')).not.toThrow();
    });

    it('is a no-op when caller did not pass a sender', () => {
      const auth = Auth.bearer('tok', { expectedSender: 'alice' });
      expect(() => assertSenderMatchesIdentity(auth, undefined)).not.toThrow();
    });

    it('passes when sender matches expectedSender', () => {
      const auth = Auth.bearer('tok', { expectedSender: 'alice' });
      expect(() => assertSenderMatchesIdentity(auth, 'alice')).not.toThrow();
    });

    it('throws MacpIdentityMismatchError when sender differs', () => {
      const auth = Auth.bearer('tok', { expectedSender: 'alice' });
      try {
        assertSenderMatchesIdentity(auth, 'mallory');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(MacpIdentityMismatchError);
        const mismatch = err as MacpIdentityMismatchError;
        expect(mismatch.expectedSender).toBe('alice');
        expect(mismatch.actualSender).toBe('mallory');
      }
    });
  });
});
