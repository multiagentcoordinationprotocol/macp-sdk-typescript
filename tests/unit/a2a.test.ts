/**
 * The A2A binding codec (src/a2a.ts) beyond the spec vectors
 * (tests/vectors/a2a.test.ts): the vendored RFC-MACP-0014 example replayed
 * end to end, interop with the official A2A 1.0 types (@a2a-js/sdk, a
 * devDependency only), packaging, and the edges no vector pins.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentExtension as OfficialAgentExtension,
  Artifact as OfficialArtifact,
  Message as OfficialMessage,
  Task as OfficialTask,
} from '@a2a-js/sdk';
import { describe, expect, it } from 'vitest';
import {
  A2A_VERSION,
  ackFromA2aMessage,
  ackToA2aMessage,
  envelopeFromA2aArtifact,
  envelopeFromA2aMessage,
  envelopeFromA2aPart,
  envelopeToA2aArtifact,
  envelopeToA2aMessage,
  envelopeToA2aPart,
  errorInfoFromA2a,
  MACP_A2A_EXTENSION_URI,
  macpAgentExtension,
  MacpA2aError,
  MEDIA_TYPE_ENVELOPE_JSON,
  MEDIA_TYPE_ENVELOPE_PROTO,
  sessionStateFromA2a,
  sessionStateToA2a,
  type A2aArtifact,
  type A2aMessage,
  type A2aPart,
  type A2aTask,
} from '../../src/a2a';
import { envelopeFromCanonicalJson, envelopeToCanonicalJson, type CanonicalEnvelope } from '../../src/canonical-json';
import { MacpSdkError } from '../../src/errors';
import * as sdk from '../../src/index';

const SRC = path.join(__dirname, '..', '..', 'src');
const SESSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'a2a_binding_session.json'), 'utf8'),
) as { extension_uri: string; a2a_version: string; exchange: Exchange[] };

interface Exchange {
  step: string;
  request?: { body: Record<string, any> };
  response?: { body: Record<string, any> };
  stream?: Record<string, any>[];
}

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/**
 * The transcript writes Envelope payloads with default members omitted, and
 * the codec emits every member (RFC-MACP-0001 §10), so the transcript
 * comparisons drop default-valued payload members on both sides first.
 */
function withoutPayloadDefaults(value: unknown, inPayload = false): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutPayloadDefaults(v, inPayload));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const isDefault =
      v === '' ||
      v === 0 ||
      v === false ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
    if (inPayload && isDefault) continue;
    out[key] = withoutPayloadDefaults(v, inPayload || key === 'payload');
  }
  return out;
}
const sameAs = (actual: unknown, transcript: unknown) =>
  expect(withoutPayloadDefaults(asJson(actual))).toStrictEqual(withoutPayloadDefaults(transcript));
const SEQ = `${MACP_A2A_EXTENSION_URI}/sequence`;
const STATE = `${MACP_A2A_EXTENSION_URI}/sessionState`;

const vote = (overrides: Partial<CanonicalEnvelope> = {}): CanonicalEnvelope => ({
  ...envelopeFromCanonicalJson({
    macp_version: '1.0',
    mode: 'macp.mode.decision.v1',
    message_type: 'Vote',
    message_id: 'm-3',
    session_id: 's-1',
    sender: 'agent://fraud',
    timestamp: '2026-10-25T09:00:02Z',
    payload: { proposal_id: 'p-1', vote: 'approve', reason: 'ok' },
  }),
  ...overrides,
});
const contribute = (payload: Uint8Array): CanonicalEnvelope => ({
  macpVersion: '1.0',
  mode: 'ext.multi_round.v1',
  messageType: 'Contribute',
  messageId: 'm-9',
  sessionId: 's-2',
  sender: 'agent://alice',
  timestampUnixMs: '0',
  payload,
});

function a2aError(fn: () => unknown): MacpA2aError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MacpA2aError);
    return error as MacpA2aError;
  }
  throw new Error('expected a MacpA2aError');
}

