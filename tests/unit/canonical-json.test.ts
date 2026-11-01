/**
 * RFC-MACP-0001 §10 canonical JSON codec (src/canonical-json.ts): every
 * conformance fixture message round-trips, the spec's A2A binding example
 * parses and re-emits, and malformed input is refused with INVALID_ENVELOPE.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  ackFromCanonicalJson,
  ackToCanonicalJson,
  envelopeFromCanonicalJson,
  envelopeToCanonicalJson,
  type CanonicalEnvelope,
} from '../../src/canonical-json';
import { MacpSdkError } from '../../src/errors';
import { ProtoRegistry } from '../../src/proto-registry';

const registry = new ProtoRegistry();
const CONFORMANCE_DIR = path.join(__dirname, '..', 'conformance');
const SESSION_ID = '6f1c2a9e-4b7d-4c1e-9a53-2d8f0b7e5a10';
const BASE_MS = 1761382800000;

const BYTES_FIELDS = new Set(['context', 'supportingData', 'details', 'input', 'output', 'partialOutput', 'data']);
const snakeToCamel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Fixture payload → ProtoRegistry input (same normalization as conformance.test.ts). */
function normalize(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const camel = snakeToCamel(key);
    if (BYTES_FIELDS.has(camel) && typeof value === 'string') out[camel] = Buffer.from(value, 'utf8');
    else if (BYTES_FIELDS.has(camel) && Array.isArray(value)) out[camel] = Buffer.from(value as number[]);
    else if (Array.isArray(value))
      out[camel] = value.map((item) =>
        typeof item === 'object' && item !== null ? normalize(item as Record<string, unknown>) : item,
      );
    else if (typeof value === 'object' && value !== null) out[camel] = normalize(value as Record<string, unknown>);
    else out[camel] = value;
  }
  return out;
}

interface FixtureMessage {
  sender: string;
  message_type: string;
  payload_type?: string;
  payload: Record<string, unknown>;
  envelope?: { mode?: string };
}

/** Every message of every conformance fixture as an Envelope with real Protobuf payload bytes. */
function fixtureEnvelopes(): Array<{ name: string; envelope: CanonicalEnvelope; typeName: string }> {
  const out: Array<{ name: string; envelope: CanonicalEnvelope; typeName: string }> = [];
  for (const file of fs
    .readdirSync(CONFORMANCE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .sort()) {
    const fixture = JSON.parse(fs.readFileSync(path.join(CONFORMANCE_DIR, file), 'utf8')) as {
      mode: string;
      messages: FixtureMessage[];
    };
    const stem = file.replace(/\.json$/, '');
    fixture.messages.forEach((message, index) => {
      const mode = message.envelope?.mode ?? fixture.mode;
      const typeName =
        message.payload_type ?? registry.getKnownTypeName(fixture.mode, message.message_type) ?? 'unknown';
      out.push({
        name: `${stem}#${index} ${message.message_type}`,
        typeName,
        envelope: {
          macpVersion: '1.0',
          mode,
          messageType: message.message_type,
          messageId: `${stem}-${index}`,
          sessionId: SESSION_ID,
          sender: message.sender,
          timestampUnixMs: String(BASE_MS + index * 1001),
          payload: new Uint8Array(registry.encodeMessage(typeName, normalize(message.payload))),
        },
      });
    });
  }
  return out;
}

const decoded = (typeName: string, bytes: Uint8Array) => registry.decodeMessage(typeName, Buffer.from(bytes));

function expectInvalid(fn: () => unknown, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CanonicalJsonError);
  expect((caught as CanonicalJsonError).code).toBe('INVALID_ENVELOPE');
  if (message) expect((caught as Error).message).toMatch(message);
}

function envelope(overrides: Partial<CanonicalEnvelope> = {}): CanonicalEnvelope {
  return {
    macpVersion: '1.0',
    mode: 'macp.mode.decision.v1',
    messageType: 'Vote',
    messageId: 'm-1',
    sessionId: SESSION_ID,
    sender: 'agent://fraud',
    timestampUnixMs: '1792918802000',
    payload: new Uint8Array(
      registry.encodeMessage('macp.modes.decision.v1.VotePayload', { proposalId: 'p-1', vote: 'APPROVE' }),
    ),
    ...overrides,
  };
}

function json(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...envelopeToCanonicalJson(envelope()), ...overrides };
}

