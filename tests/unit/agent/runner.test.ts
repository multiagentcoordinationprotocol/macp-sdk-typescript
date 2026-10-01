import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fromBootstrap, encodeExtensions, type BootstrapPayload } from '../../../src/agent/runner';
import { MODE_DECISION, MODE_TASK } from '../../../src/constants';
import { _resetLoggingForTests, configureLogging, type LogSink } from '../../../src/logging';

function validPayload(overrides?: Partial<BootstrapPayload>): BootstrapPayload {
  return {
    session_id: '550e8400-e29b-41d4-a716-446655440000',
    participant_id: 'agent-1',
    mode: MODE_DECISION,
    runtime_address: 'localhost:50051',
    ...overrides,
  };
}

function writeTempBootstrap(payload: BootstrapPayload): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macp-runner-test-'));
  const filePath = path.join(dir, 'bootstrap.json');
  fs.writeFileSync(filePath, JSON.stringify(payload));
  return filePath;
}

describe('fromBootstrap', () => {
  const originalEnv = process.env.MACP_BOOTSTRAP_FILE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MACP_BOOTSTRAP_FILE = originalEnv;
    } else {
      delete process.env.MACP_BOOTSTRAP_FILE;
    }
  });

  describe('valid bootstrap', () => {
    it('creates a Participant from a valid bootstrap file', () => {
      const filePath = writeTempBootstrap(validPayload());
      const participant = fromBootstrap(filePath);

      expect(participant.participantId).toBe('agent-1');
      expect(participant.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(participant.mode).toBe(MODE_DECISION);
    });

    it('supports all optional fields', () => {
      const filePath = writeTempBootstrap(
        validPayload({
          mode: MODE_TASK,
          mode_version: '2.0.0',
          configuration_version: 'config.v2',
          policy_version: 'policy.strict',
        }),
      );
      const participant = fromBootstrap(filePath);

      expect(participant.mode).toBe(MODE_TASK);
    });

    it('uses bearer auth when auth_token is provided and binds expectedSender to participant_id', () => {
      const filePath = writeTempBootstrap(
        validPayload({
          auth_token: 'secret-token',
        }),
      );
      const participant = fromBootstrap(filePath);

      expect(participant.auth).toBeDefined();
      expect(participant.auth!.bearerToken).toBe('secret-token');
      expect(participant.auth!.senderHint).toBe('agent-1');
      // Direct-agent-auth invariant: the runner must wire the authenticated
      // identity into Auth.bearer so the SDK enforces it before any Send.
      expect(participant.auth!.expectedSender).toBe('agent-1');
    });

    it('uses dev agent auth when no auth_token (bearer-backed, runtime 0.5.0)', () => {
      const filePath = writeTempBootstrap(validPayload());
      const participant = fromBootstrap(filePath);

      expect(participant.auth).toBeDefined();
      // devAgent is bearer-only now: the agent id becomes the bearer token.
      expect(participant.auth!.bearerToken).toBe('agent-1');
      expect(participant.auth!.senderHint).toBe('agent-1');
    });

    it('uses agent_id for dev auth when provided', () => {
      const filePath = writeTempBootstrap(
        validPayload({
          agent_id: 'custom-agent-id',
        }),
      );
      const participant = fromBootstrap(filePath);

      expect(participant.auth).toBeDefined();
      expect(participant.auth!.bearerToken).toBe('custom-agent-id');
      expect(participant.auth!.senderHint).toBe('custom-agent-id');
    });
  });

  describe('MACP_BOOTSTRAP_FILE env var', () => {
    it('reads from env var when no path argument', () => {
      const filePath = writeTempBootstrap(validPayload({ participant_id: 'env-agent' }));
      process.env.MACP_BOOTSTRAP_FILE = filePath;

      const participant = fromBootstrap();
      expect(participant.participantId).toBe('env-agent');
    });

    it('throws when no path and no env var', () => {
      delete process.env.MACP_BOOTSTRAP_FILE;

      expect(() => fromBootstrap()).toThrow('No bootstrap path provided');
    });
  });

  describe('missing required fields', () => {
    it('throws when session_id is missing', () => {
      const payload = validPayload();
      delete (payload as any).session_id;
      payload.session_id = '';
      const filePath = writeTempBootstrap(payload);

      expect(() => fromBootstrap(filePath)).toThrow('session_id');
    });

    it('throws when participant_id is missing', () => {
      const payload = validPayload();
      delete (payload as any).participant_id;
      payload.participant_id = '';
      const filePath = writeTempBootstrap(payload);

      expect(() => fromBootstrap(filePath)).toThrow('participant_id');
    });

    it('throws when mode is missing', () => {
      const payload = validPayload();
      delete (payload as any).mode;
      payload.mode = '';
      const filePath = writeTempBootstrap(payload);

      expect(() => fromBootstrap(filePath)).toThrow('mode');
    });

    it('throws when runtime_address is missing', () => {
      const payload = validPayload();
      delete (payload as any).runtime_address;
      payload.runtime_address = '';
      const filePath = writeTempBootstrap(payload);

      expect(() => fromBootstrap(filePath)).toThrow('runtime_address');
    });
  });

  describe('initiator config', () => {
    it('creates a Participant when initiator is present in bootstrap', () => {
      const filePath = writeTempBootstrap(
        validPayload({
          initiator: {
            session_start: {
              intent: 'decide deployment',
              participants: ['agent-1', 'agent-2'],
              ttl_ms: 30000,
              roots: [{ uri: 'file:///workspace' }],
            },
            kickoff: {
              message_type: 'Proposal',
              payload: { proposalId: 'p1', option: 'canary' },
            },
          },
        }),
      );
      const participant = fromBootstrap(filePath);
      expect(participant.participantId).toBe('agent-1');
      expect(participant.mode).toBe(MODE_DECISION);
    });

    it('creates a Participant when initiator has no kickoff', () => {
      const filePath = writeTempBootstrap(
        validPayload({
          initiator: {
            session_start: {
              intent: 'decide',
              participants: ['agent-1'],
              ttl_ms: 10000,
            },
          },
        }),
      );
      const participant = fromBootstrap(filePath);
      expect(participant.participantId).toBe('agent-1');
    });

    it('creates a Participant without initiator (default)', () => {
      const filePath = writeTempBootstrap(validPayload());
      const participant = fromBootstrap(filePath);
      expect(participant.participantId).toBe('agent-1');
    });

    // SDK-TS-1: bootstrap payloads from examples-service carry `context_id`
    // and `extensions` alongside `session_start`. The runner used to drop
    // both; these tests pin that they now flow through into the initiator
    // config so `emitInitiatorEnvelopes` can forward them.
    it('decodes context_id and extensions from the bootstrap payload', async () => {
      // Round-trip: construct the Participant via fromBootstrap, then spy on
      // DecisionSession.prototype.start and drive a run() to confirm both
      // fields land on the SessionStart call with the correct shape.
      const { DecisionSession } = await import('../../../src/decision');
      const startSpy = vi
        .spyOn(DecisionSession.prototype, 'start')
        .mockResolvedValue({ ok: true, envelopeId: 'env-1' } as any);

      const filePath = writeTempBootstrap(
        validPayload({
          initiator: {
            session_start: {
              intent: 'decide with context',
              participants: ['agent-1', 'agent-2'],
              ttl_ms: 15_000,
              context_id: 'ctx-upstream-99',
              extensions: {
                // base64 of '{"token":"t-abc","issuer":"iss-1"}' (RFC-MACP-0001 §10.3:
                // a protobuf `bytes` field serializes as base64 in JSON).
                'aitp.tct': 'eyJ0b2tlbiI6InQtYWJjIiwiaXNzdWVyIjoiaXNzLTEifQ==',
                // Not valid base64 (contains ':' and '-') — falls back to raw UTF-8.
                'ctxm.ref': 'pack:example-001',
              },
            },
          },
        }),
      );

      const participant = fromBootstrap(filePath);

      // Prevent the fake transport from yielding anything; we only care
      // about the initiator-side start() call.
      (participant as any).transport = {
        async *start(): AsyncIterable<never> {
          /* empty */
        },
        async stop(): Promise<void> {
          /* noop */
        },
      };

      await participant.run();

      expect(startSpy).toHaveBeenCalledTimes(1);
      const arg = startSpy.mock.calls[0]![0];
      expect(arg.contextId).toBe('ctx-upstream-99');
      expect(arg.extensions).toBeDefined();
      // A base64-string bootstrap value is base64-decoded into raw bytes
      // (issue #139 — RFC-MACP-0001 §10.3's canonical `bytes` JSON shape).
      expect(arg.extensions!['aitp.tct']).toBeInstanceOf(Buffer);
      expect(JSON.parse(arg.extensions!['aitp.tct']!.toString('utf8'))).toEqual({
        token: 't-abc',
        issuer: 'iss-1',
      });
      // A non-base64 string falls back to raw UTF-8 bytes, unquoted.
      expect(arg.extensions!['ctxm.ref']!.toString('utf8')).toBe('pack:example-001');

      startSpy.mockRestore();
    });

    it('omits context_id / extensions when absent from bootstrap (backwards-compatible)', async () => {
      const { DecisionSession } = await import('../../../src/decision');
      const startSpy = vi
        .spyOn(DecisionSession.prototype, 'start')
        .mockResolvedValue({ ok: true, envelopeId: 'env-1' } as any);

      const filePath = writeTempBootstrap(
        validPayload({
          initiator: {
            session_start: {
              intent: 'no upstream context',
              participants: ['agent-1'],
              ttl_ms: 10_000,
            },
          },
        }),
      );

      const participant = fromBootstrap(filePath);
      (participant as any).transport = {
        async *start(): AsyncIterable<never> {
          /* empty */
        },
        async stop(): Promise<void> {
          /* noop */
        },
      };

      await participant.run();

      expect(startSpy).toHaveBeenCalledTimes(1);
      const arg = startSpy.mock.calls[0]![0];
      expect(arg.contextId).toBeUndefined();
      expect(arg.extensions).toBeUndefined();

      startSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('throws when bootstrap file does not exist', () => {
      expect(() => fromBootstrap('/nonexistent/path/bootstrap.json')).toThrow('not found');
    });

    it('throws when bootstrap file contains invalid JSON', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macp-runner-test-'));
      const filePath = path.join(dir, 'bad.json');
      fs.writeFileSync(filePath, 'not json');

      expect(() => fromBootstrap(filePath)).toThrow();
    });

    it('throws when secure: false is set without allow_insecure: true', () => {
      const filePath = writeTempBootstrap(validPayload({ secure: false }));
      expect(() => fromBootstrap(filePath)).toThrow(/allowInsecure/);
    });

    it('accepts secure: false when allow_insecure: true is also set', () => {
      const filePath = writeTempBootstrap(validPayload({ secure: false, allow_insecure: true }));
      expect(() => fromBootstrap(filePath)).not.toThrow();
    });
  });

  describe('cancel_callback (RFC-0001 §7.2 Option A)', () => {
    it('forwards cancel_callback fields into the Participant config', async () => {
      const filePath = writeTempBootstrap(
        validPayload({
          cancel_callback: { host: '127.0.0.1', port: 0, path: '/cancel' },
        }),
      );
      const participant = fromBootstrap(filePath);
      // Private field access via cast — verify the runner passed it through.
      const cfg = (participant as unknown as { cancelCallbackConfig?: { host: string; port: number; path: string } })
        .cancelCallbackConfig;
      expect(cfg).toEqual({ host: '127.0.0.1', port: 0, path: '/cancel' });
    });

    it('omits cancelCallback when bootstrap has no cancel_callback field', () => {
      const filePath = writeTempBootstrap(validPayload());
      const participant = fromBootstrap(filePath);
      const cfg = (participant as unknown as { cancelCallbackConfig?: unknown }).cancelCallbackConfig;
      expect(cfg).toBeUndefined();
    });
  });
});