describe('RFC-MACP-0014 example session, replayed end to end', () => {
  // Every A2A object in the transcript is decoded and re-encoded to the same JSON.
  const decoded: string[] = [];

  it('declares the version and URI the codec uses', () => {
    expect(SESSION.extension_uri).toBe(MACP_A2A_EXTENSION_URI);
    expect(SESSION.a2a_version).toBe(A2A_VERSION);
  });

  it.each(SESSION.exchange.map((x) => [x.step.slice(0, 60), x] as const))('%s', (_step, x) => {
    const card = x.response?.body.capabilities;
    if (card) {
      const ext = card.extensions.find((e: { uri: string }) => e.uri === MACP_A2A_EXTENSION_URI);
      const { description: _description, ...rest } = ext;
      const { macpVersions, modes, manifestUrl } = ext.params;
      expect(macpAgentExtension({ macpVersions, modes, required: ext.required, manifestUrl })).toStrictEqual(rest);
      decoded.push('agent-card');
    }
    const request = x.request?.body.params?.message as A2aMessage | undefined;
    if (request) {
      const envelope = envelopeFromA2aMessage(request);
      sameAs(envelopeToA2aMessage(envelope, { messageId: request.messageId, contextId: request.contextId }), request);
      decoded.push('request');
    }
    const result = x.response?.body.result;
    if (result?.message) {
      const reply = result.message as A2aMessage;
      const ack = ackFromA2aMessage(reply);
      expect(
        asJson(ackToA2aMessage(ack, { messageId: reply.messageId, taskId: reply.taskId, contextId: reply.contextId })),
      ).toStrictEqual(reply);
      decoded.push('ack');
    }
    if (result?.status) {
      const task = result as A2aTask;
      const state = sessionStateFromA2a(task);
      expect(state).toBe('SESSION_STATE_RESOLVED');
      expect(sessionStateToA2a(state)).toStrictEqual({ taskState: task.status.state, metadata: task.metadata });
      for (const artifact of task.artifacts ?? []) checkArtifact(artifact);
      decoded.push('task');
    }
    const error = x.response?.body.error;
    if (error) {
      expect(errorInfoFromA2a(error)?.reason).toBe(error.data[0].reason);
      decoded.push('error');
    }
    for (const event of x.stream ?? []) {
      if (event.artifactUpdate) checkArtifact(event.artifactUpdate.artifact);
      if (event.statusUpdate) {
        expect(sessionStateFromA2a(event.statusUpdate)).toBe('SESSION_STATE_RESOLVED');
        decoded.push('status-update');
      }
    }
  });

  function checkArtifact(artifact: A2aArtifact): void {
    const { envelope, sequence } = envelopeFromA2aArtifact(artifact);
    sameAs(envelopeToA2aArtifact(envelope, sequence), artifact);
    decoded.push('artifact');
  }

  it('decoded every kind of object the transcript holds', () => {
    const count = (kind: string) => decoded.filter((d) => d === kind).length;
    expect(count('agent-card')).toBe(1);
    expect(count('request')).toBe(7);
    expect(count('ack')).toBe(5);
    expect(count('task')).toBe(1);
    expect(count('error')).toBe(2);
    expect(count('status-update')).toBe(1);
    expect(count('artifact')).toBeGreaterThanOrEqual(7);
  });
});

