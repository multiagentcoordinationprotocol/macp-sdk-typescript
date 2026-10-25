/**
 * Decision receipts (`src/receipt.ts`): the edges the spec vectors don't
 * reach. `tests/vectors/receipt.test.ts` replays the canonical vectors and
 * the Appendix A round-trip.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { MacpSdkError } from '../../src/errors';
import {
  RECEIPT_FORMAT,
  buildReceipt,
  commitmentFromProjection,
  verifyReceipt,
  type BuildReceiptOptions,
  type DecisionReceipt,
} from '../../src/receipt';
import type { CommitmentPayload } from '../../src/types';

const VECTORS = path.join(__dirname, '..', 'vectors', 'receipt');
const vector = (name: string): { receipt: DecisionReceipt; trusted_keys: Record<string, string> } =>
  JSON.parse(fs.readFileSync(path.join(VECTORS, `${name}.json`), 'utf8'));

const SEED = new Uint8Array(createHash('sha256').update('macp-receipt example key').digest());
const KID = 'example-1';
const PUBLIC_X = Buffer.from(ed25519.getPublicKey(SEED)).toString('base64url');
const TRUSTED = { [KID]: PUBLIC_X };

const COMMITMENT: CommitmentPayload = {
  commitmentId: 'c2',
  action: 'decision.approved',
  authorityScope: 'seam',
  reason: 'sealed by seam',
  modeVersion: 'macp.mode.decision.v1',
  policyVersion: '1.0.0',
  configurationVersion: '1.0.0',
  outcomePositive: true,
  supersedes: {
    sessionId: 'prior-sess',
    commitmentHash: 'sha256:9f58e9d114d11860d48aa2bcb8cda458b9618b1cc8560595a802b68c4af85d41',
  },
};

const BASE: BuildReceiptOptions = {
  sessionId: '0192f1a4-7c3e-7b2a-9f10-5d2c8e4b6a01',
  mode: 'macp.mode.decision.v1',
  issuer: 'runtime:example',
  issuedAt: '2026-10-24T12:00:00Z',
  semanticsRev: { implementation: 'macp-runtime', rev: 4 },
};

const signed = (): DecisionReceipt => buildReceipt(COMMITMENT, { ...BASE, signer: { kid: KID, privateKey: SEED } });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const b64url = (s: string): string => Buffer.from(s).toString('base64url');

/** Re-sign an arbitrary (already-tampered) receipt object with the example key. */
function resign(receipt: Record<string, unknown>, header = `{"alg":"EdDSA","kid":"${KID}"}`): string {
  const { attestations: _a, ...body } = receipt;
  const canon = (v: unknown): string =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : Array.isArray(v)
        ? `[${v.map(canon).join(',')}]`
        : JSON.stringify(v);
  const hdr = b64url(header);
  const sig = ed25519.sign(new TextEncoder().encode(`${hdr}.${b64url(canon(body))}`), SEED);
  return `${hdr}..${Buffer.from(sig).toString('base64url')}`;
}

