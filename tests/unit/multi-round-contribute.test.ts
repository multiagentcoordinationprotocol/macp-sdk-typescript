/**
 * parseContributeValue against macp-runtime's own parse_contribute_value
 * (multi_round.rs, semantics_rev 3). Every expected value below was captured
 * from the runtime function itself (serde_json 1.0.154, prost 0.14.4) by a
 * scratch crate linking macp-modes; a 200k-payload differential fuzz against
 * the same oracle found no mismatch. The contribute_decode_* names are shared
 * with macp-sdk-python.
 */
import { describe, expect, it } from 'vitest';
import { parseContributeValue } from '../../src/multi-round-contribute';
import { MultiRoundProjection } from '../../src/projections/multi-round';
import { ProtoRegistry } from '../../src/proto-registry';
import { buildEnvelope } from '../../src/envelope';
import { MODE_MULTI_ROUND } from '../../src/constants';
import corpus from '../vectors/multi-round-contribute/multi_round_contribute_decode.json';

const hex = (h: string) => Buffer.from(h, 'hex');

// [case, payload hex, what the runtime stores (undefined: it refuses the payload)]
const RUNTIME: [string, string, string | undefined][] = [
  ['legacy JSON', '7b2276616c7565223a2261227d', 'a'],
  ['legacy JSON with whitespace', '200a7b202276616c756522203a20226122207d0d09', 'a'],
  ['legacy JSON with an ignored member', '7b2278223a5b312c7b226b223a6e756c6c7d5d2c2276616c7565223a2261227d', 'a'],
  [
    'duplicate value key',
    '0a207b2276616c7565223a2261222c2276616c7565223a226262626262626262227d',
    '{"value":"a","value":"bbbbbbbb"}',
  ],
  [
    'scalar JSON over proto',
    '0a31313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131312020',
    '1111111111111111111111111111111111111111111111111',
  ],
  ['array form', '5b2261225d', 'a'],
  ['two-element array', '5b2261222c2262225d', undefined],
  [
    'lone surrogate in an ignored member',
    '7b2276616c7565223a2261222c2278223a7b225c7564383030223a225c7564633030227d7d',
    'a',
  ],
  ['lone surrogate in a top-level key', '7b225c7564383030223a312c2276616c7565223a2261227d', undefined],
  ['lone surrogate in value', '7b2276616c7565223a225c7564383030227d', undefined],
  ['duplicate non-value keys', '7b2276616c7565223a2261222c2278223a312c2278223a327d', 'a'],
  ['escaped value key', '7b225c7530303736616c7565223a2261227d', 'a'],
  ['non-string value', '7b2276616c7565223a357d', undefined],
  ['null value', '7b2276616c7565223a6e756c6c7d', undefined],
  ['NaN in an ignored member', '7b2276616c7565223a2261222c2278223a4e614e7d', undefined],
  ['trailing comma', '7b2276616c7565223a2261222c7d', undefined],
  ['byte order mark', 'efbbbf7b2276616c7565223a2261227d', undefined],
  ['trailing vertical tab', '7b2276616c7565223a2261227d0b', undefined],
  ['canonical proto', '0a0568656c6c6f', 'hello'],
  ['proto with an unknown field', '0a0568656c6c6f1001', 'hello'],
  ['proto, last field 1 wins', '0a01610a0162', 'b'],
  ['invalid UTF-8 proto value', '0a02fffe', undefined],
  ['invalid UTF-8 in an earlier field 1', '0a02fffe0a0161', undefined],
  ['field 1 with the wrong wire type', '0801', undefined],
  ['unmatched end group', '0c', undefined],
  ['mismatched end group', '131c', undefined],
  ['tag 0', '00', undefined],
  ['truncated length', '0a0561', undefined],
  [
    'both JSON and canonical proto: proto wins (issue #192 tie-break)',
    '0a207b2276616c7565223a226161616161616161616161616161616161616161227d',
    '{"value":"aaaaaaaaaaaaaaaaaaaa"}',
  ],
  [
    'both JSON and non-canonical proto: JSON wins',
    '0a207b2276616c7565223a226161616161616161616161616161616161616161227d2020',
    'aaaaaaaaaaaaaaaaaaaa',
  ],
  ['a top-level end group', '14', undefined],
  ['a truncated varint', '10ff', undefined],
  ['an object without value', '7b2278223a317d', undefined],
  ['escapes in value', '7b2276616c7565223a22615c6e625c75303065395c2f227d', 'a\nb\u00e9/'],
  [
    'a nested ignored object',
    '7b2276616c7565223a2261222c2278223a7b226b223a312c226c223a5b747275652c66616c73652c2d312e35652d335d7d7d',
    'a',
  ],
];