describe('interop with the official A2A 1.0 types (@a2a-js/sdk)', () => {
  // fromJSON then toJSON through the SDK's generated types: a member the
  // official schema doesn't know, or a value of the wrong JSON type, would not
  // survive the round trip.
  const roundTrip = (fns: { fromJSON(o: unknown): unknown; toJSON(m: never): unknown }, value: unknown) =>
    asJson(fns.toJSON(fns.fromJSON(value) as never));

  it.each([
    ['a data Part, with contextId', envelopeToA2aMessage(vote(), { contextId: 'ctx-1' })],
    ['a raw Part', envelopeToA2aMessage(vote(), { encoding: 'proto' })],
    [
      'a SessionStart (no taskId)',
      envelopeToA2aMessage({ ...vote({ messageType: 'SessionStart' }), payload: new Uint8Array() }),
    ],
    [
      'a Signal (no taskId)',
      envelopeToA2aMessage(vote({ messageType: 'Signal', mode: '', payload: new Uint8Array() })),
    ],
    ['an accepted Ack', ackToA2aMessage({ ok: true, messageId: 'm-3', sessionId: 's-1' }, { taskId: 's-1' })],
    [
      'a rejected Ack',
      ackToA2aMessage({
        ok: false,
        messageId: 'm-3',
        error: { code: 'SESSION_NOT_OPEN', message: 'closed', sessionId: 's-1', messageId: 'm-3' },
      } as never),
    ],
  ])('a Message: %s', (_name, message) => {
    expect(roundTrip(OfficialMessage, message)).toStrictEqual(asJson(message));
    expect((OfficialMessage.fromJSON(message) as { role: unknown }).role).not.toBe(0); // not ROLE_UNSPECIFIED
  });

  it('an Observation Artifact', () => {
    const artifact = envelopeToA2aArtifact(vote(), 3);
    expect(roundTrip(OfficialArtifact, artifact)).toStrictEqual(asJson(artifact));
  });

  it('an AgentExtension', () => {
    const ext = macpAgentExtension({
      macpVersions: ['1.0'],
      modes: ['macp.mode.decision.v1'],
      required: true,
      manifestUrl: 'https://runtime.example.com/.well-known/macp.json',
    });
    expect(roundTrip(OfficialAgentExtension, ext)).toStrictEqual(asJson(ext));
  });

  it('decodes the session state of a Task the official types emit', () => {
    const { taskState, metadata } = sessionStateToA2a('SESSION_STATE_SUSPENDED');
    const task = OfficialTask.toJSON(
      OfficialTask.fromJSON({ id: 's-1', contextId: 'c', status: { state: taskState }, metadata }),
    ) as A2aTask;
    expect(sessionStateFromA2a(task)).toBe('SESSION_STATE_SUSPENDED');
  });
});

describe('a2a packaging', () => {
  it('is exported from the package root', () => {
    expect(sdk.envelopeToA2aPart).toBe(envelopeToA2aPart);
    expect(sdk.MacpA2aError).toBe(MacpA2aError);
    expect(sdk.MACP_A2A_EXTENSION_URI).toBe(MACP_A2A_EXTENSION_URI);
  });

  it('is a ./a2a subpath export', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8'));
    expect(pkg.exports['./a2a']).toStrictEqual({ types: './dist/a2a.d.ts', default: './dist/a2a.js' });
  });

  it('imports nothing Node-only and no A2A SDK at runtime', () => {
    const seen = new Map<string, string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      const source = fs.readFileSync(file, 'utf8');
      seen.set(file, source);
      for (const match of source.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = match[1]!;
        expect(spec.startsWith('.'), `${path.relative(SRC, file)} imports ${spec}`).toBe(true);
        if (!spec.endsWith('.json')) visit(`${path.resolve(path.dirname(file), spec)}.ts`);
      }
    };
    visit(path.join(SRC, 'a2a.ts'));
    expect([...seen.keys()].map((f) => path.relative(SRC, f)).sort()).toEqual([
      'a2a.ts',
      'canonical-json.ts',
      'constants.ts',
      'errors.ts',
    ]);
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(strip(seen.get(path.join(SRC, 'a2a.ts'))!)).not.toMatch(/\bBuffer\b|require\(|\bprocess\./);
  });
});

