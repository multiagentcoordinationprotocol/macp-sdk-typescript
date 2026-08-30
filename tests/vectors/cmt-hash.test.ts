/**
 * RFC-MACP-0013 canonical commitment hash — spec vector runner.
 *
 * Unlike `tests/commitment-hash.test.ts` (Phase 1, internal
 * self-consistency only), this suite replays the RFC's own canonical vectors
 * — copied byte-for-byte from the spec repo's
 * `schemas/conformance/cmt-hash/` (source commit `646c3dd`) — against this
 * SDK's `commitmentHash()` / `canonicalizeCommitmentPayload()`. That is an
 * independent source of truth: if this SDK's implementation diverges from
 * the RFC, this suite fails even though Phase 1's tests would still pass.
 *
 * Deliberately outside the `verify-fixtures` drift gate (which only globs
 * `tests/conformance/*.json`, flat and non-recursive) — see Phase 3 of the
 * plan for the (Fable-reviewed, already-decided) rationale: a small,
 * append-only vector pack doesn't yet justify extending that gate across
 * three repos. `vitest.config.ts`'s `include` glob (tests, recursively, any
 * "*.test.ts" file) already collects this file with zero config changes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { commitmentHash, canonicalizeCommitmentPayload } from '../../src/commitment-hash';
import type { CommitmentPayload } from '../../src/types';

// Domain-separation label (RFC-MACP-0013 §4/§5/§7). Not exported by
// `src/commitment-hash.ts`, so it is hardcoded here — deliberately, per the
// Phase 3 plan: this double-pins the label the same way Phase 1's own tests
// already do, rather than reaching into the module's internals.
const LABEL = 'macp-commitment-hash/1';

/** Wire (snake_case) shape of a vector's `payload` field. */
interface CmtHashVectorPayload {
  commitment_id: string;
  action: string;
  authority_scope: string;
  reason: string;
  mode_version: string;
  policy_version: string;
  configuration_version: string;
  outcome_positive: boolean;
  supersedes?: {
    session_id: string;
    commitment_hash: string;
  };
}

/** Wire (snake_case) shape of a `tests/vectors/cmt-hash/*.json` vector file. */
interface CmtHashVector {
  name: string;
  description: string;
  label: string;
  payload: CmtHashVectorPayload;
  jcs_utf8_hex: string;
  preimage_utf8_hex: string;
  hash: string;
  must_differ_from?: string;
}

const VECTOR_DIR = path.resolve(__dirname, 'cmt-hash');

const vectorFiles = fs
  .readdirSync(VECTOR_DIR)
  // `vector-schema.json` is the JSON Schema describing the vector format —
  // not a vector itself.
  .filter((f) => /^cmt_hash_.*\.json$/.test(f))
  .sort();

const vectors: CmtHashVector[] = vectorFiles.map((f) => JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, f), 'utf8')));

/**
 * Builds this SDK's camelCase `CommitmentPayload` from a vector's snake_case
 * `payload`, field by field, by hand.
 *
 * This explicit mapping — NOT a shared/generic snake_case<->camelCase
 * converter, and NOT a spread-and-cast of the vector's own object — is the
 * single most important detail of this test file. `src/commitment-hash.ts`
 * internally does its own camelCase->snake_case projection
 * (`canonicalizeCommitmentPayload`); if this test built its input via the
 * same (or shared) conversion logic, a bug in that shared logic would cancel
 * itself out on both sides and every assertion below would pass vacuously
 * even if the implementation were wrong. Writing the mapping out longhand
 * here keeps the test's input construction fully independent of the
 * implementation under test.
 */
function toCommitmentPayload(payload: CmtHashVectorPayload): CommitmentPayload {
  return {
    commitmentId: payload.commitment_id,
    action: payload.action,
    authorityScope: payload.authority_scope,
    reason: payload.reason,
    modeVersion: payload.mode_version,
    policyVersion: payload.policy_version,
    configurationVersion: payload.configuration_version,
    outcomePositive: payload.outcome_positive,
    supersedes: payload.supersedes
      ? {
          sessionId: payload.supersedes.session_id,
          commitmentHash: payload.supersedes.commitment_hash,
        }
      : undefined,
  };
}

describe('RFC-MACP-0013 commitment hash: canonical spec vectors', () => {
  it('loaded all 5 canonical vectors', () => {
    expect(vectors.map((v) => v.name)).toEqual([
      'cmt_hash_001_minimal',
      'cmt_hash_002_supersedes',
      'cmt_hash_003_all_empty',
      'cmt_hash_004_empty_supersedes',
      'cmt_hash_005_escapes',
    ]);
  });

  describe.each(vectors)('$name', (vector) => {
    it('every vector pins the label this module hardcodes', () => {
      expect(vector.label).toBe(LABEL);
    });

    it('canonicalizeCommitmentPayload() matches jcs_utf8_hex', () => {
      const payload = toCommitmentPayload(vector.payload);
      const jcs = canonicalizeCommitmentPayload(payload);
      const jcsHex = Buffer.from(jcs, 'utf8').toString('hex');
      expect(jcsHex).toBe(vector.jcs_utf8_hex);
    });

    it('LABEL + ":" + JCS matches preimage_utf8_hex', () => {
      const payload = toCommitmentPayload(vector.payload);
      const jcs = canonicalizeCommitmentPayload(payload);
      const preimage = `${LABEL}:${jcs}`;
      const preimageHex = Buffer.from(preimage, 'utf8').toString('hex');
      expect(preimageHex).toBe(vector.preimage_utf8_hex);
    });

    it('commitmentHash() matches hash', () => {
      const payload = toCommitmentPayload(vector.payload);
      expect(commitmentHash(payload)).toBe(vector.hash);
    });
  });

  // must_differ_from (currently only vector 004, pointed at 003): a hashable
  // "empty supersedes" payload must NOT collide with the otherwise-identical
  // payload that omits supersedes entirely. Written generically — any future
  // vector carrying `must_differ_from` is covered without further changes.
  describe('must_differ_from inequality constraints', () => {
    const byName = new Map(vectors.map((v) => [v.name, v]));

    const withConstraint = vectors.filter((v) => v.must_differ_from !== undefined);

    it('at least one vector declares a must_differ_from constraint', () => {
      expect(withConstraint.length).toBeGreaterThan(0);
    });

    for (const vector of withConstraint) {
      it(`${vector.name}.hash !== ${vector.must_differ_from}.hash`, () => {
        const other = byName.get(vector.must_differ_from!);
        expect(other, `must_differ_from references unknown vector '${vector.must_differ_from}'`).toBeDefined();

        const payload = toCommitmentPayload(vector.payload);
        const otherPayload = toCommitmentPayload(other!.payload);

        expect(commitmentHash(payload)).not.toBe(commitmentHash(otherPayload));
        // Cross-check directly against the vectors' own pinned hashes too, not
        // just the freshly computed ones.
        expect(vector.hash).not.toBe(other!.hash);
      });
    }
  });
});
