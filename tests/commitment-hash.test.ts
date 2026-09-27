import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import protobuf from 'protobufjs';
import { commitmentHash, canonicalizeCommitmentPayload, isCanonicalCommitmentHash } from '../src/commitment-hash';
import { ProtoRegistry } from '../src/proto-registry';
import type { CommitmentPayload } from '../src/types';

const HASH_SHAPE = /^sha256:[0-9a-f]{64}$/;

// Hand-built (not derived by calling the module) expected JCS output for
// `basePayload()` — these are the ground truth for G1/G3 (full-string pin of
// member order) and G2 (LABEL pin). Field values below must track
// `basePayload()`. Alphabetical member order per RFC 8785 §3.2.3:
// action, authority_scope, commitment_id, configuration_version,
// mode_version, outcome_positive, policy_version, reason, then supersedes
// last (commitment_hash before session_id inside it).
const EXPECTED_JCS_WITHOUT_SUPERSEDES =
  '{"action":"approve","authority_scope":"scope:root","commitment_id":"commit-1","configuration_version":"cfg-1","mode_version":"v1","outcome_positive":false,"policy_version":"","reason":"because"}';
const EXPECTED_JCS_WITH_SUPERSEDES =
  '{"action":"approve","authority_scope":"scope:root","commitment_id":"commit-1","configuration_version":"cfg-1","mode_version":"v1","outcome_positive":false,"policy_version":"","reason":"because","supersedes":{"commitment_hash":"h1","session_id":"s1"}}';

function basePayload(): CommitmentPayload {
  return {
    commitmentId: 'commit-1',
    action: 'approve',
    authorityScope: 'scope:root',
    reason: 'because',
    modeVersion: 'v1',
    configurationVersion: 'cfg-1',
  };
}