describe('envelope Parts', () => {
  it('round-trips a JSON payload through a raw Part, byte for byte', () => {
    const env = vote();
    const part = envelopeToA2aPart(env, { encoding: 'proto' });
    expect(part.mediaType).toBe(MEDIA_TYPE_ENVELOPE_PROTO);
    const back = envelopeFromA2aPart(part);
    expect(back.payload).toStrictEqual(env.payload);
    expect(envelopeToCanonicalJson(back)).toStrictEqual(envelopeToCanonicalJson(env));
  });

  it('refuses an unknown encoding', () => {
    // a programming error, not a codec outcome
    expect(() => envelopeToA2aPart(vote(), { encoding: 'xml' as never })).toThrow(RangeError);
  });

  it('measures a JSON payload after its Protobuf conversion', () => {
    const part = envelopeToA2aPart(vote());
    const size = vote().payload.length;
    expect(envelopeFromA2aPart(part, { maxPayloadBytes: size }).payload.length).toBe(size);
    const error = a2aError(() => envelopeFromA2aPart(part, { maxPayloadBytes: size - 1 }));
    expect([error.layer, error.code]).toEqual(['macp', 'PAYLOAD_TOO_LARGE']);
  });

  describe('a payload_b64 over the limit', () => {
    // Same order as macp-sdk-python: other members, then the base64 text,
    // then the size, then the decode.
    const data = envelopeToCanonicalJson(contribute(new Uint8Array(0)));
    const decode = (extra: Record<string, unknown>) =>
      a2aError(() =>
        envelopeFromA2aPart(
          { mediaType: MEDIA_TYPE_ENVELOPE_JSON, data: { ...data, ...extra } },
          { maxPayloadBytes: 4 },
        ),
      ).code;

    it('is PAYLOAD_TOO_LARGE when the Envelope is otherwise valid', () => {
      expect(decode({ payload_b64: 'AAAAAAAA' })).toBe('PAYLOAD_TOO_LARGE');
      expect(decode({ payload_b64: 'AAAAAAA=' })).toBe('PAYLOAD_TOO_LARGE'); // 5 bytes
    });

    it('is INVALID_ENVELOPE when the base64 is malformed', () => {
      expect(decode({ payload_b64: '!!!!!!!!' })).toBe('INVALID_ENVELOPE');
      expect(decode({ payload_b64: 'AAAAA' })).toBe('INVALID_ENVELOPE'); // length 1 mod 4
    });

    it('is INVALID_ENVELOPE when another member is malformed', () => {
      expect(decode({ payload_b64: 'AAAAAAAA', timestamp: 'yesterday' })).toBe('INVALID_ENVELOPE');
    });

    it('accepts exactly the limit', () => {
      const part = { mediaType: MEDIA_TYPE_ENVELOPE_JSON, data: { ...data, payload_b64: 'AAAAAA==' } };
      expect(envelopeFromA2aPart(part, { maxPayloadBytes: 4 }).payload.length).toBe(4);
    });
  });

  it('applies the 1 MiB default', () => {
    const at = contribute(new Uint8Array(1048576));
    expect(envelopeFromA2aPart(envelopeToA2aPart(at)).payload.length).toBe(1048576);
    expect(envelopeFromA2aPart(envelopeToA2aPart(at, { encoding: 'proto' })).payload.length).toBe(1048576);
    const over = contribute(new Uint8Array(1048577));
    expect(a2aError(() => envelopeFromA2aPart(envelopeToA2aPart(over))).code).toBe('PAYLOAD_TOO_LARGE');
    expect(a2aError(() => envelopeFromA2aPart(envelopeToA2aPart(over, { encoding: 'proto' }))).code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('accepts a raw timestamp of the last millisecond of year 9999', () => {
    expect(envelopeFromA2aPart({ mediaType: MEDIA_TYPE_ENVELOPE_PROTO, raw: 'OP+3/5D9zjk=' }).timestampUnixMs).toBe(
      '253402300799999',
    );
  });

  it.each(['json', 'proto'] as const)('refuses to encode a %s Envelope dated after year 9999', (encoding) => {
    const error = a2aError(() => envelopeToA2aPart(vote({ timestampUnixMs: '253402300800000' }), { encoding }));
    expect([error.layer, error.code]).toEqual(['macp', 'INVALID_ENVELOPE']);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, '5'])('refuses maxPayloadBytes %s', (limit) => {
    const decode = () => envelopeFromA2aPart(envelopeToA2aPart(vote()), { maxPayloadBytes: limit as number });
    expect(decode).toThrow(RangeError);
    expect(decode).toThrow(/maxPayloadBytes must be a non-negative integer/);
  });

  it.each([
    ['not an object', 'x', 'codec', 'NOT_A_MACP_MESSAGE'],
    ['another mediaType', { mediaType: 'application/json', data: {} }, 'codec', 'NOT_A_MACP_MESSAGE'],
    [
      'a JSON Part whose data is an array',
      { mediaType: MEDIA_TYPE_ENVELOPE_JSON, data: [] },
      'macp',
      'INVALID_ENVELOPE',
    ],
    ['a raw Part with null raw', { mediaType: MEDIA_TYPE_ENVELOPE_PROTO, raw: null }, 'macp', 'INVALID_ENVELOPE'],
    ['a raw Part that is not base64', { mediaType: MEDIA_TYPE_ENVELOPE_PROTO, raw: '@@' }, 'macp', 'INVALID_ENVELOPE'],
    [
      'a raw timestamp after year 9999',
      { mediaType: MEDIA_TYPE_ENVELOPE_PROTO, raw: 'OIC4/5D9zjk=' },
      'macp',
      'INVALID_ENVELOPE',
    ],
    ['truncated raw bytes', { mediaType: MEDIA_TYPE_ENVELOPE_PROTO, raw: 'CgUxLjA=' }, 'macp', 'INVALID_ENVELOPE'],
  ])('refuses %s', (_name, part, layer, code) => {
    const error = a2aError(() => envelopeFromA2aPart(part as A2aPart));
    expect([error.layer, error.code]).toEqual([layer, code]);
  });
});

describe('Messages', () => {
  it('names the session as taskId except on SessionStart and Signal', () => {
    const message = envelopeToA2aMessage(vote());
    expect(message).toStrictEqual({
      messageId: 'm-3',
      role: 'ROLE_USER',
      parts: [envelopeToA2aPart(vote())],
      extensions: [MACP_A2A_EXTENSION_URI],
      taskId: 's-1',
    });
    expect(envelopeToA2aMessage(vote({ messageType: 'Signal', mode: '' })).taskId).toBeUndefined();
    expect(envelopeToA2aMessage(vote(), { messageId: 'retry-1' }).messageId).toBe('retry-1');
    // an Envelope with no message_id still gets a non-empty A2A messageId
    expect(envelopeToA2aMessage(vote({ messageId: '' })).messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('decodes a SessionStart or Signal whatever its taskId (the server judges it)', () => {
    const signal = vote({ messageType: 'Signal', mode: '', payload: new Uint8Array() });
    expect(envelopeFromA2aMessage({ ...envelopeToA2aMessage(signal), taskId: 'anything' }).messageType).toBe('Signal');
  });

  it.each([
    ['not an object', null, 'codec', 'NOT_A_MACP_MESSAGE'],
    ['parts not an array', { messageId: 'x', role: 'ROLE_USER', parts: {} }, 'codec', 'NOT_A_MACP_MESSAGE'],
    ['a missing taskId', { ...envelopeToA2aMessage(vote()), taskId: undefined }, 'macp', 'INVALID_ENVELOPE'],
  ])('refuses %s', (_name, message, layer, code) => {
    const error = a2aError(() => envelopeFromA2aMessage(message as A2aMessage));
    expect([error.layer, error.code]).toEqual([layer, code]);
  });
});

// RFC-MACP-0014 1.1.2-draft §5.1 media type comparison (issue #247). The
// test names are shared with macp-sdk-python.
describe('Envelope Part media type comparison', () => {
  const part = (mediaType: unknown) => ({ ...envelopeToA2aPart(vote()), mediaType }) as A2aPart;
  const message = (...parts: A2aPart[]): A2aMessage => ({ ...envelopeToA2aMessage(vote()), parts });

  it.each(['Application/MACP-Envelope+JSON', 'APPLICATION/MACP-ENVELOPE+JSON'])(
    'media_type_case_variant_is_envelope_part: %s',
    (mediaType) => {
      const exact = envelopeFromA2aPart(envelopeToA2aPart(vote()));
      expect(envelopeFromA2aPart(part(mediaType))).toStrictEqual(exact);
      expect(envelopeFromA2aMessage(message(part(mediaType)))).toStrictEqual(exact);
    },
  );

  it('media_type_case_variant_is_envelope_part: the proto encoding too', () => {
    const raw = envelopeToA2aPart(vote(), { encoding: 'proto' });
    expect(envelopeFromA2aPart({ ...raw, mediaType: 'Application/Macp-Envelope+Proto' }).messageId).toBe('m-3');
  });

  it.each([
    ' \tapplication/macp-envelope+json',
    'application/macp-envelope+json\t ',
    ' application/macp-envelope+json ',
  ])('media_type_whitespace_ignored: %j', (mediaType) => {
    expect(envelopeFromA2aPart(part(mediaType)).messageId).toBe('m-3');
  });

  it.each([
    'application/macp-envelope+json; charset=utf-8',
    'application/macp-envelope+json;charset=utf-8',
    'application/macp-envelope+json ;',
    'application/macp-envelope+json;',
    'Application/MACP-Envelope+Proto; x=y',
  ])('media_type_parameters_rejected_before_decode: %j', (mediaType) => {
    const error = a2aError(() => envelopeFromA2aPart(part(mediaType)));
    expect([error.layer, error.code]).toEqual(['a2a', 'INVALID_REQUEST']);
    expect(error.message).toMatch(/ContentTypeNotSupportedError/);
    // a Part whose content doesn't decode is still refused as a content type, never INVALID_ENVELOPE
    const broken = a2aError(() =>
      envelopeFromA2aPart({ mediaType, data: 'not an object', raw: 'not base64!' } as A2aPart),
    );
    expect([broken.layer, broken.code]).toEqual(['a2a', 'INVALID_REQUEST']);
    // a lone parameter-bearing Part in a Message is refused the same way
    const inMessage = a2aError(() => envelopeFromA2aMessage(message(part(mediaType))));
    expect([inMessage.layer, inMessage.code]).toEqual(['a2a', 'INVALID_REQUEST']);
  });

  it.each([
    ['a parameter-bearing Part', 'application/macp-envelope+json; charset=utf-8'],
    ['a case-variant Part', 'APPLICATION/macp-envelope+json'],
    ['a whitespace-padded Part', ' application/macp-envelope+proto'],
  ])('media_type_parameter_part_counts_toward_single_envelope: %s', (_name, mediaType) => {
    const error = a2aError(() =>
      envelopeFromA2aMessage(message(part('application/macp-envelope+json'), part(mediaType))),
    );
    expect([error.layer, error.code]).toEqual(['a2a', 'INVALID_REQUEST']);
    expect(error.message).toMatch(/two or more Envelope Parts/);
  });

  it.each([
    ['a long s (U+017F)', 'application/macp-envelope+j\u017fon'],
    ['a dotless i (U+0131)', 'appl\u0131cation/macp-envelope+json'],
    ['a dotted capital I (U+0130)', 'applicat\u0130on/macp-envelope+json'],
    ['a non-breaking space', '\u00a0application/macp-envelope+json'],
  ])('media_type_non_ascii_lookalike_ignored: %s', (_name, mediaType) => {
    const error = a2aError(() => envelopeFromA2aPart(part(mediaType)));
    expect([error.layer, error.code]).toEqual(['codec', 'NOT_A_MACP_MESSAGE']);
    // skipped as a Part that isn't MACP, so the exact Part beside it decodes alone
    expect(envelopeFromA2aMessage(message(part(mediaType), part('application/macp-envelope+json'))).messageId).toBe(
      'm-3',
    );
  });

  it.each([
    ['a non-string mediaType', 5],
    ['no mediaType', undefined],
    ['another subtype', 'application/macp-envelope+xml'],
    ['parameters on a type that is not MACP', 'application/json; charset=utf-8'],
    ['whitespace inside the type', 'application / macp-envelope+json'],
    ['a bare semicolon', ';'],
    ['a padded bare semicolon', ' ; '],
  ])('is not an Envelope Part: %s', (_name, mediaType) => {
    const error = a2aError(() => envelopeFromA2aPart(part(mediaType)));
    expect([error.layer, error.code]).toEqual(['codec', 'NOT_A_MACP_MESSAGE']);
  });

  it('media_type_parameter_part_counts_toward_single_envelope: two parameter-bearing Parts are two Envelope Parts', () => {
    const withParams = part('application/macp-envelope+json; charset=utf-8');
    const error = a2aError(() => envelopeFromA2aMessage(message(withParams, withParams)));
    expect([error.layer, error.code]).toEqual(['a2a', 'INVALID_REQUEST']);
    expect(error.message).toMatch(/two or more Envelope Parts/);
  });

  it('applies the same comparison to an Artifact', () => {
    const artifact = envelopeToA2aArtifact(vote(), 3);
    const variant = { ...artifact, parts: [part('Application/MACP-Envelope+JSON')] };
    expect(envelopeFromA2aArtifact(variant).envelope.messageId).toBe('m-3');
    const withParams = { ...artifact, parts: [part('application/macp-envelope+json; x=y')] };
    const error = a2aError(() => envelopeFromA2aArtifact(withParams));
    expect([error.layer, error.code]).toEqual(['a2a', 'INVALID_REQUEST']);
  });

  it('encoders still write the exact lowercase type with no parameters', () => {
    expect(envelopeToA2aPart(vote()).mediaType).toBe('application/macp-envelope+json');
    expect(envelopeToA2aPart(vote(), { encoding: 'proto' }).mediaType).toBe('application/macp-envelope+proto');
  });
});

describe('Acks', () => {
  const ok = { ok: true, messageId: 'm-1', sessionId: 's-1', sessionState: 'SESSION_STATE_OPEN' as const };

  it('generates a messageId when none is given', () => {
    const a = ackToA2aMessage(ok).messageId;
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ackToA2aMessage(ok).messageId).not.toBe(a);
    expect(ackToA2aMessage(ok).taskId).toBeUndefined();
  });

  it.each([
    [2, 'SESSION_STATE_RESOLVED'],
    [7, 'SESSION_STATE_UNSPECIFIED'],
    ['SESSION_STATE_BOGUS', 'SESSION_STATE_UNSPECIFIED'],
    ['toString', 'SESSION_STATE_UNSPECIFIED'],
  ])('writes session_state %s by name', (state, name) => {
    const part = ackToA2aMessage({ ...ok, sessionState: state as never }).parts[0]!;
    expect((part.data as Record<string, unknown>).session_state).toBe(name);
  });

  it('refuses a non-boolean ok with a TypeError', () => {
    expect(() => ackToA2aMessage({ ...ok, ok: 'yes' as never })).toThrow(TypeError);
  });

  it('generates a UUID without crypto.randomUUID (a non-secure browser context)', () => {
    const randomUUID = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(ackToA2aMessage(ok).messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUUID, configurable: true });
    }
  });

  it('refuses to encode an Ack whose error does not match ok', () => {
    expect(a2aError(() => ackToA2aMessage({ ok: false })).code).toBe('INVALID_ACK');
    expect(a2aError(() => ackToA2aMessage({ ...ok, error: { code: 'X' } } as never)).code).toBe('INVALID_ACK');
  });

  it.each([
    ['not an object', 'x', 'NOT_A_MACP_MESSAGE'],
    ['no metadata kind', { parts: [{ mediaType: 'application/json', data: {} }] }, 'NOT_A_MACP_MESSAGE'],
    ['two Ack Parts', { parts: [ackToA2aMessage(ok).parts[0], ackToA2aMessage(ok).parts[0]] }, 'INVALID_ACK'],
    ['an Ack that is not an object', { parts: [{ ...ackToA2aMessage(ok).parts[0], data: [] }] }, 'INVALID_ACK'],
    [
      'a lone surrogate',
      { parts: [{ ...ackToA2aMessage(ok).parts[0], data: { ok: true, message_id: '\ud800' } }] },
      'INVALID_ACK',
    ],
  ])('refuses %s', (_name, message, code) => {
    const error = a2aError(() => ackFromA2aMessage(message as A2aMessage));
    expect([error.layer, error.code]).toEqual(['codec', code]);
  });
});

describe('Artifacts', () => {
  it.each([0, -1, 1.5, Number.NaN, 2 ** 53, '2', null])('refuses sequence %s', (sequence) => {
    expect(a2aError(() => envelopeToA2aArtifact(vote(), sequence as number)).code).toBe('INVALID_SEQUENCE');
    const artifact = { ...envelopeToA2aArtifact(vote(), 1), metadata: { [SEQ]: sequence } };
    expect(a2aError(() => envelopeFromA2aArtifact(artifact)).code).toBe('INVALID_SEQUENCE');
  });

  it('checks the sequence before the Part, and refuses a non-object', () => {
    expect(a2aError(() => envelopeFromA2aArtifact({ artifactId: 'a', parts: [] })).code).toBe('INVALID_SEQUENCE');
    expect(a2aError(() => envelopeFromA2aArtifact({ artifactId: 'a', parts: [], metadata: { [SEQ]: 1 } })).code).toBe(
      'NOT_A_MACP_MESSAGE',
    );
    expect(a2aError(() => envelopeFromA2aArtifact([] as never)).code).toBe('NOT_A_MACP_MESSAGE');
  });

  it('passes maxPayloadBytes through', () => {
    const artifact = envelopeToA2aArtifact(contribute(new Uint8Array(5)), 1);
    expect(a2aError(() => envelopeFromA2aArtifact(artifact, { maxPayloadBytes: 4 })).code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('session state', () => {
  it.each([
    [1, 'TASK_STATE_WORKING', 'OPEN'],
    [2, 'TASK_STATE_COMPLETED', 'RESOLVED'],
    [3, 'TASK_STATE_FAILED', 'EXPIRED'],
    [4, 'TASK_STATE_WORKING', 'SUSPENDED'],
    [5, 'TASK_STATE_CANCELED', 'CANCELLED'],
  ])('maps the enum number %s', (number, taskState, bare) => {
    expect(sessionStateToA2a(number)).toStrictEqual({ taskState, metadata: { [STATE]: bare } });
  });

  it.each([0, 6, -1, 'SESSION_STATE_NOPE', 'OPEN', 'toString', '__proto__'])('refuses %s', (state) => {
    expect(a2aError(() => sessionStateToA2a(state as never)).code).toBe('INVALID_SESSION_STATE');
  });

  it.each([null, 'x', { metadata: null }, { metadata: { [STATE]: 'open' } }, { metadata: { [STATE]: 1 } }])(
    'refuses %j',
    (input) => {
      expect(a2aError(() => sessionStateFromA2a(input as never)).code).toBe('INVALID_SESSION_STATE');
    },
  );
});

describe('AgentExtension and ErrorInfo', () => {
  it('copies the version and mode lists', () => {
    const modes = ['macp.mode.decision.v1'];
    const ext = macpAgentExtension({ macpVersions: ['1.0'], modes });
    modes.push('changed');
    expect(ext).toStrictEqual({
      uri: MACP_A2A_EXTENSION_URI,
      required: false,
      params: { macpVersions: ['1.0'], modes: ['macp.mode.decision.v1'], transport: 'macp.transport.a2a.v1' },
    });
  });

  it.each([
    ['a bare string for macpVersions', { macpVersions: '1.0', modes: [] }],
    ['a bare string for modes', { macpVersions: ['1.0'], modes: 'macp.mode.decision.v1' }],
    ['a non-string mode', { macpVersions: ['1.0'], modes: [1] }],
    ['a non-boolean required', { macpVersions: ['1.0'], modes: [], required: 'yes' }],
  ])('refuses %s with a TypeError', (_name, options) => {
    expect(() => macpAgentExtension(options as never)).toThrow(TypeError);
  });

  const info = (extra: Record<string, unknown> = {}) => ({
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    domain: 'multiagentcoordinationprotocol.io',
    ...extra,
  });

  it.each([
    ['null', null],
    ['a string', 'boom'],
    ['an error with no data', { code: -32004, message: 'x' }],
    ['data not an array', { code: -32004, data: {} }],
    ['another domain', [info({ domain: 'a2a-protocol.org' })]],
    ['another @type', [info({ '@type': 'type.googleapis.com/google.rpc.BadRequest' })]],
    ['non-object entries', [null, 5, 'x']],
  ])('returns null for %s', (_name, input) => {
    expect(errorInfoFromA2a(input)).toBeNull();
  });

  it('defaults a missing reason and metadata', () => {
    expect(errorInfoFromA2a([info()])).toStrictEqual({
      reason: '',
      domain: 'multiagentcoordinationprotocol.io',
      metadata: {},
      duplicate: false,
    });
    expect(errorInfoFromA2a([info({ reason: 5, metadata: 'x' })])?.reason).toBe('');
  });
});

describe('MacpA2aError', () => {
  it('is a MacpSdkError carrying layer and code', () => {
    const error = new MacpA2aError('macp', 'INVALID_ENVELOPE', 'bad');
    expect(error).toBeInstanceOf(MacpSdkError);
    expect([error.name, error.layer, error.code, error.message]).toEqual([
      'MacpA2aError',
      'macp',
      'INVALID_ENVELOPE',
      'bad',
    ]);
  });
});