describe('conformance fixtures round-trip through canonical JSON', () => {
  const cases = fixtureEnvelopes();

  it('covers every fixture message', () => {
    expect(cases.length).toBeGreaterThan(100);
  });

  it.each(cases)('$name', ({ envelope: env, typeName }) => {
    const first = envelopeToCanonicalJson(env);
    const parsed = envelopeFromCanonicalJson(JSON.parse(JSON.stringify(first)));
    expect({ ...parsed, payload: undefined }).toEqual({ ...env, payload: undefined });
    if ('payload_b64' in first) {
      // ext.* payloads carry the exact bytes
      expect(Buffer.from(parsed.payload).equals(Buffer.from(env.payload))).toBe(true);
    } else {
      expect(decoded(typeName, parsed.payload)).toEqual(decoded(typeName, env.payload));
    }
    // fixed point: the canonical bytes re-emit the same JSON and re-encode to themselves
    const second = envelopeToCanonicalJson(parsed);
    expect(second).toEqual(first);
    expect(Buffer.from(envelopeFromCanonicalJson(second).payload).equals(Buffer.from(parsed.payload))).toBe(true);
  });

  it('carries ext.multi_round.v1 Contribute as payload_b64 and Commitment as payload', () => {
    const multi = cases.filter((c) => c.envelope.mode === 'ext.multi_round.v1');
    const contribute = multi.find((c) => c.envelope.messageType === 'Contribute')!;
    const commitment = multi.find((c) => c.envelope.messageType === 'Commitment')!;
    expect(envelopeToCanonicalJson(contribute.envelope)).toHaveProperty('payload_b64');
    expect(envelopeToCanonicalJson(contribute.envelope)).not.toHaveProperty('payload');
    expect(envelopeToCanonicalJson(commitment.envelope)).toHaveProperty('payload');
  });
});

describe('A2A binding example (RFC-MACP-0014)', () => {
  const example = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'a2a_binding_session.json'), 'utf8'),
  ) as unknown;
  const envelopes: Record<string, unknown>[] = [];
  const acks: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (typeof node === 'object' && node !== null) {
      const obj = node as Record<string, unknown>;
      if (obj.mediaType === 'application/macp-envelope+json') envelopes.push(obj.data as Record<string, unknown>);
      if ('accepted_at_unix_ms' in obj) acks.push(obj);
      Object.values(obj).forEach(walk);
    }
  };
  walk(example);

  /** The example omits defaults; everything we add must be a default. */
  function expectSubsetPlusDefaults(emitted: unknown, original: unknown, at = '$'): void {
    if (typeof original === 'object' && original !== null && !Array.isArray(original)) {
      const e = emitted as Record<string, unknown>;
      const o = original as Record<string, unknown>;
      for (const key of Object.keys(e)) {
        if (key in o) expectSubsetPlusDefaults(e[key], o[key], `${at}.${key}`);
        else
          expect([0, '', false, 'VOTE_UNSPECIFIED'], `${at}.${key} is not a default`).toContainEqual(
            Array.isArray(e[key]) && (e[key] as unknown[]).length === 0
              ? 0
              : e[key] instanceof Object && Object.keys(e[key] as object).length === 0
                ? 0
                : e[key],
          );
      }
      for (const key of Object.keys(o)) expect(e, `${at}.${key} dropped`).toHaveProperty([key]);
    } else {
      expect(emitted, at).toEqual(original);
    }
  }

  it('finds the embedded envelopes and acks', () => {
    expect(envelopes.length).toBeGreaterThanOrEqual(10);
    expect(acks.length).toBe(5);
    expect(new Set(envelopes.map((e) => e.message_type))).toEqual(
      new Set(['SessionStart', 'Proposal', 'Vote', 'Commitment', 'Signal']),
    );
  });

  it('parses every envelope and re-emits it with only defaults added', () => {
    for (const original of envelopes) {
      const parsed = envelopeFromCanonicalJson(original);
      const emitted = envelopeToCanonicalJson(parsed);
      expectSubsetPlusDefaults(emitted, original);
      expect(envelopeToCanonicalJson(envelopeFromCanonicalJson(emitted))).toEqual(emitted);
    }
  });

  it('decodes the empty-mode Signal with its bytes and double', () => {
    const signal = envelopeFromCanonicalJson(envelopes.find((e) => e.message_type === 'Signal'));
    expect(signal.mode).toBe('');
    const payload = decoded('macp.v1.SignalPayload', signal.payload);
    expect(Buffer.from(payload.data as Buffer).toString('utf8')).toBe('{"score":0.12}');
    expect(payload.confidence).toBeCloseTo(0.8);
    expect(signal.timestampUnixMs).toBe(String(Date.parse('2026-10-25T09:00:05Z')));
  });

  it('round-trips every ack exactly', () => {
    for (const original of acks) {
      const ack = ackFromCanonicalJson(original);
      expect(ack.acceptedAtUnixMs).toBe(String(original.accepted_at_unix_ms));
      expect(ackToCanonicalJson(ack)).toEqual(original);
    }
  });
});