// issue #139: encodeExtensions() is exported specifically so these cases —
// especially Buffer/Uint8Array passthrough (AC3) — are reachable at all.
// `fromBootstrap`'s only route in is a JSON bootstrap *file*, and a
// Buffer/Uint8Array value cannot survive a JSON.stringify/JSON.parse round
// trip, so that branch has no other test surface.
describe('encodeExtensions', () => {
  beforeEach(() => {
    _resetLoggingForTests();
  });

  afterEach(() => {
    _resetLoggingForTests();
  });

  it("base64-decodes the spec repo's own canonical example value (AC1)", () => {
    // multiagentcoordinationprotocol/examples/discovery/agent_bootstrap.json's
    // "x-tracing" field — hardcoded expected value, not re-derived here.
    const result = encodeExtensions({
      'x-tracing':
        'eyJ0cmFjZXBhcmVudCI6IjAwLTRiZjkyZjM1NzdiMzRkYTZhM2NlOTI5ZDBlMGU0NzM2LTAwZjA2N2FhMGJhOTAyYjctMDEifQ==',
    });
    expect(result!['x-tracing']!.toString('utf8')).toBe(
      '{"traceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}',
    );
  });

  it('falls back to raw UTF-8 for a non-base64 string, not JSON-stringified, not thrown (AC2)', () => {
    const result = encodeExtensions({ 'ctxm.ref': 'pack:example-001' });
    expect(result!['ctxm.ref']).toEqual(Buffer.from('pack:example-001', 'utf8'));
  });

  it('passes a Buffer value through unchanged (AC3)', () => {
    const raw = Buffer.from([1, 2, 3, 4]);
    const result = encodeExtensions({ key: raw });
    expect(result!.key).toBe(raw);
  });

  it('passes a Uint8Array value through unchanged, as an equal Buffer (AC3)', () => {
    const raw = new Uint8Array([5, 6, 7]);
    const result = encodeExtensions({ key: raw });
    expect(result!.key).toEqual(Buffer.from(raw));
  });

  it('returns undefined for an absent extensions map', () => {
    expect(encodeExtensions(undefined)).toBeUndefined();
  });

  describe('throws for a per-value type that is neither a base64 string, a Buffer, nor a Uint8Array (AC4)', () => {
    it.each([
      ['number', 42],
      ['boolean', true],
      ['object', { nested: true }],
      ['array', [1, 2, 3]],
      ['null', null],
    ])('%s', (_label, value) => {
      expect(() => encodeExtensions({ bad: value } as never)).toThrow(/extensions\["bad"\]/);
    });
  });

  describe('throws when the extensions container itself is not a plain object (AC4a)', () => {
    it.each([
      ['string', 'not-an-object'],
      ['number', 42],
      ['boolean', true],
      ['array', [1, 2, 3]],
    ])('%s', (_label, value) => {
      expect(() => encodeExtensions(value as never)).toThrow(/extensions.*must be an object/);
    });
  });

  it('logs at debug level when a value decodes as base64 (AC8)', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ level: 'debug', sink });

    encodeExtensions({ 'x-tracing': 'eyJhIjoxfQ==' });

    expect(sink).toHaveBeenCalledWith('debug', expect.arrayContaining([expect.stringMatching(/decoded as base64/)]));
  });

  it('logs at debug level when a value falls back to raw UTF-8 (AC8)', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ level: 'debug', sink });

    encodeExtensions({ 'ctxm.ref': 'pack:example-001' });

    expect(sink).toHaveBeenCalledWith(
      'debug',
      expect.arrayContaining([expect.stringMatching(/falling back to raw UTF-8/)]),
    );
  });
});
