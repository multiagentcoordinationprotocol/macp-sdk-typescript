/**
 * Cross-SDK parity contract (`plans/sdk-parity-typescript.md` Phase 5):
 * asserts this SDK's actual runtime values against every section of the
 * vendored `contract.json` (see `SOURCE.md`) whose `applies_to` names
 * `macp-sdk-typescript`. `contract.json` is non-normative (its own
 * `$comment` and the spec repo's `schemas/parity/README.md` say so) — this
 * test reads the live manifest content rather than hand-copying its values,
 * so drift between the manifest and this file shows up as a failing
 * assertion here, not just as `make verify-parity` drift between the
 * manifest and its canonical source.
 *
 * `contribute_acceptance` (`applies_to: [macp-runtime]` only) is
 * deliberately not asserted — see `SOURCE.md` "Open items".
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIGURATION_VERSION,
  DEFAULT_MODE_VERSION,
  DEFAULT_POLICY_VERSION,
  DUPLICATE_MESSAGE,
  FORBIDDEN,
  INTERNAL_ERROR,
  INVALID_ENVELOPE,
  INVALID_POLICY_DEFINITION,
  INVALID_SESSION_ID,
  MACP_VERSION,
  MODE_MULTI_ROUND,
  MODE_NOT_SUPPORTED,
  PAYLOAD_TOO_LARGE,
  POLICY_DENIED,
  RATE_LIMITED,
  SESSION_ALREADY_EXISTS,
  SESSION_NOT_FOUND,
  SESSION_NOT_OPEN,
  STANDARD_MODES,
  UNAUTHENTICATED,
  UNKNOWN_POLICY_VERSION,
  UNSUPPORTED_PROTOCOL_VERSION,
} from '../../src/constants';
import { isCanonicalCommitmentHash } from '../../src/commitment-hash';
import { buildDecisionPolicy } from '../../src/policy';
import {
  ANOMALY_DUPLICATE_BALLOT,
  ANOMALY_DUPLICATE_VOTE,
  PROJECTION_ANOMALY_FIELD_ORDER,
} from '../../src/projections/base';
import { ProtoRegistry } from '../../src/proto-registry';
import { DEFAULT_RETRY_POLICY } from '../../src/retry';
import contract from './contract.json';

const registry = new ProtoRegistry();

function snakeToLowerCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

describe('parity contract (tests/parity/contract.json)', () => {
  it('pins contract_version 1.0.0 — a version bump means re-reading this whole file', () => {
    // Not a manifest-content assertion: a tripwire so a future contract_version
    // bump (MINOR or MAJOR, per the manifest's own versioning rule) forces a
    // human to re-review every section below, not just whichever one changed.
    expect(contract.contract_version).toBe('1.0.0');
  });

  describe('protocol', () => {
    it('macp_version matches MACP_VERSION', () => {
      expect(MACP_VERSION).toBe(contract.sections.protocol.macp_version);
    });
  });

  describe('modes', () => {
    it('standard mode ids match STANDARD_MODES, in order', () => {
      expect([...STANDARD_MODES]).toEqual(contract.sections.modes.standard);
    });

    it('extension mode id matches MODE_MULTI_ROUND', () => {
      expect(contract.sections.modes.extension).toEqual([MODE_MULTI_ROUND]);
    });
  });

  describe('defaults', () => {
    it('mode_version/configuration_version/policy_version match the DEFAULT_* constants', () => {
      expect(DEFAULT_MODE_VERSION).toBe(contract.sections.defaults.mode_version);
      expect(DEFAULT_CONFIGURATION_VERSION).toBe(contract.sections.defaults.configuration_version);
      expect(DEFAULT_POLICY_VERSION).toBe(contract.sections.defaults.policy_version);
    });

    it("policy_builder_schema_version matches buildDecisionPolicy's default", () => {
      const descriptor = buildDecisionPolicy('policy.parity-probe', 'parity probe', {});
      expect(descriptor.schemaVersion).toBe(contract.sections.defaults.policy_builder_schema_version);
    });
  });

  describe('error_codes', () => {
    const exported: Record<string, string> = {
      UNSUPPORTED_PROTOCOL_VERSION,
      INVALID_ENVELOPE,
      SESSION_ALREADY_EXISTS,
      SESSION_NOT_FOUND,
      SESSION_NOT_OPEN,
      MODE_NOT_SUPPORTED,
      FORBIDDEN,
      UNAUTHENTICATED,
      DUPLICATE_MESSAGE,
      PAYLOAD_TOO_LARGE,
      RATE_LIMITED,
      INTERNAL_ERROR,
      POLICY_DENIED,
      INVALID_SESSION_ID,
      UNKNOWN_POLICY_VERSION,
      INVALID_POLICY_DEFINITION,
    };

    it('exports exactly the 16 permanent codes the manifest pins (order-independent)', () => {
      expect(Object.keys(exported).sort()).toEqual([...contract.sections.error_codes.permanent].sort());
      for (const [name, value] of Object.entries(exported)) {
        expect(value, `${name} export`).toBe(name);
      }
    });

    it('has no export for the one deprecated code (correctly)', () => {
      // No src/constants.ts counterpart for 'UNAUTHORIZED' on purpose — it's
      // deprecated and should not be re-exported. Hardcoded here rather than
      // imported, since there is nothing to import.
      expect(contract.sections.error_codes.deprecated).toEqual(['UNAUTHORIZED']);
    });
  });

  describe('retry', () => {
    it('DEFAULT_RETRY_POLICY matches every pinned field', () => {
      const retry = contract.sections.retry;
      expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(retry.max_retries);
      expect(DEFAULT_RETRY_POLICY.backoffBase).toBe(retry.backoff_base_seconds);
      expect(DEFAULT_RETRY_POLICY.backoffMax).toBe(retry.backoff_max_seconds);
      expect([...DEFAULT_RETRY_POLICY.retryableCodes].sort()).toEqual([...retry.retryable_error_codes].sort());
    });

    it("the manifest's illustrative backoff_schedule_seconds is derivable, not a stored field", () => {
      // backoff_schedule_seconds is documented as a *derived* illustrative
      // value in the manifest, not a real RetryPolicy field — recompute it
      // from backoffBase/backoffMax rather than looking for a matching
      // export. jitter: false documents deliberate absence (neither SDK has
      // a jitter field); no assertion needed for it.
      const { backoffBase, backoffMax } = DEFAULT_RETRY_POLICY;
      const schedule = [0, 1, 2].map((attempt) => Math.min(backoffBase * 2 ** attempt, backoffMax));
      expect(schedule).toEqual(contract.sections.retry.backoff_schedule_seconds);
      expect(contract.sections.retry.jitter).toBe(false);
    });
  });

  describe('projection_anomaly', () => {
    it('kinds match ANOMALY_DUPLICATE_VOTE/ANOMALY_DUPLICATE_BALLOT', () => {
      expect([ANOMALY_DUPLICATE_VOTE, ANOMALY_DUPLICATE_BALLOT]).toEqual(contract.sections.projection_anomaly.kinds);
    });

    it('fields, transformed per field_case_rule, match PROJECTION_ANOMALY_FIELD_ORDER in order', () => {
      const transformed = contract.sections.projection_anomaly.fields.map(snakeToLowerCamel);
      expect(transformed).toEqual([...PROJECTION_ANOMALY_FIELD_ORDER]);
    });
  });

  describe('commitment_hash', () => {
    it('pins the manifest pattern string (informational — the predicate itself is exercised below)', () => {
      expect(contract.sections.commitment_hash.pattern).toBe('^sha256:[0-9a-f]{64}$');
    });

    it('accepts every manifest accept vector (1 vector)', () => {
      expect(contract.sections.commitment_hash.accept).toHaveLength(1);
      for (const value of contract.sections.commitment_hash.accept) {
        expect(isCanonicalCommitmentHash(value), JSON.stringify(value)).toBe(true);
      }
    });

    it('rejects every manifest reject vector (11 vectors)', () => {
      expect(contract.sections.commitment_hash.reject).toHaveLength(11);
      for (const value of contract.sections.commitment_hash.reject) {
        expect(isCanonicalCommitmentHash(value), JSON.stringify(value)).toBe(false);
      }
    });
  });

  describe('contribute_payload', () => {
    it('encodes every vector to the pinned canonical protobuf hex (4 vectors)', () => {
      expect(contract.sections.contribute_payload.vectors).toHaveLength(4);
      for (const vector of contract.sections.contribute_payload.vectors) {
        const encoded = registry.encodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', { value: vector.value });
        expect(encoded.toString('hex'), vector.name).toBe(vector.protobuf_hex);
      }
    });

    it('decodes every vector carrying legacy_json_hex back to { value }', () => {
      const withLegacy = contract.sections.contribute_payload.vectors.filter(
        (v): v is typeof v & { legacy_json_hex: string } => 'legacy_json_hex' in v,
      );
      expect(withLegacy.length).toBeGreaterThan(0);
      for (const vector of withLegacy) {
        const decoded = registry.decodeKnownPayload(
          MODE_MULTI_ROUND,
          'Contribute',
          Buffer.from(vector.legacy_json_hex, 'hex'),
        );
        expect(decoded, vector.name).toEqual({ value: vector.value });
      }
    });

    it('decode-only vector (one_byte_varint_boundary) round-trips via protobuf only', () => {
      const vector = contract.sections.contribute_payload.vectors.find((v) => v.name === 'one_byte_varint_boundary');
      expect(vector).toBeDefined();
      expect(vector).not.toHaveProperty('legacy_json_hex');
      const decoded = registry.decodeKnownPayload(
        MODE_MULTI_ROUND,
        'Contribute',
        Buffer.from(vector!.protobuf_hex, 'hex'),
      );
      expect(decoded).toEqual({ value: vector!.value });
    });

    it('decode_order is JSON-first, matching the #93 fix (tests/unit/proto-registry.test.ts:178-185)', () => {
      expect(contract.sections.contribute_payload.decode_order).toEqual(['json', 'protobuf']);
      // Re-assert JSON-first behaviorally by hand-building a legacy-JSON
      // buffer from one of the manifest's own vector *values* (not its
      // legacy_json_hex, so this stays a from-scratch JSON encode rather than
      // reusing the same bytes the legacy-JSON decode test above already
      // exercises), rather than re-deriving #93's whole test suite here.
      const vector = contract.sections.contribute_payload.vectors[0];
      const encoded = Buffer.from(JSON.stringify({ value: vector.value }), 'utf8');
      expect(registry.decodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', encoded)).toEqual({ value: vector.value });
    });
  });
});