describe('payload form selection (§10.12)', () => {
  const coreBytes = new Uint8Array(registry.encodeMessage('macp.v1.SignalPayload', { signalType: 's' }));

  it.each([
    ['Signal in an empty mode', '', 'Signal'],
    ['Signal in an ext mode', 'ext.multi_round.v1', 'Signal'],
    ['Commitment in a reverse-domain mode', 'com.example.custom.v1', 'Commitment'],
  ])('%s is payload', (_label, mode, messageType) => {
    const bytes =
      messageType === 'Signal'
        ? coreBytes
        : new Uint8Array(registry.encodeMessage('macp.v1.CommitmentPayload', { commitmentId: 'c' }));
    expect(envelopeToCanonicalJson(envelope({ mode, messageType, payload: bytes }))).toHaveProperty('payload');
  });

  it.each([
    ['an unknown type in a standard mode', 'macp.mode.decision.v1', 'Contribute'],
    ['an ext mode type', 'ext.multi_round.v1', 'Contribute'],
    ['a reverse-domain mode type', 'com.example.custom.v1', 'Proposal'],
  ])('%s is payload_b64 and keeps its exact bytes', (_label, mode, messageType) => {
    const bytes = new Uint8Array([0xff, 0x00, 0x7f, 0x80, 1]);
    const out = envelopeToCanonicalJson(envelope({ mode, messageType, payload: bytes }));
    expect(out.payload_b64).toBe('/wB/gAE=');
    expect(out).not.toHaveProperty('payload');
    expect(envelopeFromCanonicalJson(out).payload).toEqual(bytes);
  });

  it("payloadEncoding 'b64' forces payload_b64 for Core and standard-mode payloads, keeping exact bytes", () => {
    const vote = envelope();
    // a Commitment with an unknown field: 'auto' would drop it, 'b64' keeps it
    const commitment = envelope({
      messageType: 'Commitment',
      payload: new Uint8Array([0x0a, 0x01, 0x63, 0xf8, 0x07, 0x01]),
    });
    for (const env of [vote, commitment, envelope({ mode: '', messageType: 'Signal', payload: coreBytes })]) {
      const out = envelopeToCanonicalJson(env, { payloadEncoding: 'b64' });
      expect(out).not.toHaveProperty('payload');
      expect(envelopeFromCanonicalJson(out).payload).toEqual(env.payload);
    }
    expect(envelopeToCanonicalJson(vote, { payloadEncoding: 'auto' })).toEqual(envelopeToCanonicalJson(vote));
    expect(envelopeToCanonicalJson(vote, {})).toHaveProperty('payload');
  });

  it("payloadEncoding 'b64' emits even undecodable known bytes", () => {
    const bad = envelope({ payload: new Uint8Array([0x0a, 0x05, 0x61]) });
    expect(envelopeToCanonicalJson(bad, { payloadEncoding: 'b64' }).payload_b64).toBe('CgVh');
  });

  it('refuses an unknown payloadEncoding', () => {
    expect(() => envelopeToCanonicalJson(envelope(), { payloadEncoding: 'json' as unknown as 'auto' })).toThrow(
      /payloadEncoding must be/,
    );
  });

  it('refuses a JSON payload with no known schema', () => {
    expectInvalid(
      () => envelopeFromCanonicalJson(json({ mode: 'ext.multi_round.v1', message_type: 'Contribute' })),
      /no payload schema/,
    );
  });

  it('refuses both payload and payload_b64, and neither', () => {
    expectInvalid(() => envelopeFromCanonicalJson(json({ payload_b64: '' })), /exactly one/);
    const { payload: _p, ...neither } = json();
    expectInvalid(() => envelopeFromCanonicalJson(neither), /exactly one/);
    expectInvalid(() => envelopeFromCanonicalJson({ ...neither, payload: null, payload_b64: null }), /exactly one/);
  });

  it('treats a null payload as absent when payload_b64 is set', () => {
    const parsed = envelopeFromCanonicalJson(json({ payload: null, payload_b64: 'AQI=' }));
    expect(parsed.payload).toEqual(new Uint8Array([1, 2]));
  });

  it('raises instead of falling back to payload_b64 for undecodable known bytes', () => {
    expectInvalid(
      () => envelopeToCanonicalJson(envelope({ payload: new Uint8Array([0x0a, 0x05, 0x61]) })),
      /malformed/,
    );
    expectInvalid(() => envelopeToCanonicalJson(envelope({ payload: new Uint8Array([0x0a, 0x01, 0xff]) })), /UTF-8/);
    expectInvalid(() => envelopeToCanonicalJson(envelope({ payload: new Uint8Array([0x0b]) })), /wire type/);
  });
});

