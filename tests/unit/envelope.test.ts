import { describe, it, expect } from 'vitest';
import {
  buildEnvelope,
  buildSessionStartPayload,
  buildCommitmentPayload,
  buildCommitmentRef,
  buildSignalPayload,
  buildProgressPayload,
  newSessionId,
  newMessageId,
  newCommitmentId,
  inferOutcomePositive,
  serializeMessage,
} from '../../src/envelope';
import { MACP_VERSION } from '../../src/constants';

describe('envelope builders', () => {
  describe('buildEnvelope', () => {
    it('sets default macpVersion, messageId, and timestamp', () => {
      const envelope = buildEnvelope({
        mode: 'macp.mode.decision.v1',
        messageType: 'Proposal',
        sessionId: 'sid',
        payload: Buffer.from('test'),
      });
      expect(envelope.macpVersion).toBe(MACP_VERSION);
      expect(envelope.messageId).toBeTruthy();
      expect(envelope.timestampUnixMs).toBeTruthy();
      expect(Number(envelope.timestampUnixMs)).toBeGreaterThan(0);
      expect(envelope.sender).toBe('');
    });

    it('preserves explicit values', () => {
      const envelope = buildEnvelope({
        mode: 'test',
        messageType: 'Msg',
        sessionId: 'sid',
        payload: Buffer.alloc(0),
        sender: 'me',
        messageId: 'custom-id',
        macpVersion: '2.0',
        timestampUnixMs: '12345',
      });
      expect(envelope.macpVersion).toBe('2.0');
      expect(envelope.messageId).toBe('custom-id');
      expect(envelope.sender).toBe('me');
      expect(envelope.timestampUnixMs).toBe('12345');
    });
  });

  describe('buildSessionStartPayload', () => {
    it('builds with required fields and defaults', () => {
      const payload = buildSessionStartPayload({
        intent: 'decide',
        participants: ['a', 'b'],
        ttlMs: 60000,
      });
      expect(payload.intent).toBe('decide');
      expect(payload.participants).toEqual(['a', 'b']);
      expect(payload.ttlMs).toBe(60000);
      expect(payload.modeVersion).toBe('1.0.0');
      expect(payload.configurationVersion).toBe('config.default');
      expect(payload.roots).toEqual([]);
    });

    it('accepts custom versions', () => {
      const payload = buildSessionStartPayload({
        intent: 'x',
        participants: ['a'],
        ttlMs: 1000,
        modeVersion: '2.0.0',
        configurationVersion: 'custom',
        policyVersion: 'policy.v2',
      });
      expect(payload.modeVersion).toBe('2.0.0');
      expect(payload.configurationVersion).toBe('custom');
      expect(payload.policyVersion).toBe('policy.v2');
    });

    it('defaults maxSuspendMs to 0 (runtime default) when omitted', () => {
      const payload = buildSessionStartPayload({ intent: 'x', participants: ['a'], ttlMs: 1000 });
      expect(payload.maxSuspendMs).toBe(0);
    });

    it('passes an explicit maxSuspendMs through', () => {
      const payload = buildSessionStartPayload({ intent: 'x', participants: ['a'], ttlMs: 1000, maxSuspendMs: 5000 });
      expect(payload.maxSuspendMs).toBe(5000);
    });
  });

  describe('buildCommitmentPayload', () => {
    it('builds with auto-generated commitmentId', () => {
      const payload = buildCommitmentPayload({
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'approved',
      });
      expect(payload.commitmentId).toBeTruthy();
      expect(payload.action).toBe('deploy');
      expect(payload.authorityScope).toBe('ops');
      expect(payload.reason).toBe('approved');
    });

    it('preserves explicit commitmentId', () => {
      const payload = buildCommitmentPayload({
        action: 'x',
        authorityScope: 'y',
        reason: 'z',
        commitmentId: 'my-id',
      });
      expect(payload.commitmentId).toBe('my-id');
    });

    it('infers outcomePositive true for positive actions', () => {
      const payload = buildCommitmentPayload({
        action: 'proposal_accepted',
        authorityScope: 'session',
        reason: 'done',
      });
      expect(payload.outcomePositive).toBe(true);
    });

    it('infers outcomePositive false for negative actions', () => {
      for (const action of ['proposal_rejected', 'task_failed', 'handoff_declined']) {
        const payload = buildCommitmentPayload({
          action,
          authorityScope: 'session',
          reason: 'done',
        });
        expect(payload.outcomePositive).toBe(false);
      }
    });

    it('allows explicit outcomePositive override', () => {
      const payload = buildCommitmentPayload({
        action: 'proposal_rejected',
        authorityScope: 'session',
        reason: 'done',
        outcomePositive: true,
      });
      expect(payload.outcomePositive).toBe(true);
    });

    it('omits supersedes by default', () => {
      const payload = buildCommitmentPayload({
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'approved',
      });
      expect(payload.supersedes).toBeUndefined();
    });

    it('attaches a CommitmentRef when supersedes is provided', () => {
      const payload = buildCommitmentPayload({
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'revised',
        supersedes: { sessionId: 'prior-session', commitmentHash: 'abc123' },
      });
      expect(payload.supersedes).toEqual({ sessionId: 'prior-session', commitmentHash: 'abc123' });
    });

    it('accepts a CommitmentRef built by buildCommitmentRef', () => {
      const ref = buildCommitmentRef({ sessionId: 'prior-session', commitmentHash: 'abc123' });
      const payload = buildCommitmentPayload({
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'revised',
        supersedes: ref,
      });
      expect(payload.supersedes).toEqual(ref);
    });
  });

  describe('buildCommitmentRef', () => {
    it('builds a CommitmentRef from sessionId + commitmentHash', () => {
      const ref = buildCommitmentRef({ sessionId: 's1', commitmentHash: 'hash-1' });
      expect(ref).toEqual({ sessionId: 's1', commitmentHash: 'hash-1' });
    });
  });

  describe('inferOutcomePositive', () => {
    it('returns false for negative suffixes', () => {
      expect(inferOutcomePositive('proposal_rejected')).toBe(false);
      expect(inferOutcomePositive('task_failed')).toBe(false);
      expect(inferOutcomePositive('handoff_declined')).toBe(false);
    });

    it('returns true for positive suffixes', () => {
      expect(inferOutcomePositive('proposal_selected')).toBe(true);
      expect(inferOutcomePositive('proposal_accepted')).toBe(true);
      expect(inferOutcomePositive('task_completed')).toBe(true);
      expect(inferOutcomePositive('request_approved')).toBe(true);
    });

    it('returns true for unknown action suffixes', () => {
      expect(inferOutcomePositive('custom_action')).toBe(true);
      expect(inferOutcomePositive('commit')).toBe(true);
    });
  });

  describe('buildSessionStartPayload contextId and extensions', () => {
    it('defaults contextId to empty string and extensions to empty object', () => {
      const payload = buildSessionStartPayload({
        intent: 'test',
        participants: ['a'],
        ttlMs: 5000,
      });
      expect(payload.contextId).toBe('');
      expect(payload.extensions).toEqual({});
    });

    it('passes through explicit contextId and extensions', () => {
      const ext = { 'x-trace': Buffer.from('abc') };
      const payload = buildSessionStartPayload({
        intent: 'test',
        participants: ['a'],
        ttlMs: 5000,
        contextId: 'ctx-123',
        extensions: ext,
      });
      expect(payload.contextId).toBe('ctx-123');
      expect(payload.extensions).toBe(ext);
    });
  });

  describe('buildSignalPayload', () => {
    it('builds with required signalType and fills defaults', () => {
      const p = buildSignalPayload({ signalType: 'agent.status' });
      expect(p.signalType).toBe('agent.status');
      expect(p.data).toEqual(Buffer.alloc(0));
      expect(p.confidence).toBe(0);
      expect(p.correlationSessionId).toBe('');
    });

    it('preserves explicit data/confidence/correlation', () => {
      const p = buildSignalPayload({
        signalType: 'agent.status',
        data: Buffer.from('payload'),
        confidence: 0.9,
        correlationSessionId: 'sid-1',
      });
      expect(p.data?.toString()).toBe('payload');
      expect(p.confidence).toBe(0.9);
      expect(p.correlationSessionId).toBe('sid-1');
    });

    it('accepts Uint8Array data and normalises to Buffer', () => {
      const data = new Uint8Array([0x01, 0x02, 0x03]);
      const p = buildSignalPayload({ signalType: 'x', data });
      expect(Buffer.isBuffer(p.data)).toBe(true);
      expect(p.data).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    });
  });

  describe('buildProgressPayload', () => {
    it('builds with required fields and defaults', () => {
      const p = buildProgressPayload({
        progressToken: 't1',
        progress: 5,
        total: 10,
      });
      expect(p.progressToken).toBe('t1');
      expect(p.progress).toBe(5);
      expect(p.total).toBe(10);
      expect(p.message).toBe('');
      expect(p.targetMessageId).toBe('');
    });

    it('preserves optional message and targetMessageId', () => {
      const p = buildProgressPayload({
        progressToken: 't1',
        progress: 1,
        total: 3,
        message: 'halfway',
        targetMessageId: 'm-42',
      });
      expect(p.message).toBe('halfway');
      expect(p.targetMessageId).toBe('m-42');
    });
  });

  describe('serializeMessage', () => {
    it('calls serializeBinary() when present (protoc-gen-js style)', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const msg = { serializeBinary: () => bytes };
      expect(serializeMessage(msg)).toBe(bytes);
    });

    it('calls toBinary() when present (protobuf-es / ts-proto style)', () => {
      const bytes = new Uint8Array([4, 5]);
      const msg = { toBinary: () => bytes };
      expect(serializeMessage(msg)).toBe(bytes);
    });

    it('calls finish() when present (protobufjs Writer style)', () => {
      const bytes = new Uint8Array([7, 7, 7]);
      const msg = { finish: () => bytes };
      expect(serializeMessage(msg)).toBe(bytes);
    });

    it('throws TypeError for plain objects without a serializer method', () => {
      expect(() => serializeMessage({ hello: 'world' } as unknown)).toThrow(TypeError);
    });
  });

  describe('ID generators', () => {
    it('newSessionId produces UUID format', () => {
      const id = newSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('newMessageId produces UUID format', () => {
      expect(newMessageId()).toMatch(/^[0-9a-f]{8}-/);
    });

    it('newCommitmentId produces UUID format', () => {
      expect(newCommitmentId()).toMatch(/^[0-9a-f]{8}-/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
      expect(ids.size).toBe(100);
    });
  });
});