describe('buildReceipt', () => {
  it('emits no attestations without a signer', () => {
    const r = buildReceipt(COMMITMENT, BASE);
    expect(r.receipt_format).toBe(RECEIPT_FORMAT);
    expect(r.attestations).toEqual([]);
    expect(verifyReceipt(r, TRUSTED)).toEqual({ integrity: 'match', attestations: [], verdict: 'integrity_only' });
  });

  it('reproduces the transcript vector (two JCS integers in the body), key order included', () => {
    const v = vector('receipt_002_integrity_only');
    const t = v.receipt.transcript!;
    const r = buildReceipt(COMMITMENT, {
      ...BASE,
      transcript: { digestAlg: t.digest_alg, digest: t.digest, messageCount: t.message_count },
    });
    expect(JSON.stringify(r)).toBe(JSON.stringify(v.receipt));
  });

  it('reproduces the signed wire vector from the payload bytes, key order included', () => {
    const v = vector('receipt_010_wire_match');
    const wire = new Uint8Array(Buffer.from(v.receipt.commitment_wire_b64!, 'base64'));
    const r = buildReceipt(COMMITMENT, { ...BASE, commitmentWire: wire, signer: { kid: KID, privateKey: SEED } });
    expect(JSON.stringify(r)).toBe(JSON.stringify(v.receipt));
  });

  it('omits message_count when the transcript has none', () => {
    const r = buildReceipt(COMMITMENT, { ...BASE, transcript: { digestAlg: 'a', digest: 'd' } });
    expect(r.transcript).toEqual({ digest_alg: 'a', digest: 'd' });
  });

  it('materializes proto3 defaults and leaves supersedes out when absent', () => {
    const r = buildReceipt({ commitmentId: 'x' } as CommitmentPayload, BASE);
    expect(r.commitment).toEqual({
      commitment_id: 'x',
      action: '',
      authority_scope: '',
      reason: '',
      mode_version: '',
      policy_version: '',
      configuration_version: '',
      outcome_positive: false,
    });
    expect(verifyReceipt(r, TRUSTED).integrity).toBe('match');
  });

  it('is deterministic', () => {
    expect(signed()).toEqual(signed());
  });

  it.each<[string, Partial<BuildReceiptOptions> | Record<string, unknown>]>([
    ['empty sessionId', { sessionId: '' }],
    ['empty mode', { mode: '' }],
    ['empty issuer', { issuer: '' }],
    ['non-string issuedAt', { issuedAt: 5 }],
    ['negative rev', { semanticsRev: { implementation: 'x', rev: -1 } }],
    ['fractional rev', { semanticsRev: { implementation: 'x', rev: 1.5 } }],
    ['empty implementation', { semanticsRev: { implementation: '', rev: 1 } }],
    ['empty digest', { transcript: { digestAlg: 'a', digest: '' } }],
    ['unsafe messageCount', { transcript: { digestAlg: 'a', digest: 'd', messageCount: 2 ** 53 } }],
    ['wire of another commitment', { commitmentWire: new Uint8Array([0x0a, 0x01, 0x78]) }],
    ['non-wire commitmentWire', { commitmentWire: 'CgJjMg==' }],
    ['empty kid', { signer: { kid: '', privateKey: SEED } }],
    ['short seed', { signer: { kid: KID, privateKey: SEED.slice(0, 31) } }],
    ['short signature from a callback', { signer: { kid: KID, sign: () => new Uint8Array(63) } }],
  ])('throws MacpSdkError on %s', (_label, override) => {
    expect(() => buildReceipt(COMMITMENT, { ...BASE, ...override } as BuildReceiptOptions)).toThrow(MacpSdkError);
  });
});

describe('verifyReceipt: step 1 (format)', () => {
  it.each([null, undefined, 'macp-receipt/1', [], 42])('refuses a non-object (%s)', (input) => {
    expect(verifyReceipt(input, TRUSTED)).toEqual({ integrity: null, attestations: [], verdict: 'refused' });
  });

  it('refuses a missing receipt_format', () => {
    const { receipt_format: _f, ...rest } = signed();
    expect(verifyReceipt(rest, TRUSTED).verdict).toBe('refused');
  });
});