describe('envelope fields', () => {
  it('emits snake_case keys, every string, and an RFC 3339 timestamp', () => {
    const out = envelopeToCanonicalJson(envelope({ timestampUnixMs: '1792918802345', sessionId: '' }));
    expect(Object.keys(out)).toEqual([
      'macp_version',
      'mode',
      'message_type',
      'message_id',
      'session_id',
      'sender',
      'timestamp',
      'payload',
    ]);
    expect(out.session_id).toBe('');
    expect(out.timestamp).toBe('2026-10-25T09:00:02.345Z');
    expect(out.payload).toEqual({ proposal_id: 'p-1', vote: 'APPROVE', reason: '' });
  });

  it('formats whole seconds without a fraction, and the year range edges', () => {
    expect(envelopeToCanonicalJson(envelope({ timestampUnixMs: '0' })).timestamp).toBe('1970-01-01T00:00:00Z');
    expect(envelopeToCanonicalJson(envelope({ timestampUnixMs: '-62135596800000' })).timestamp).toBe(
      '0001-01-01T00:00:00Z',
    );
    expect(envelopeToCanonicalJson(envelope({ timestampUnixMs: '253402300799999' })).timestamp).toBe(
      '9999-12-31T23:59:59.999Z',
    );
    expectInvalid(() => envelopeToCanonicalJson(envelope({ timestampUnixMs: '253402300800000' })), /0001-9999/);
    expectInvalid(() => envelopeToCanonicalJson(envelope({ timestampUnixMs: '-62135596800001' })), /0001-9999/);
    expectInvalid(() => envelopeToCanonicalJson(envelope({ timestampUnixMs: 'soon' })), /not an integer/);
  });

  it.each([
    ['2026-10-25T09:00:02Z', '1792918802000'],
    ['2026-10-25t09:00:02z', '1792918802000'],
    ['2026-10-25T09:00:02.3Z', '1792918802300'],
    ['2026-10-25T09:00:02.123456789Z', '1792918802123'],
    ['2026-10-25T11:30:02+02:30', '1792918802000'],
    ['2026-10-25T05:00:02-04:00', '1792918802000'],
    ['2024-02-29T00:00:00Z', String(Date.parse('2024-02-29T00:00:00Z'))],
    ['0001-01-01T00:00:00Z', '-62135596800000'],
  ])('parses timestamp %s', (timestamp, ms) => {
    expect(envelopeFromCanonicalJson(json({ timestamp })).timestampUnixMs).toBe(ms);
  });

  it.each([
    '2026-10-25 09:00:02Z',
    '2026-10-25T09:00:02',
    '2026-10-25T09:00:60Z',
    '2026-13-01T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-10-25T24:00:00Z',
    '2026-10-25T09:00:02+24:00',
    '2026-10-25T09:00:02.Z',
    '26-10-25T09:00:02Z',
  ])('refuses timestamp %s', (timestamp) => {
    expectInvalid(() => envelopeFromCanonicalJson(json({ timestamp })), /timestamp/);
  });

  it('defaults a missing timestamp to 0 and missing strings to empty', () => {
    const parsed = envelopeFromCanonicalJson({ mode: 'macp.mode.decision.v1', message_type: 'Vote', payload: {} });
    expect(parsed).toEqual({
      macpVersion: '',
      mode: 'macp.mode.decision.v1',
      messageType: 'Vote',
      messageId: '',
      sessionId: '',
      sender: '',
      timestampUnixMs: '0',
      payload: new Uint8Array(),
    });
  });

  it('ignores lowerCamelCase spellings and unknown members, recursively', () => {
    const parsed = envelopeFromCanonicalJson(
      json({
        messageId: 'camel',
        sessionId: 'camel',
        extra: { anything: 1 },
        payload: { proposal_id: 'p-1', proposalId: 'camel', vote: 'APPROVE', unknown: [1] },
      }),
    );
    expect(parsed.messageId).toBe('m-1');
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(decoded('macp.modes.decision.v1.VotePayload', parsed.payload)).toEqual({
      proposalId: 'p-1',
      vote: 'APPROVE',
    });
  });

  it.each([
    ['a non-object envelope', [], /JSON object/],
    ['a numeric mode', { mode: 1 }, /mode: expected a string/],
    ['a numeric timestamp', { timestamp: 1792918802000 }, /RFC 3339 string/],
    ['a non-object payload', { payload: 'x' }, /expected a JSON object/],
    ['bad base64 in payload_b64', { payload: null, payload_b64: 'a' }, /base64/],
  ])('refuses %s', (_label, overrides, message) => {
    expectInvalid(() => envelopeFromCanonicalJson(Array.isArray(overrides) ? overrides : json(overrides)), message);
  });

  it('is an MacpSdkError subclass', () => {
    const error = new CanonicalJsonError('x');
    expect(error).toBeInstanceOf(MacpSdkError);
    expect(error.name).toBe('CanonicalJsonError');
  });
});