describe('commitmentHash', () => {
  it('hashes a minimal valid payload to a stable sha256: shape', () => {
    const hash = commitmentHash(basePayload());
    expect(hash).toMatch(HASH_SHAPE);
  });

  it('is deterministic for equal input', () => {
    const a = commitmentHash(basePayload());
    const b = commitmentHash(basePayload());
    expect(a).toBe(b);
  });

  it('hashes differently when supersedes is present vs absent', () => {
    const withoutSupersedes = commitmentHash(basePayload());
    const withSupersedes = commitmentHash({
      ...basePayload(),
      supersedes: { sessionId: 's1', commitmentHash: 'sha256:' + '0'.repeat(64) },
    });
    expect(withSupersedes).not.toBe(withoutSupersedes);
  });

  it('D2.3: an empty-string supersedes is not collapsed into omission', () => {
    const omitted = commitmentHash(basePayload());
    const emptySupersedes = commitmentHash({
      ...basePayload(),
      supersedes: { sessionId: '', commitmentHash: '' },
    });
    expect(emptySupersedes).not.toBe(omitted);
  });

  // Issue #105: `supersedes: null` must hash identically to `supersedes`
  // being absent/undefined — both are "no supersession" on the wire (proto3
  // message-typed fields have only present/absent states; `null` is the
  // idiomatic in-language representation of "absent"). Before the fix,
  // `supersedes: null` took the *present* branch and hashed the same as an
  // explicit `{ sessionId: '', commitmentHash: '' }`, diverging from
  // `macp-sdk-python`'s `HasField`-based projection for the same logical
  // commitment.
  it('issue #105: hashes supersedes: null identically to supersedes omitted entirely', () => {
    const base = basePayload();
    const withNull = commitmentHash({ ...base, supersedes: null as unknown as CommitmentPayload['supersedes'] });
    const withoutKey = commitmentHash(base);
    expect(withNull).toBe(withoutKey);
  });

  it('issue #105: a null supersedes still differs from an explicit empty CommitmentRef', () => {
    const withNull = commitmentHash({
      ...basePayload(),
      supersedes: null as unknown as CommitmentPayload['supersedes'],
    });
    const emptySupersedes = commitmentHash({
      ...basePayload(),
      supersedes: { sessionId: '', commitmentHash: '' },
    });
    expect(withNull).not.toBe(emptySupersedes);
  });

  it.each([0, '', false, 5, 'x', true, []])(
    'issue #105 non-vacuity guard: supersedes = %j is falsy-but-not-nullish, and still takes the present branch',
    (value) => {
      const payload = {
        ...basePayload(),
        supersedes: value as unknown as CommitmentPayload['supersedes'],
      };
      // Must contain the object-form key, not just the substring "supersedes"
      // (which `!= null` guarantees anyway, but pins the shape too) — this is
      // exactly what would start failing if the predicate were ever
      // "simplified" to a truthiness check (`if (p.supersedes)`).
      expect(canonicalizeCommitmentPayload(payload)).toContain('"supersedes":{');
      expect(() => commitmentHash(payload)).not.toThrow();
      expect(commitmentHash(payload)).toMatch(HASH_SHAPE);
    },
  );

  it('D2.2: omitting outcomePositive/policyVersion hashes the same as explicit false/"" on a bare object literal', () => {
    const bare = {
      commitmentId: 'c',
      action: 'a',
      authorityScope: 'x',
      reason: 'r',
      modeVersion: 'v',
      configurationVersion: 'v',
    } as CommitmentPayload;
    const explicit: CommitmentPayload = {
      ...bare,
      outcomePositive: false,
      policyVersion: '',
    };
    expect(commitmentHash(bare)).toBe(commitmentHash(explicit));
  });

  it('hashes differently for outcomePositive true vs false', () => {
    const t = commitmentHash({ ...basePayload(), outcomePositive: true });
    const f = commitmentHash({ ...basePayload(), outcomePositive: false });
    expect(t).not.toBe(f);
  });

  it('hashes differently for empty vs non-empty policyVersion', () => {
    const empty = commitmentHash({ ...basePayload(), policyVersion: '' });
    const nonEmpty = commitmentHash({ ...basePayload(), policyVersion: 'pol-1' });
    expect(empty).not.toBe(nonEmpty);
  });

  it('G2: pins the domain-separation LABEL literal end-to-end via an independently computed digest', () => {
    // Ground truth computed here with node:crypto directly, using the
    // literal LABEL string ('macp-commitment-hash/1') and the hand-built
    // expected JCS string above — neither is read from the module under
    // test. A typo in the module's LABEL constant would change its output
    // hash but not this independently computed expectation, so this test
    // would fail.
    const expectedPreimage = 'macp-commitment-hash/1:' + EXPECTED_JCS_WITHOUT_SUPERSEDES;
    const expectedDigest = createHash('sha256').update(Buffer.from(expectedPreimage, 'utf8')).digest('hex');
    expect(commitmentHash(basePayload())).toBe(`sha256:${expectedDigest}`);
  });

  describe('D3: never throws', () => {
    it('on a payload missing all required fields', () => {
      const incomplete = {} as CommitmentPayload;
      expect(() => commitmentHash(incomplete)).not.toThrow();
      expect(commitmentHash(incomplete)).toMatch(HASH_SHAPE);
    });

    it('when the payload itself is null or undefined', () => {
      expect(() => commitmentHash(null as unknown as CommitmentPayload)).not.toThrow();
      expect(() => commitmentHash(undefined as unknown as CommitmentPayload)).not.toThrow();
    });

    it('on a payload with wrong-typed fields', () => {
      const weird = {
        commitmentId: 123,
        action: null,
        authorityScope: undefined,
        reason: {},
        modeVersion: ['v1'],
        configurationVersion: true,
        outcomePositive: 'yes',
        policyVersion: 42,
        supersedes: { sessionId: 7, commitmentHash: null },
      } as unknown as CommitmentPayload;
      expect(() => commitmentHash(weird)).not.toThrow();
      expect(commitmentHash(weird)).toMatch(HASH_SHAPE);
    });

    it('when supersedes is present but not an object', () => {
      const weird = { ...basePayload(), supersedes: 'oops' } as unknown as CommitmentPayload;
      expect(() => commitmentHash(weird)).not.toThrow();
    });
  });
});

