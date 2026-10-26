import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { trustedKeysFromJwks, verifyReceipt } from '../../src/receipt';

// RFC-MACP-0013 §13 item 8: a runtime's GetReceiptKeys JWK Set → the kid → x
// map verifyReceipt takes. Test names are shared with macp-sdk-python
// (`test_<name>`), so the two SDKs' suites line up one to one.

const fixtures = path.join(__dirname, '..', 'fixtures');
const vectors = path.join(__dirname, '..', 'vectors', 'receipt');
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf-8'));

// The A.5 example key (kid example-1), as in tests/fixtures/receipt_keys.json.
const X = 'TDVzkxaSf6_Oxu7mmn5TbCkF80s8Ulh33qKQsi0gnZM';
const okp = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kty: 'OKP',
  crv: 'Ed25519',
  kid: 'k1',
  x: X,
  ...overrides,
});

describe('trustedKeysFromJwks', () => {
  it('trusted_keys_from_jwks_example_key_set', () => {
    // The spec's examples/discovery/receipt_keys.json, vendored byte-identical.
    const keys = trustedKeysFromJwks(readJson(path.join(fixtures, 'receipt_keys.json')));
    const vector = readJson(path.join(vectors, 'receipt_010_wire_match.json')) as {
      receipt: unknown;
      trusted_keys: Record<string, string>;
    };

    expect(keys).toEqual(vector.trusted_keys);
    expect(keys).toEqual({ 'example-1': X });
    // The reference runtime-issued receipt shape (§13) verifies against the key set.
    expect(verifyReceipt(vector.receipt, keys).verdict).toBe('attested');
  });

  it('trusted_keys_from_jwks_skips_unusable_keys', () => {
    const unusable: Array<[string, Record<string, unknown>]> = [
      ['kty EC', okp({ kty: 'EC' })],
      ['kty missing', okp({ kty: undefined })],
      ['crv X25519', okp({ crv: 'X25519' })],
      ['crv missing', okp({ crv: undefined })],
      ['kid missing', okp({ kid: undefined })],
      ['kid empty', okp({ kid: '' })],
      ['kid not a string', okp({ kid: 7 })],
      ['x missing', okp({ x: undefined })],
      ['x empty', okp({ x: '' })],
      ['x not a string', okp({ x: ['TDVz'] })],
      ['alg ES256', okp({ alg: 'ES256' })],
      ['use enc', okp({ use: 'enc' })],
      ...(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const).map((m): [string, Record<string, unknown>] => [
        `private member ${m}`,
        okp({ [m]: 'secret' }),
      ]),
    ];
    for (const [label, key] of unusable) {
      // Each unusable key sits beside a usable one, which must survive: the
      // rule drops that key alone, not the set.
      const keys = trustedKeysFromJwks({ keys: [key, okp({ kid: 'good' })] });
      expect(keys, label).toEqual({ good: X });
    }
    // alg EdDSA and use sig are the explicit forms of the defaults; both are kept.
    expect(trustedKeysFromJwks({ keys: [okp({ alg: 'EdDSA', use: 'sig' })] })).toEqual({ k1: X });
  });

  it('trusted_keys_from_jwks_drops_duplicate_kid', () => {
    const other = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    // Two usable keys claim k1: neither is trusted; k2 is unaffected.
    expect(trustedKeysFromJwks({ keys: [okp(), okp({ x: other }), okp({ kid: 'k2' })] })).toEqual({ k2: X });
    // The same key listed twice is still ambiguous under item 8.
    expect(trustedKeysFromJwks({ keys: [okp(), okp()] })).toEqual({});
  });

  it('trusted_keys_from_jwks_duplicate_of_an_unusable_key_still_drops_the_kid', () => {
    // Item 8 makes kid unique across the whole set: a second entry under the
    // same kid makes it ambiguous even when that entry is a key we can't use.
    const ec = { kty: 'EC', crv: 'P-256', kid: 'dup', x: 'AA', y: 'BB' };
    expect(trustedKeysFromJwks({ keys: [okp({ kid: 'dup' }), ec, okp({ kid: 'k2' })] })).toEqual({ k2: X });
    expect(trustedKeysFromJwks({ keys: [okp({ kid: 'dup' }), okp({ kid: 'dup', d: 'secret' })] })).toEqual({});
    // An entry with no string kid claims nothing.
    expect(trustedKeysFromJwks({ keys: [okp(), { kty: 'EC', kid: 7 }, { kty: 'OKP' }] })).toEqual({ k1: X });
  });

  it('trusted_keys_from_jwks_malformed_input_is_empty', () => {
    for (const input of [null, undefined, 'keys', 42, [], {}, { keys: 'x' }, { keys: {} }, { keys: null }]) {
      expect(trustedKeysFromJwks(input), JSON.stringify(input)).toEqual({});
    }
    // An unsigned runtime publishes {"keys": []} (§13 item 8).
    expect(trustedKeysFromJwks({ keys: [] })).toEqual({});
    // Non-object entries are skipped, not fatal.
    expect(trustedKeysFromJwks({ keys: [null, 'k', 3, [okp()], okp()] })).toEqual({ k1: X });
  });

  it('keeps __proto__, constructor and toString kids as own keys without touching the prototype', () => {
    const keys = trustedKeysFromJwks({
      keys: [okp({ kid: '__proto__' }), okp({ kid: 'constructor' }), okp({ kid: 'toString' })],
    });

    expect(Object.getPrototypeOf(keys)).toBe(Object.prototype);
    expect(Object.keys(keys)).toEqual(['__proto__', 'constructor', 'toString']);
    for (const kid of ['__proto__', 'constructor', 'toString']) {
      expect(Object.prototype.hasOwnProperty.call(keys, kid), kid).toBe(true);
      expect(Object.getOwnPropertyDescriptor(keys, kid)?.value, kid).toBe(X);
    }
    // An inherited name is never trusted by accident: no own key, no entry.
    expect(Object.prototype.hasOwnProperty.call(trustedKeysFromJwks({ keys: [] }), 'constructor')).toBe(false);
  });
});