describe('payload scalar mapping', () => {
  const start = (payload: Record<string, unknown>) =>
    envelopeFromCanonicalJson(json({ message_type: 'SessionStart', payload }));
  const startJson = (payload: Record<string, unknown>) =>
    envelopeToCanonicalJson(start(payload)).payload as Record<string, unknown>;

  it('emits int64 as a number, quoted above 2^53-1, and accepts both forms', () => {
    expect(startJson({ ttl_ms: 60000 }).ttl_ms).toBe(60000);
    expect(startJson({ ttl_ms: '60000' }).ttl_ms).toBe(60000);
    expect(startJson({ ttl_ms: '9007199254740993' }).ttl_ms).toBe('9007199254740993');
    expect(startJson({ ttl_ms: '-9223372036854775808' }).ttl_ms).toBe('-9223372036854775808');
    expect(startJson({ ttl_ms: 9007199254740991 }).ttl_ms).toBe(9007199254740991);
  });

  it.each([
    [9007199254740993, /must be quoted/],
    [1.5, /integer/],
    ['1.5', /integer/],
    ['1e3', /integer/],
    [' 1', /integer/],
    ['9223372036854775808', /range/],
    [true, /integer/],
  ])('refuses int64 %s', (ttl, message) => {
    expectInvalid(() => start({ ttl_ms: ttl }), message);
  });

  it('emits all non-presence defaults, empty repeated fields, and empty maps', () => {
    expect(startJson({})).toEqual({
      intent: '',
      participants: [],
      mode_version: '',
      configuration_version: '',
      policy_version: '',
      ttl_ms: 0,
      roots: [],
      context_id: '',
      extensions: {},
      max_suspend_ms: 0,
    });
  });

  it('writes the §10.13 bytes: field order, defaults omitted, map keys sorted by UTF-8', () => {
    const parsed = start({
      ttl_ms: 5,
      intent: '',
      extensions: { b: 'Ag==', é: 'Aw==', a: 'AQ==', '￿': '', Z: 'BA' },
      participants: ['x', 'y'],
    });
    // participants(2) → ttl_ms(6) → extensions(9) entries sorted a, b, Z? no: Z (0x5a) < a < b < é < U+FFFF
    const expected = Buffer.concat([
      Buffer.from([0x12, 1, 0x78, 0x12, 1, 0x79]),
      Buffer.from([0x30, 5]),
      Buffer.from([0x4a, 6, 0x0a, 1, 0x5a, 0x12, 1, 4]),
      Buffer.from([0x4a, 6, 0x0a, 1, 0x61, 0x12, 1, 1]),
      Buffer.from([0x4a, 6, 0x0a, 1, 0x62, 0x12, 1, 2]),
      Buffer.from([0x4a, 7, 0x0a, 2, 0xc3, 0xa9, 0x12, 1, 3]),
      Buffer.from([0x4a, 7, 0x0a, 3, 0xef, 0xbf, 0xbf, 0x12, 0]),
    ]);
    expect(Buffer.from(parsed.payload).toString('hex')).toBe(expected.toString('hex'));
    expect(Object.keys(startJson({ extensions: { b: '', a: '', é: '' } }).extensions as object)).toEqual([
      'a',
      'b',
      'é',
    ]);
  });

  it('decodes bytes as standard or URL-safe base64, padded or not, and emits standard padded', () => {
    for (const value of ['+/8=', '+/8', '-_8=', '-_8']) {
      expect(startJson({ extensions: { k: value } }).extensions).toEqual({ k: '+/8=' });
    }
  });

  it.each(['a', '+_8=', 'AQ=', 'AQ===', 'A Q==', '@@@@', 5])('refuses base64 %s', (value) => {
    expectInvalid(() => start({ extensions: { k: value } }), /base64/);
  });

  it('refuses a wrong JSON type, including null inside repeated fields and maps', () => {
    expectInvalid(() => start({ intent: 5 }), /expected a string/);
    expectInvalid(() => start({ participants: 'x' }), /expected an array/);
    expectInvalid(() => start({ participants: ['x', null] }), /null in a repeated field/);
    expectInvalid(() => start({ extensions: { k: null } }), /null map value/);
    expectInvalid(() => start({ extensions: [] }), /JSON object/);
    expectInvalid(() => start({ roots: [5] }), /JSON object/);
    expectInvalid(() => start({ intent: '\ud800' }), /lone surrogate/);
  });

  it('treats a null field as absent', () => {
    expect(startJson({ intent: null, ttl_ms: null }).ttl_ms).toBe(0);
  });

  it('round-trips nested messages', () => {
    const roots = [{ uri: 'file:///a', name: 'A' }, { uri: 'file:///b' }];
    expect(startJson({ roots }).roots).toEqual([
      { uri: 'file:///a', name: 'A' },
      { uri: 'file:///b', name: '' },
    ]);
  });

  describe('doubles', () => {
    const signal = (payload: Record<string, unknown>) =>
      envelopeToCanonicalJson(envelopeFromCanonicalJson(json({ mode: '', message_type: 'Signal', payload })))
        .payload as Record<string, unknown>;

    it('maps NaN and the infinities to strings and accepts numeric strings', () => {
      expect(signal({ confidence: 'NaN' }).confidence).toBe('NaN');
      expect(signal({ confidence: 'Infinity' }).confidence).toBe('Infinity');
      expect(signal({ confidence: '-Infinity' }).confidence).toBe('-Infinity');
      expect(signal({ confidence: '0.25' }).confidence).toBe(0.25);
      expect(signal({ confidence: 0 }).confidence).toBe(0);
      expectInvalid(() => signal({ confidence: 'nan' }), /expected a number/);
      expectInvalid(() => signal({ confidence: '1e999' }), /out of range/);
      expectInvalid(() => signal({ confidence: true }), /expected a number/);
    });

    it('writes a canonical NaN and keeps -0.0', () => {
      const nan = envelopeFromCanonicalJson(json({ mode: '', message_type: 'Signal', payload: { confidence: 'NaN' } }));
      expect(Buffer.from(nan.payload).toString('hex')).toBe('19000000000000f87f');
      const negZero = envelopeFromCanonicalJson(
        json({ mode: '', message_type: 'Signal', payload: { confidence: -0 } }),
      );
      expect(Buffer.from(negZero.payload).toString('hex')).toBe('190000000000000080');
      const zero = envelopeFromCanonicalJson(json({ mode: '', message_type: 'Signal', payload: { confidence: 0 } }));
      expect(zero.payload.length).toBe(0);
    });
  });
});