describe('canonicalizeCommitmentPayload (JCS output)', () => {
  it('orders supersedes members commitment_hash before session_id, and supersedes after all other top-level members', () => {
    const jcs = canonicalizeCommitmentPayload({
      ...basePayload(),
      supersedes: { sessionId: 's1', commitmentHash: 'h1' },
    });

    const commitmentHashIdx = jcs.indexOf('"commitment_hash"');
    const sessionIdIdx = jcs.indexOf('"session_id"');
    expect(commitmentHashIdx).toBeGreaterThan(-1);
    expect(sessionIdIdx).toBeGreaterThan(commitmentHashIdx);

    const supersedesIdx = jcs.indexOf('"supersedes"');
    const otherKeys = [
      '"action"',
      '"authority_scope"',
      '"commitment_id"',
      '"configuration_version"',
      '"mode_version"',
      '"outcome_positive"',
      '"policy_version"',
      '"reason"',
    ];
    for (const key of otherKeys) {
      expect(supersedesIdx).toBeGreaterThan(jcs.indexOf(key));
    }
  });

  it('omits the supersedes key entirely when undefined', () => {
    const jcs = canonicalizeCommitmentPayload(basePayload());
    expect(jcs).not.toContain('supersedes');
  });

  it('issue #105: omits the supersedes key entirely when null, same as undefined', () => {
    const jcs = canonicalizeCommitmentPayload({
      ...basePayload(),
      supersedes: null as unknown as CommitmentPayload['supersedes'],
    });
    expect(jcs).not.toContain('supersedes');
  });

  it('G1/G3: produces the exact expected JCS string when supersedes is absent (relative member order pinned, not just each-vs-supersedes)', () => {
    const jcs = canonicalizeCommitmentPayload(basePayload());
    expect(jcs).toBe(EXPECTED_JCS_WITHOUT_SUPERSEDES);
    // Exactly 8 keys, no supersedes key at all.
    expect(jcs.match(/"[a-z_]+":/g)).toHaveLength(8);
  });

  it('G1/G3: produces the exact expected JCS string when supersedes is present (relative member order pinned, not just each-vs-supersedes)', () => {
    const jcs = canonicalizeCommitmentPayload({
      ...basePayload(),
      supersedes: { sessionId: 's1', commitmentHash: 'h1' },
    });
    expect(jcs).toBe(EXPECTED_JCS_WITH_SUPERSEDES);
  });

  describe('string escaping (RFC 8785 §3.2.2.2)', () => {
    it('escapes an embedded double quote', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a"b' });
      expect(jcs).toContain('"reason":"a\\"b"');
    });

    it('escapes an embedded backslash', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a\\b' });
      expect(jcs).toContain('"reason":"a\\\\b"');
    });

    it('escapes a tab as \\t', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a\tb' });
      expect(jcs).toContain('"reason":"a\\tb"');
    });

    it('escapes a newline as \\n', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a\nb' });
      expect(jcs).toContain('"reason":"a\\nb"');
    });

    it('escapes a formfeed as \\f', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a\fb' });
      expect(jcs).toContain('"reason":"a\\fb"');
    });

    it('escapes a carriage return as \\r', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a\rb' });
      expect(jcs).toContain('"reason":"a\\rb"');
    });

    it('escapes a backspace as \\b', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a\bb' });
      expect(jcs).toContain('"reason":"a\\bb"');
    });

    it('escapes a C0 control character with no short form as \\u00xx', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'a\x00b' });
      expect(jcs).toContain('"reason":"a\\u0000b"');
    });

    it('emits non-ASCII characters literally, not escaped', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'café' });
      expect(jcs).toContain('"reason":"café"');
      expect(jcs).not.toContain('\\u00e9');
    });

    it('emits an astral-plane codepoint literally as its full character, not a broken surrogate', () => {
      const jcs = canonicalizeCommitmentPayload({ ...basePayload(), reason: 'x\u{1F702}y' });
      expect(jcs).toContain('"reason":"x\u{1F702}y"');
      // A mis-handled surrogate pair would either drop a half (producing a
      // lone surrogate, which JSON.stringify would escape as \udXXX) or
      // truncate the string entirely — neither of those matches this exact
      // substring, so this assertion is precise enough on its own.
    });

    it('R1: a lone surrogate hashes identically to a literal U+FFFD (documented Buffer utf8 lossy substitution)', () => {
      // Pins the documented behavior at src/commitment-hash.ts:30-47: a lone
      // surrogate is out-of-contract input, is emitted literally/unescaped
      // by jcsString, and is only later collapsed to U+FFFD by
      // `Buffer.from(preimage, 'utf8')` inside `commitmentHash`. This test
      // goes through `commitmentHash` (not just `canonicalizeCommitmentPayload`)
      // because the two JCS strings differ at the JS-string level (`\uD800`
      // vs `�`) and only collide after UTF-8 byte encoding.
      const loneSurrogate = commitmentHash({ ...basePayload(), reason: '\uD800' });
      const literalReplacementChar = commitmentHash({ ...basePayload(), reason: '�' });
      expect(loneSurrogate).toBe(literalReplacementChar);
    });
  });
});