describe('parseContributeValue matches the runtime', () => {
  it.each(RUNTIME)('%s', (_name, payload, expected) => {
    expect(parseContributeValue(hex(payload))).toBe(expected);
  });

  it('refuses an empty payload', () => {
    expect(parseContributeValue(new Uint8Array())).toBeUndefined();
  });

  it.each([
    ['99 nested groups', '13'.repeat(99) + '14'.repeat(99), ''],
    ['100 nested groups', '13'.repeat(100) + '14'.repeat(100), ''],
    ['a field inside 99 nested groups', '13'.repeat(99) + '1001' + '14'.repeat(99), ''],
    [
      'a field inside 100 nested groups (prost RECURSION_LIMIT)',
      '13'.repeat(100) + '1001' + '14'.repeat(100),
      undefined,
    ],
    ['a 10-byte varint', '10' + 'ff'.repeat(9) + '01', ''],
    ['an 11-byte varint', '10' + 'ff'.repeat(9) + '02', undefined],
    ['a key above u32', 'f8ffffff1f00', undefined],
    ['a fixed32 field', '1501020304', ''],
    ['a truncated fixed64 field', '1101', undefined],
    ['a long canonical value', '0a8001' + '61'.repeat(128), 'a'.repeat(128)],
  ])('prost: %s', (_name, payload, expected) => {
    expect(parseContributeValue(hex(payload))).toBe(expected);
  });

  it('skips a deeply nested ignored member without overflowing the stack', () => {
    const json = '{"value":"a","x":' + '['.repeat(100_000) + ']'.repeat(100_000) + '}';
    expect(parseContributeValue(Buffer.from(json))).toBe('a');
  });

  it.each([
    ['an unterminated string', '{"value":"a'],
    ['a bad escape', '{"value":"\\x"}'],
    ['a short unicode escape', '{"value":"\\u12"}'],
    ['a raw control character', '{"value":"a\tb"}'],
    ['an unclosed ignored array', '{"value":"a","x":[1'],
    ['a misspelled literal', '{"value":"a","x":tru}'],
    ['a leading zero', '{"value":"a","x":01}'],
    ['a bare top-level string', '"a"'],
    ['an empty object', '{}'],
    ['an empty array', '[]'],
  ])('serde refuses %s', (_name, text) => {
    expect(parseContributeValue(Buffer.from(text))).toBeUndefined();
  });
});

describe('the shared runtime-captured corpus (vendored from macp-sdk-python)', () => {
  it('has the 460 cases it was copied with', () => {
    expect(corpus.cases).toHaveLength(460);
  });

  it.each(corpus.cases.map((c) => [c.hex.slice(0, 40), c.hex, c.value] as const))('%s', (_label, payload, value) => {
    expect(parseContributeValue(hex(payload))).toBe(value ?? undefined);
  });
});

describe('MultiRoundProjection stores what the runtime stores', () => {
  const registry = new ProtoRegistry();
  const contribute = (payload: Buffer) => {
    const p = new MultiRoundProjection({ participants: ['agent://alice', 'agent://bob'] });
    p.applyEnvelope(
      buildEnvelope({
        mode: MODE_MULTI_ROUND,
        messageType: 'Contribute',
        sessionId: 's1',
        sender: 'agent://alice',
        payload,
      }),
      registry,
    );
    return p;
  };
  const row = (needle: string) => RUNTIME.find(([name]) => name.startsWith(needle))!;

  it('contribute_decode_duplicate_value_key_falls_to_proto', () => {
    const [, payload, expected] = row('duplicate value key');
    expect(contribute(hex(payload)).contributions.get('agent://alice')).toBe(expected);
    expect(expected).toBe('{"value":"a","value":"bbbbbbbb"}');
  });

  it('contribute_decode_scalar_json_falls_to_proto', () => {
    expect(contribute(hex(row('scalar JSON over proto')[1])).contributions.get('agent://alice')).toBe('1'.repeat(49));
  });

  it('contribute_decode_array_form_is_legacy_json', () => {
    expect(contribute(Buffer.from('["a"]')).contributions.get('agent://alice')).toBe('a');
  });

  it('contribute_decode_ignored_member_lone_surrogate_is_legacy_json', () => {
    expect(contribute(hex(row('lone surrogate in an ignored member')[1])).contributions.get('agent://alice')).toBe('a');
  });

  it('contribute_decode_key_lone_surrogate_falls_to_proto', () => {
    const p = contribute(hex(row('lone surrogate in a top-level key')[1]));
    expect([p.round, p.contributions.size, p.transcript.length]).toEqual([0, 0, 1]);
  });

  it('contribute_decode_invalid_utf8_proto_value_ignored', () => {
    const p = contribute(hex('0a02fffe'));
    expect([p.round, p.contributions.size, p.transcript.length]).toEqual([0, 0, 1]);
  });

  it('records a non-empty payload that decodes to an empty value, as the runtime does', () => {
    for (const payload of [hex('0a00'), Buffer.from('{"value":""}'), hex('1000')]) {
      expect(parseContributeValue(payload)).toBe('');
      const p = contribute(payload);
      expect([p.round, p.contributions.get('agent://alice')]).toEqual([1, '']);
    }
  });
});