describe('payload bytes the encoder did not produce', () => {
  it('drops unknown fields', () => {
    const vote = registry.encodeMessage('macp.modes.decision.v1.VotePayload', { proposalId: 'p', vote: 'APPROVE' });
    const unknown = Buffer.from([0xf8, 0x07, 0x01]); // field 127, varint 1
    const out = envelopeToCanonicalJson(envelope({ payload: new Uint8Array(Buffer.concat([vote, unknown])) }));
    expect(out.payload).toEqual({ proposal_id: 'p', vote: 'APPROVE', reason: '' });
    const reparsed = envelopeFromCanonicalJson(out);
    expect(Buffer.from(reparsed.payload).equals(vote)).toBe(true);
  });

  it('takes the last value of a repeated scalar field', () => {
    const bytes = Buffer.concat([
      registry.encodeMessage('macp.modes.decision.v1.VotePayload', { proposalId: 'first' }),
      registry.encodeMessage('macp.modes.decision.v1.VotePayload', { proposalId: 'last' }),
    ]);
    expect(envelopeToCanonicalJson(envelope({ payload: new Uint8Array(bytes) })).payload).toMatchObject({
      proposal_id: 'last',
    });
  });

  it('skips a known field sent with the wrong wire type', () => {
    const wrongWire = Buffer.from([0x0a, 0x01, 0x63, 0x12, 0x01, 0x78, 0x10, 0x01]); // commitment_id "c", action "x", then action (2) as a varint
    const out = envelopeToCanonicalJson(envelope({ messageType: 'Commitment', payload: new Uint8Array(wrongWire) }));
    expect(out.payload).toMatchObject({ commitment_id: 'c', action: 'x' });
  });
});