describe('verifyReceipt: step 2 (integrity)', () => {
  const withCommitment = (mutate: (c: Record<string, unknown>) => void): Record<string, unknown> => {
    const r = clone(signed()) as unknown as Record<string, unknown>;
    mutate(r.commitment as Record<string, unknown>);
    return r;
  };

  it.each<[string, (c: Record<string, unknown>) => void]>([
    ['an unknown member', (c) => (c.extra = 'x')],
    ['a missing member', (c) => delete c.reason],
    ['a wrongly typed string', (c) => (c.action = 1)],
    ['a non-boolean outcome_positive', (c) => (c.outcome_positive = 'true')],
    ['a non-object supersedes', (c) => (c.supersedes = 'prior')],
    ['an unknown supersedes member', (c) => ((c.supersedes as Record<string, unknown>).extra = 'x')],
    ['a non-string supersedes member', (c) => ((c.supersedes as Record<string, unknown>).session_id = 1)],
  ])('cannot_verify on %s, with no attestations checked', (_label, mutate) => {
    expect(verifyReceipt(withCommitment(mutate), TRUSTED)).toEqual({
      integrity: 'cannot_verify',
      attestations: [],
      verdict: 'unverified',
    });
  });

  it('cannot_verify on a non-object commitment', () => {
    expect(verifyReceipt({ ...signed(), commitment: [] }, TRUSTED).integrity).toBe('cannot_verify');
  });

  it('mismatch on a non-string commitment_hash', () => {
    expect(verifyReceipt({ ...signed(), commitment_hash: 7 }, TRUSTED).integrity).toBe('mismatch');
  });

  const wire = vector('receipt_010_wire_match').receipt.commitment_wire_b64!;

  it.each([
    ['unpadded base64', wire.replace(/=+$/, '') + 'A'],
    ['base64url digits', `-${wire.slice(1)}`],
    ['embedded whitespace', `${wire.slice(0, 8)} ${wire.slice(8)}`],
    ['a non-string', 12],
  ])('cannot_verify on commitment_wire_b64 with %s', (_label, value) => {
    expect(verifyReceipt({ ...signed(), commitment_wire_b64: value }, TRUSTED).integrity).toBe('cannot_verify');
  });

  it('mismatch on an empty wire (it projects to an all-default Commitment)', () => {
    expect(verifyReceipt({ ...signed(), commitment_wire_b64: '' }, TRUSTED).integrity).toBe('mismatch');
  });

  it('cannot_verify on a wire that is not a valid Commitment encoding (truncated)', () => {
    expect(verifyReceipt({ ...signed(), commitment_wire_b64: 'CgJj' }, TRUSTED).integrity).toBe('cannot_verify');
  });
});

