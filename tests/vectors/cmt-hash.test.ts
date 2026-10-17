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
 * Lives outside `tests/conformance/` because the canonical vectors sit in a
 * `cmt-hash/` subdirectory upstream, not flat — see
 * `tests/vectors/cmt-hash/SOURCE.md` for the full provenance and why that
 * layout rules out both dropping the files flat into `tests/conformance/`
 * (flagged EXTRA, since canonical keeps them in a subdirectory) and nesting
 * them at `tests/conformance/cmt-hash/*.json` (invisible to that gate's
 * non-recursive glob). The vectors themselves ARE covered by
 * `verify-fixtures`/`sync-fixtures`, bidirectionally, as of this repo's
 * issue #50 fix. `vitest.config.ts`'s `include` glob (tests, recursively, any
 * "*.test.ts" file) already collects this file with zero config changes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { commitmentHash, canonicalizeCommitmentPayload, verifyCommitmentHash } from '../../src/commitment-hash';
import { MODE_DECISION } from '../../src/constants';
import { ProtoRegistry } from '../../src/proto-registry';
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

/** A COMPUTE vector (RFC-MACP-0013 §4): pins every step of hashing `payload`. */
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

/** A VERIFY vector (RFC-MACP-0013 §6.1): a wire encoding, a claim, and the one outcome a verifier MUST return. */
interface CmtHashVerifyVector {
  name: string;
  description: string;
  label: string;
  wire_hex: string;
  claimed_hash: string;
  expected_outcome: 'match' | 'mismatch' | 'cannot_verify';
}

const VECTOR_DIR = path.resolve(__dirname, 'cmt-hash');
const registry = new ProtoRegistry();

const vectorFiles = fs
  .readdirSync(VECTOR_DIR)
  // `vector-schema.json` is the JSON Schema describing the vector format —
  // not a vector itself.
  .filter((f) => /^cmt_hash_.*\.json$/.test(f))
  .sort();

const allVectors: Array<CmtHashVector | CmtHashVerifyVector> = vectorFiles.map((f) =>
  JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, f), 'utf8')),
);
// The vector schema's `oneOf` makes the two kinds disjoint: only verify
// vectors carry `wire_hex`.
const vectors = allVectors.filter((v): v is CmtHashVector => !('wire_hex' in v));
const verifyVectors = allVectors.filter((v): v is CmtHashVerifyVector => 'wire_hex' in v);

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
  it('loaded all 5 canonical compute vectors', () => {
    expect(vectors.map((v) => v.name)).toEqual([
      'cmt_hash_001_minimal',
      'cmt_hash_002_supersedes',
      'cmt_hash_003_all_empty',
      'cmt_hash_004_empty_supersedes',
      'cmt_hash_005_escapes',
    ]);
  });

  it('loaded all 5 canonical verify vectors', () => {
    expect(verifyVectors.map((v) => v.name)).toEqual([
      'cmt_hash_006_unknown_field',
      'cmt_hash_007_mismatch',
      'cmt_hash_008_noncanonical_claim',
      'cmt_hash_009_unknown_supersedes_field',
      'cmt_hash_010_no_prefix',
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

    // Vector schema: "verifying its own hash against the payload's wire
    // encoding is *match*". The wire comes from protobufjs (an independent
    // encoder), not from the verifier's own reader.
    it('verifyCommitmentHash(protobuf wire of payload, hash) is match', () => {
      const wire = registry.encodeKnownPayload(
        MODE_DECISION,
        'Commitment',
        toCommitmentPayload(vector.payload) as unknown as Record<string, unknown>,
      );
      expect(verifyCommitmentHash(wire, vector.hash)).toBe('match');
    });
  });

  describe.each(verifyVectors)('$name (verify)', (vector) => {
    it('pins the label this module hardcodes', () => {
      expect(vector.label).toBe(LABEL);
    });

    it('verifyCommitmentHash() returns expected_outcome', () => {
      expect(verifyCommitmentHash(Buffer.from(vector.wire_hex, 'hex'), vector.claimed_hash)).toBe(
        vector.expected_outcome,
      );
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