describe('ack', () => {
  const ack = {
    ok: false,
    duplicate: false,
    messageId: 'm-1',
    sessionId: SESSION_ID,
    acceptedAtUnixMs: '0',
    sessionState: 'SESSION_STATE_OPEN' as const,
    error: {
      code: 'SESSION_NOT_OPEN',
      message: 'session is resolved',
      sessionId: SESSION_ID,
      messageId: 'm-1',
      details: Buffer.from([1, 2, 3]),
    },
  };

  it('emits all seven fields, error only when set', () => {
    const out = ackToCanonicalJson(ack);
    expect(out).toEqual({
      ok: false,
      duplicate: false,
      message_id: 'm-1',
      session_id: SESSION_ID,
      accepted_at_unix_ms: 0,
      session_state: 'SESSION_STATE_OPEN',
      error: {
        code: 'SESSION_NOT_OPEN',
        message: 'session is resolved',
        session_id: SESSION_ID,
        message_id: 'm-1',
        details: 'AQID',
      },
    });
    expect(ackToCanonicalJson({})).toEqual({
      ok: false,
      duplicate: false,
      message_id: '',
      session_id: '',
      accepted_at_unix_ms: 0,
      session_state: 'SESSION_STATE_UNSPECIFIED',
    });
  });

  it('round-trips, with details as bytes', () => {
    const parsed = ackFromCanonicalJson(ackToCanonicalJson(ack));
    expect(parsed.error?.details).toEqual(new Uint8Array([1, 2, 3]));
    expect(ackToCanonicalJson(parsed)).toEqual(ackToCanonicalJson(ack));
  });

  it('quotes accepted_at_unix_ms above 2^53-1 and accepts either form', () => {
    expect(ackToCanonicalJson({ acceptedAtUnixMs: '9007199254740993' }).accepted_at_unix_ms).toBe('9007199254740993');
    expect(ackFromCanonicalJson({ accepted_at_unix_ms: '1792918800000' }).acceptedAtUnixMs).toBe('1792918800000');
    expectInvalid(() => ackFromCanonicalJson({ accepted_at_unix_ms: 9007199254740993 }), /quoted/);
  });

  it('accepts session_state as an integer and maps unknown values to UNSPECIFIED', () => {
    expect(ackFromCanonicalJson({ session_state: 2 }).sessionState).toBe('SESSION_STATE_RESOLVED');
    expect(ackFromCanonicalJson({ session_state: 42 }).sessionState).toBe('SESSION_STATE_UNSPECIFIED');
    expect(ackFromCanonicalJson({ session_state: 'NOPE' }).sessionState).toBe('SESSION_STATE_UNSPECIFIED');
    expectInvalid(() => ackFromCanonicalJson({ session_state: true }), /enum/);
  });

  it('refuses malformed acks', () => {
    expectInvalid(() => ackFromCanonicalJson('ack'), /JSON object/);
    expectInvalid(() => ackFromCanonicalJson({ ok: 'yes' }), /true or false/);
    expectInvalid(() => ackFromCanonicalJson({ error: 'boom' }), /JSON object/);
    expectInvalid(() => ackFromCanonicalJson({ error: { details: '***' } }), /base64/);
  });

  it('treats null members as absent', () => {
    expect(ackFromCanonicalJson({ ok: null, error: null, session_state: null })).toEqual({
      ok: false,
      duplicate: false,
      messageId: '',
      sessionId: '',
      acceptedAtUnixMs: '0',
      sessionState: 'SESSION_STATE_UNSPECIFIED',
    });
  });
});
