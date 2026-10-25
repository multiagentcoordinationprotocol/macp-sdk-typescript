/**
 * RFC-MACP-0013 Appendix A decision receipts — spec vector runner.
 *
 * Replays the spec repo's `schemas/conformance/receipt/` vectors (copied
 * byte-for-byte, see `tests/vectors/receipt/SOURCE.md`) against
 * `verifyReceipt()`, and rebuilds the Appendix A example receipt with
 * `buildReceipt()` and the A.5 example key: Ed25519 is deterministic, so the
 * rebuilt receipt must equal the published one exactly, key order included.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildReceipt, verifyReceipt, type DecisionReceipt, type ReceiptVerification } from '../../src/receipt';
import type { CommitmentPayload } from '../../src/types';

interface ReceiptVector {
  name: string;
  description: string;
  receipt: Record<string, unknown>;
  trusted_keys: Record<string, string>;
  expected: ReceiptVerification;
}

const DIR = path.join(__dirname, 'receipt');
const vectors: ReceiptVector[] = fs
  .readdirSync(DIR)
  .filter((f) => /^receipt_\d{3}_.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as ReceiptVector);

/** RFC-MACP-0013 A.5: seed = SHA-256("macp-receipt example key"), kid example-1. */
const EXAMPLE_SEED = new Uint8Array(createHash('sha256').update('macp-receipt example key').digest());

describe('receipt spec vectors', () => {
  it('vendors all twelve vectors', () => {
    expect(vectors).toHaveLength(12);
  });

  it.each(vectors)('$name: $description', (vector) => {
    expect(verifyReceipt(vector.receipt, vector.trusted_keys)).toEqual(vector.expected);
  });
});

describe('buildReceipt round-trip (Appendix A example)', () => {
  const example = vectors.find((v) => v.name === 'receipt_001_attested')!;
  const published = example.receipt as unknown as DecisionReceipt;
  const c = published.commitment;
  const commitment: CommitmentPayload = {
    commitmentId: c.commitment_id,
    action: c.action,
    authorityScope: c.authority_scope,
    reason: c.reason,
    modeVersion: c.mode_version,
    policyVersion: c.policy_version,
    configurationVersion: c.configuration_version,
    outcomePositive: c.outcome_positive,
    supersedes: { sessionId: c.supersedes!.session_id, commitmentHash: c.supersedes!.commitment_hash },
  };

  const built = buildReceipt(commitment, {
    sessionId: published.session_id,
    mode: published.mode,
    issuer: published.issuer,
    issuedAt: published.issued_at,
    semanticsRev: published.semantics_rev,
    signer: { kid: 'example-1', privateKey: EXAMPLE_SEED },
  });

  it('reproduces the published receipt exactly, key order included', () => {
    expect(JSON.stringify(built)).toBe(JSON.stringify(published));
  });

  it('verifies as attested under the A.5 public key', () => {
    expect(verifyReceipt(built, example.trusted_keys)).toEqual(example.expected);
  });

  it('a signer callback gives the same receipt as the seed', () => {
    let seen: Uint8Array | undefined;
    const viaCallback = buildReceipt(commitment, {
      sessionId: published.session_id,
      mode: published.mode,
      issuer: published.issuer,
      issuedAt: published.issued_at,
      semanticsRev: published.semantics_rev,
      signer: {
        kid: 'example-1',
        sign: (input) => {
          seen = input;
          // Recompute with the seed through the module's own path to stay noble-only here.
          const att = built.attestations[0];
          return base64UrlDecode((att as { jws: string }).jws.split('.')[2]!);
        },
      },
    });
    expect(viaCallback).toEqual(built);
    expect(new TextDecoder().decode(seen!)).toMatch(/^eyJhbGciOiJFZERTQSIsImtpZCI6ImV4YW1wbGUtMSJ9\.[A-Za-z0-9_-]+$/);
  });
});

function base64UrlDecode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}