// Issue #105: pins the two real decode paths through this SDK, rather than
// only the hand-constructed `supersedes: null` used above.
describe('issue #105: the real in-SDK decode paths for an absent supersedes', () => {
  const registry = new ProtoRegistry();

  // `ProtoRegistry.decodeMessage` (private) always decodes with
  // `defaults: false` (proto-registry.ts:104) — this builds an independent
  // `protobuf.Root` over the same proto files so the test can decode the
  // identical wire bytes with `defaults: true` as well, without reaching
  // into ProtoRegistry's private `lookupType`.
  function loadCommitmentPayloadType(): protobuf.Type {
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => (path.isAbsolute(target) ? target : path.join(registry.protoDir, target));
    root.loadSync(path.join(registry.protoDir, 'macp/v1/core.proto'));
    root.resolveAll();
    return root.lookupType('macp.v1.CommitmentPayload');
  }

  it("this SDK's actual decode path (defaults: false) never produces supersedes: null — it stays undefined, so this path was never affected by issue #105", () => {
    const bytes = registry.encodeKnownPayload('', 'Commitment', basePayload() as unknown as Record<string, unknown>);
    const decoded = registry.decodeKnownPayload('', 'Commitment', bytes) as CommitmentPayload;
    expect(decoded.supersedes).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(decoded, 'supersedes')).toBe(false);
  });

  it('the affected path: decoding the same wire bytes with defaults: true produces a genuine supersedes: null, and it now hashes the same as absent', () => {
    const type = loadCommitmentPayloadType();
    const bytes = registry.encodeKnownPayload('', 'Commitment', basePayload() as unknown as Record<string, unknown>);
    const decodedWithDefaults = type.toObject(type.decode(bytes), { defaults: true }) as CommitmentPayload;

    // Confirms this test actually exercises the case under test, rather than
    // vacuously passing because protobufjs didn't materialize the default.
    expect(decodedWithDefaults.supersedes).toBeNull();

    expect(commitmentHash(decodedWithDefaults)).toBe(commitmentHash(basePayload()));
  });
});

// plans/sdk-parity-typescript.md Phase 2: non-throwing counterpart to
// src/validation.ts's throwing `validateCommitmentHash`. These are this
// phase's own hand-picked unit cases — distinct from the manifest-vector
// set `tests/parity/contract.test.ts` (Phase 5) runs this same predicate
// against, by design (see that phase's own note on not duplicating vectors).
describe('isCanonicalCommitmentHash', () => {
  it('accepts a well-formed sha256: hash', () => {
    expect(isCanonicalCommitmentHash(commitmentHash(basePayload()))).toBe(true);
    expect(isCanonicalCommitmentHash('sha256:' + '0'.repeat(64))).toBe(true);
  });

  it('rejects a trailing newline (the reason Python uses fullmatch)', () => {
    expect(isCanonicalCommitmentHash('sha256:' + '0'.repeat(64) + '\n')).toBe(false);
  });

  it('rejects uppercase hex digits', () => {
    expect(isCanonicalCommitmentHash('sha256:' + 'A'.repeat(64))).toBe(false);
  });

  it('rejects a 63-character digest (one short)', () => {
    expect(isCanonicalCommitmentHash('sha256:' + '0'.repeat(63))).toBe(false);
  });

  it('rejects a 65-character digest (one too many)', () => {
    expect(isCanonicalCommitmentHash('sha256:' + '0'.repeat(65))).toBe(false);
  });

  it('rejects a missing sha256: prefix', () => {
    expect(isCanonicalCommitmentHash('0'.repeat(64))).toBe(false);
  });

  it('rejects a wrong prefix (e.g. sha512:)', () => {
    expect(isCanonicalCommitmentHash('sha512:' + '0'.repeat(64))).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isCanonicalCommitmentHash('')).toBe(false);
  });

  it('never throws, for any input tried, including non-hash garbage', () => {
    for (const input of ['', 'not a hash', 'sha256:', '   ', '\0', 'sha256:' + 'g'.repeat(64)]) {
      expect(() => isCanonicalCommitmentHash(input)).not.toThrow();
    }
  });
});
