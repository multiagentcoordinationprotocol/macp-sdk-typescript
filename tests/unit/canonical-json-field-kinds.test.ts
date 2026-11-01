/**
 * Field kinds no current payload message uses (every scalar type, enums,
 * packed numerics, non-string map keys, explicit presence), exercised through
 * a synthetic schema swapped in for `macp.v1.SignalPayload`. protobufjs,
 * built from the same definition, is the independent reference for the
 * wire bytes in both directions.
 */
import protobuf from 'protobufjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  envelopeFromCanonicalJson,
  envelopeToCanonicalJson,
  setSchemaForTesting,
  type MacpSchema,
  type SchemaField,
} from '../../src/canonical-json';
import schemaJson from '../../src/generated/macp-schema.json';

const scalar = (name: string, id: number, type: string, extra: Partial<SchemaField> = {}): SchemaField => ({
  name,
  id,
  type,
  kind: 'scalar',
  ...extra,
});

const ALL_KINDS: SchemaField[] = [
  scalar('i32', 1, 'int32'),
  scalar('i64', 2, 'int64'),
  scalar('u32', 3, 'uint32'),
  scalar('u64', 4, 'uint64'),
  scalar('s32', 5, 'sint32'),
  scalar('s64', 6, 'sint64'),
  scalar('f32', 7, 'fixed32'),
  scalar('f64', 8, 'fixed64'),
  scalar('sf32', 9, 'sfixed32'),
  scalar('sf64', 10, 'sfixed64'),
  scalar('fl', 11, 'float'),
  scalar('db', 12, 'double'),
  scalar('b', 13, 'bool'),
  { name: 'color', id: 14, type: 'test.Color', kind: 'enum' },
  scalar('nums', 15, 'int32', { repeated: true }),
  { name: 'colors', id: 16, type: 'test.Color', kind: 'enum', repeated: true },
  scalar('by_int', 17, 'string', { keyType: 'int32' }),
  scalar('by_bool', 18, 'bytes', { keyType: 'bool' }),
  { name: 'children', id: 19, type: 'test.Child', kind: 'message', keyType: 'string' },
  scalar('opt', 20, 'int32', { presence: true }),
  { name: 'child', id: 21, type: 'test.Child', kind: 'message' },
  scalar('dbls', 22, 'double', { repeated: true }),
  scalar('u64s', 23, 'uint64', { repeated: true }),
  { name: 'kids', id: 24, type: 'test.Child', kind: 'message', repeated: true },
  scalar('tags', 25, 'string', { repeated: true }),
];

const generated = schemaJson as unknown as MacpSchema;
const SYNTHETIC: MacpSchema = {
  ...generated,
  messages: { ...generated.messages, 'macp.v1.SignalPayload': ALL_KINDS, 'test.Child': [scalar('name', 1, 'string')] },
  enums: { ...generated.enums, 'test.Color': { COLOR_UNSPECIFIED: 0, RED: 1, BLUE: 2 } },
};

// The same message for protobufjs (proto3: packed repeated numerics by default).
const reference = protobuf.Root.fromJSON({
  nested: {
    test: {
      nested: {
        Color: { values: { COLOR_UNSPECIFIED: 0, RED: 1, BLUE: 2 } },
        Child: { fields: { name: { type: 'string', id: 1 } } },
        AllKinds: {
          oneofs: { _opt: { oneof: ['opt'] } },
          fields: Object.fromEntries(
            ALL_KINDS.map((f) => [
              f.name,
              {
                type: f.type,
                id: f.id,
                ...(f.repeated ? { rule: 'repeated' } : {}),
                ...(f.keyType ? { keyType: f.keyType } : {}),
                ...(f.presence ? { options: { proto3_optional: true } } : {}),
              },
            ]),
          ),
        },
      },
    },
  },
}).lookupType('test.AllKinds');

const toBytes = (payload: Record<string, unknown>): Uint8Array =>
  envelopeFromCanonicalJson({ mode: '', message_type: 'Signal', payload }).payload;
const toJson = (bytes: Uint8Array): Record<string, unknown> =>
  envelopeToCanonicalJson({
    macpVersion: '1.0',
    mode: '',
    messageType: 'Signal',
    messageId: '',
    sessionId: '',
    sender: '',
    timestampUnixMs: '0',
    payload: bytes,
  }).payload as Record<string, unknown>;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function expectInvalid(fn: () => unknown, message: RegExp): void {
  expect(fn).toThrow(CanonicalJsonError);
  expect(fn).toThrow(message);
}