describe('verifyReceipt: step 3 (attestations)', () => {
  const withJws = (jws: unknown): Record<string, unknown> => ({ ...signed(), attestations: [{ type: 'jws', jws }] });
  const outcome = (r: unknown, keys: Record<string, string> = TRUSTED): string[] => verifyReceipt(r, keys).attestations;
  const sig = signed().attestations[0]!.type === 'jws' ? (signed().attestations[0] as { jws: string }).jws : '';
  const [hdr, , s] = sig.split('.');

  it('treats a missing attestations array as empty', () => {
    const { attestations: _a, ...rest } = signed();
    expect(verifyReceipt(rest, TRUSTED)).toEqual({ integrity: 'match', attestations: [], verdict: 'integrity_only' });
  });

  it.each<[string, unknown]>([
    ['a non-string jws', 42],
    ['two segments', `${hdr}.${s}`],
    ['an attached payload', `${hdr}.eyJ9.${s}`],
    ['an empty header', `.${''}.${s}`],
    ['a padded signature', `${hdr}..${s}=`],
    ['a header that is not JSON', `${b64url('not json')}..${s}`],
    ['a header that is not UTF-8', `${Buffer.from([0xff, 0xfe]).toString('base64url')}..${s}`],
    ['a truncated signature', `${hdr}..${s!.slice(0, 40)}`],
  ])('invalid on %s', (_label, jws) => {
    expect(outcome(withJws(jws))).toEqual(['invalid']);
  });

  it.each([
    ['another alg', `{"alg":"ES256","kid":"${KID}"}`],
    ['no alg', `{"kid":"${KID}"}`],
    ['a non-object header', '["EdDSA"]'],
  ])('unsupported on %s', (_label, header) => {
    expect(outcome(withJws(`${b64url(header)}..${s}`))).toEqual(['unsupported']);
  });

  it.each([
    ['no kid', '{"alg":"EdDSA"}'],
    ['a non-string kid', '{"alg":"EdDSA","kid":1}'],
    ['an inherited property name as kid', '{"alg":"EdDSA","kid":"__proto__"}'],
    ['an untrusted kid', '{"alg":"EdDSA","kid":"other"}'],
  ])('unknown_key on %s', (_label, header) => {
    expect(outcome(withJws(`${b64url(header)}..${s}`))).toEqual(['unknown_key']);
  });

  it('checks alg before kid', () => {
    expect(outcome(withJws(`${b64url('{"alg":"RS256","kid":"other"}')}..${s}`))).toEqual(['unsupported']);
  });

  it.each([
    ['not base64url', '***'],
    ['the wrong length', Buffer.alloc(31).toString('base64url')],
    ['not a curve point', Buffer.alloc(32, 0xff).toString('base64url')],
  ])('invalid when the trusted key is %s', (_label, key) => {
    expect(outcome(signed(), { [KID]: key })).toEqual(['invalid']);
  });

  it('unknown_key for every jws when trustedKeys is not an object', () => {
    expect(outcome(signed(), null as unknown as Record<string, string>)).toEqual(['unknown_key']);
  });

  it.each([null, 'jws', { type: 'jwt', jws: sig }, { type: 'vendor', format: 'x', binds: 'receipt', value: 'v' }])(
    'unsupported for a non-jws attestation (%j)',
    (att) => {
      expect(verifyReceipt({ ...signed(), attestations: [att] }, TRUSTED)).toEqual({
        integrity: 'match',
        attestations: ['unsupported'],
        verdict: 'integrity_only',
      });
    },
  );

  it('signs every member except attestations, including unknown extension members', () => {
    const r = clone(signed()) as unknown as Record<string, unknown>;
    r.x_extension = { list: [null, true, false, 1.5, 'é'], nested: { b: 1, a: 2 } };
    expect(outcome(r)).toEqual(['invalid']);
    (r.attestations as { jws: string }[])[0]!.jws = resign(r);
    expect(outcome(r)).toEqual(['valid']);
  });

  it('a body with no JCS form makes every jws invalid and leaves vendor unsupported', () => {
    const r = {
      ...signed(),
      bad: Number.NaN,
      attestations: [...signed().attestations, { type: 'vendor', format: 'x', binds: 'receipt', value: 'v' }],
    };
    expect(verifyReceipt(r, TRUSTED)).toEqual({
      integrity: 'match',
      attestations: ['invalid', 'unsupported'],
      verdict: 'integrity_only',
    });
    expect(outcome({ ...signed(), bad: 1n })).toEqual(['invalid']);
  });

  it('a signature under a different key is invalid even with the right kid', () => {
    const other = new Uint8Array(32).fill(7);
    const r = buildReceipt(COMMITMENT, { ...BASE, signer: { kid: KID, privateKey: other } });
    expect(outcome(r)).toEqual(['invalid']);
    expect(outcome(r, { [KID]: Buffer.from(ed25519.getPublicKey(other)).toString('base64url') })).toEqual(['valid']);
  });
});

describe('commitmentFromProjection', () => {
  it('inverts the receipt projection, so build(fromProjection(c)) reproduces the receipt', () => {
    const r = signed();
    const payload = commitmentFromProjection(r.commitment);
    expect(payload).toEqual(COMMITMENT);
    expect(buildReceipt(payload, { ...BASE, signer: { kid: KID, privateKey: SEED } })).toEqual(r);
  });

  it('keeps supersedes absent when the projection has none', () => {
    const { supersedes: _s, ...rest } = signed().commitment;
    expect(commitmentFromProjection(rest).supersedes).toBeUndefined();
  });

  it('throws MacpSdkError on an incomplete projection', () => {
    const { reason: _r, ...rest } = signed().commitment;
    expect(() => commitmentFromProjection(rest as never)).toThrow(MacpSdkError);
  });
});