const FULL = {
  i32: -5,
  i64: '-9007199254740993',
  u32: 4294967295,
  u64: '18446744073709551615',
  s32: -2147483648,
  s64: '-9223372036854775808',
  f32: 4294967295,
  f64: '18446744073709551615',
  sf32: -2147483648,
  sf64: '-9223372036854775808',
  fl: 1.5,
  db: -0.125,
  b: true,
  color: 'BLUE',
  nums: [1, -1, 300],
  colors: ['RED', 'BLUE'],
  by_int: { '-1': 'neg', '10': 'ten', '2': 'two' },
  by_bool: { true: 'AQ==', false: '' },
  children: { b: { name: 'B' }, a: {} },
  opt: 0,
  child: { name: 'C' },
  dbls: [0.5, 'NaN', '-Infinity'],
  u64s: ['18446744073709551615', 0],
  kids: [{ name: 'k1' }, {}],
  tags: ['x', ''],
};

describe('field kinds outside the current payload schemas', () => {
  beforeAll(() => setSchemaForTesting(SYNTHETIC));
  afterAll(() => setSchemaForTesting(undefined));

  it('emits every non-presence default and omits unset presence and message fields', () => {
    expect(toJson(new Uint8Array())).toEqual({
      i32: 0,
      i64: 0,
      u32: 0,
      u64: 0,
      s32: 0,
      s64: 0,
      f32: 0,
      f64: 0,
      sf32: 0,
      sf64: 0,
      fl: 0,
      db: 0,
      b: false,
      color: 'COLOR_UNSPECIFIED',
      nums: [],
      colors: [],
      by_int: {},
      by_bool: {},
      children: {},
      dbls: [],
      u64s: [],
      kids: [],
      tags: [],
    });
    expect(toBytes({ i32: 0, color: 'COLOR_UNSPECIFIED', b: false, nums: [], by_int: {} }).length).toBe(0);
  });

  it('round-trips every kind at its range edges, and the canonical bytes are a fixed point', () => {
    const bytes = toBytes(FULL);
    const out = toJson(bytes);
    expect(out).toEqual({
      ...FULL,
      by_int: { '-1': 'neg', '10': 'ten', '2': 'two' },
      by_bool: { false: '', true: 'AQ==' },
      children: { a: { name: '' }, b: { name: 'B' } },
      kids: [{ name: 'k1' }, { name: '' }],
    });
    // JS orders integer-like keys numerically whatever the insertion order, so the
    // UTF-8 order shows only in the bytes (§10.13 rule 5), not in the object.
    expect(hex(toBytes({ by_int: { '2': '', '10': '', '-1': '' } }))).toBe(
      '8a010d08ffffffffffffffffff011200' + // "-1"
        '8a0104080a1200' + // "10"
        '8a010408021200', // "2"
    );
    expect(hex(toBytes(out))).toBe(hex(bytes));
  });

  it('writes bytes protobufjs decodes to the same values', () => {
    const message = reference.toObject(reference.decode(toBytes(FULL)), {
      longs: String,
      enums: String,
      bytes: String,
    });
    expect(message).toMatchObject({
      i32: -5,
      i64: '-9007199254740993',
      u32: 4294967295,
      u64: '18446744073709551615',
      s32: -2147483648,
      s64: '-9223372036854775808',
      f32: 4294967295,
      f64: '18446744073709551615',
      sf32: -2147483648,
      sf64: '-9223372036854775808',
      fl: 1.5,
      db: -0.125,
      b: true,
      color: 'BLUE',
      nums: [1, -1, 300],
      colors: ['RED', 'BLUE'],
      by_int: { '-1': 'neg', '10': 'ten', '2': 'two' },
      by_bool: { true: 'AQ==', false: '' },
      opt: 0,
      child: { name: 'C' },
      u64s: ['18446744073709551615', '0'],
      tags: ['x', ''],
    });
    expect(Number.isNaN((message.dbls as number[])[1])).toBe(true);
  });

  it('reads bytes protobufjs wrote, packed or not', () => {
    const value = {
      i32: -5,
      s64: '-3',
      color: 2,
      nums: [1, -1, 300],
      colors: [1, 2],
      dbls: [0.5],
      by_int: { 7: 'seven' },
      by_bool: { true: Buffer.from([1]) },
      opt: 0,
    };
    const packed = reference.encode(reference.fromObject(value)).finish();
    const expected = {
      i32: -5,
      s64: -3,
      color: 'BLUE',
      nums: [1, -1, 300],
      colors: ['RED', 'BLUE'],
      dbls: [0.5],
      by_int: { 7: 'seven' },
      by_bool: { true: 'AQ==' },
      opt: 0,
    };
    expect(toJson(packed)).toMatchObject(expected);
    // unpacked: one tag per element, the proto2 form a decoder must accept
    const unpacked = Buffer.from([0x78, 0x01, 0x78, 0x02, 0x80, 0x01, 0x01]);
    expect(toJson(new Uint8Array(unpacked))).toMatchObject({ nums: [1, 2], colors: ['RED'] });
  });

  it('packs repeated numerics and leaves repeated strings and messages unpacked', () => {
    expect(hex(toBytes({ nums: [1, 2] }))).toBe('7a020102');
    expect(hex(toBytes({ tags: ['a', 'b'] }))).toBe('ca010161ca010162');
    expect(hex(toBytes({ kids: [{}, {}] }))).toBe('c20100c20100');
  });

  it('writes a present presence field even at its default, and drops it when absent or null', () => {
    expect(hex(toBytes({ opt: 0 }))).toBe('a00100');
    expect(toJson(toBytes({ opt: 0 }))).toHaveProperty('opt', 0);
    expect(toJson(toBytes({ opt: null }))).not.toHaveProperty('opt');
  });

  it('encodes a negative int32 as a 10-byte varint and zigzags sint fields', () => {
    expect(hex(toBytes({ i32: -1 }))).toBe('08ffffffffffffffffff01');
    expect(hex(toBytes({ s32: -1 }))).toBe('2801');
    expect(hex(toBytes({ s64: '1' }))).toBe('3002');
  });

  it('keeps unknown enum numbers, accepts integers, and drops unknown names', () => {
    expect(toJson(toBytes({ color: 7 })).color).toBe(7);
    expect(toJson(toBytes({ color: 1 })).color).toBe('RED');
    expect(toJson(toBytes({ color: -1 })).color).toBe(-1);
    expect(toBytes({ color: 'PURPLE' }).length).toBe(0);
    expect(toJson(toBytes({ colors: ['RED', 'PURPLE', 9] })).colors).toEqual(['RED', 9]);
    expect(toBytes({ colors: ['PURPLE'] }).length).toBe(0);
    expectInvalid(() => toBytes({ color: 1.5 }), /integer/);
    expect(toBytes({ color: '1' }).length).toBe(0); // a string is a name, and '1' names nothing
  });

  it('writes canonical NaN for float and double, and range-checks float', () => {
    expect(hex(toBytes({ fl: 'NaN' }))).toBe('5d0000c07f');
    expect(hex(toBytes({ db: 'NaN' }))).toBe('61000000000000f87f');
    expect(toJson(toBytes({ fl: 'Infinity' })).fl).toBe('Infinity');
    expectInvalid(() => toBytes({ fl: 3.5e38 }), /float range/);
  });

  it.each([
    ['i32', 2147483648],
    ['u32', -1],
    ['u32', 4294967296],
    ['u64', '-1'],
    ['u64', '18446744073709551616'],
    ['f32', -1],
    ['sf64', '9223372036854775808'],
    ['s32', -2147483649],
  ])('refuses %s = %s as out of range', (name, value) => {
    expectInvalid(() => toBytes({ [name]: value }), /range/);
  });

  it('validates map keys against their key type', () => {
    expectInvalid(() => toBytes({ by_int: { x: 'a' } }), /bad map key/);
    expectInvalid(() => toBytes({ by_int: { '007': 'a' } }), /bad map key/);
    expectInvalid(() => toBytes({ by_int: { '-0': 'a' } }), /bad map key/);
    expectInvalid(() => toBytes({ by_int: { '+1': 'a' } }), /bad map key/);
    expectInvalid(() => toBytes({ by_int: { '2147483648': 'a' } }), /range/);
    expectInvalid(() => toBytes({ by_bool: { yes: '' } }), /bad map key/);
    expectInvalid(() => toBytes({ children: { a: 5 } }), /JSON object/);
  });

  it('writes both key and value of every map entry, defaults included', () => {
    expect(hex(toBytes({ by_int: { '0': '' } }))).toBe('8a010408001200');
    expect(hex(toBytes({ children: { '': {} } }))).toBe('9a01040a001200');
  });

  it('fills in a map entry missing its key or value', () => {
    // field 17 entry with only a value; field 19 entry with only a key
    const bytes = Buffer.from([0x8a, 0x01, 0x03, 0x12, 0x01, 0x61, 0x9a, 0x01, 0x03, 0x0a, 0x01, 0x6b]);
    expect(toJson(new Uint8Array(bytes))).toMatchObject({ by_int: { 0: 'a' }, children: { k: { name: '' } } });
  });

  it('merges a message field sent more than once', () => {
    const bytes = Buffer.from([0xaa, 0x01, 0x03, 0x0a, 0x01, 0x61, 0xaa, 0x01, 0x03, 0x0a, 0x01, 0x62]);
    expect(toJson(new Uint8Array(bytes)).child).toEqual({ name: 'b' });
  });

  it('skips groups as unknown fields, nested ones included', () => {
    // field 127 group holding a varint, a string and a nested group 1, then i32 = 3
    const bytes = [0xfb, 0x07, 0x08, 0x01, 0x12, 0x01, 0x61, 0x0b, 0x0c, 0xfc, 0x07, 0x08, 0x03];
    expect(toJson(new Uint8Array(bytes))).toMatchObject({ i32: 3 });
  });

  it('refuses nesting deeper than 100 levels, in unknown groups and in messages, without overflowing the stack', () => {
    const groups = (n: number) => new Uint8Array([...Array(n).fill(0x0b), ...Array(n).fill(0x0c)]);
    // the payload message is level 1, so 99 nested groups fit and 100 don't
    expect(toJson(groups(99))).toMatchObject({ i32: 0 });
    expectInvalid(() => toJson(groups(100)), /nested deeper than 100/);
    expectInvalid(() => toJson(new Uint8Array(200_000).fill(0x0b)), /nested deeper than 100/);
  });

  it('accepts the largest 10-byte varint', () => {
    const bytes = [0x20, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    expect(toJson(new Uint8Array(bytes)).u64).toBe('18446744073709551615');
  });

  it.each([
    ['a truncated varint', [0x08, 0x80]],
    ['a varint longer than 10 bytes', [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]],
    ['a truncated fixed64', [0x41, 0x00]],
    ['a truncated fixed32', [0x3d, 0x00]],
    ['a length past the end', [0xca, 0x01, 0x05, 0x61]],
    ['field number 0', [0x00, 0x00]],
    ['an unterminated group', [0x0b]],
    ['a stray end group', [0x0c]],
    ['a mismatched end group', [0x0b, 0x14]],
    ['a 10-byte varint past 64 bits', [0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]],
    ['a malformed packed run', [0x7a, 0x01, 0x80]],
  ])('refuses %s', (_label, bytes) => {
    expectInvalid(() => toJson(new Uint8Array(bytes)), /malformed/);
  });
});

describe('message nesting depth', () => {
  // a self-recursive payload: no MACP message is one, but the cap must hold if one appears
  beforeAll(() =>
    setSchemaForTesting({
      ...generated,
      messages: {
        ...generated.messages,
        'macp.v1.SignalPayload': [
          scalar('n', 1, 'int32'),
          { name: 'next', id: 2, type: 'macp.v1.SignalPayload', kind: 'message' },
        ],
      },
    }),
  );
  afterAll(() => setSchemaForTesting(undefined));

  const chain = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { n: levels };
    for (let i = levels - 1; i >= 1; i--) node = { n: i, next: node };
    return node;
  };

  it('accepts 100 levels and refuses 101, in JSON and on the wire', () => {
    const bytes = toBytes(chain(100));
    expect(toJson(bytes)).toMatchObject({ n: 1, next: { n: 2 } });
    expectInvalid(() => toBytes(chain(101)), /nested deeper than 100/);
    // 101 levels of bytes: wrap the 100-level encoding once more
    const deeper = new Uint8Array([0x12, ...varint(bytes.length), ...bytes]);
    expectInvalid(() => toJson(deeper), /nested deeper than 100/);
  });

  it('resets the depth after a refusal', () => {
    expect(() => toBytes(chain(101))).toThrow(CanonicalJsonError);
    expect(toJson(toBytes(chain(3)))).toMatchObject({ n: 1, next: { n: 2, next: { n: 3 } } });
  });
});

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
