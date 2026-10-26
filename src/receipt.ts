/**
 * RFC-MACP-0013 Appendix A decision receipts (`macp-receipt/1`).
 *
 * A receipt is a portable record of one binding Commitment that a third party
 * can check offline. Two properties are reported separately (A.1):
 *
 * - **integrity**: the recorded `commitment` has the recorded
 *   `commitment_hash` (and, when `commitment_wire_b64` is present, the wire
 *   passes §6.1 verification and decodes to `commitment`). Needs no keys.
 * - **authenticity**: some attestation over the receipt body is valid for a
 *   key the verifier trusts. Only `jws` attestations with `alg: EdDSA` are
 *   implemented; `vendor` attestations are always `unsupported`.
 *
 * Receipt JSON keeps the schema's snake_case keys
 * (`schemas/json/macp-decision-receipt.schema.json` in the spec repo); the
 * functions here take camelCase options, like the rest of the SDK.
 *
 * Browser-safe: this module and `./commitment-hash` import no gRPC, no
 * `node:crypto` and no `Buffer`. It is published as the
 * `macp-sdk-typescript/receipt` subpath for client bundles.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { commitmentHash, decodeCommitmentWire, jcsString, verifyCommitmentHash } from './commitment-hash';
import { MacpSdkError } from './errors';
import type { CommitmentPayload } from './types';

/** The only receipt format this module issues and verifies. */
export const RECEIPT_FORMAT = 'macp-receipt/1';

/** RFC-MACP-0013 §3 projection of a `CommitmentPayload`, as recorded in a receipt. */
export interface ReceiptCommitment {
  commitment_id: string;
  action: string;
  authority_scope: string;
  reason: string;
  mode_version: string;
  policy_version: string;
  configuration_version: string;
  outcome_positive: boolean;
  supersedes?: { session_id: string; commitment_hash: string };
}

export interface JwsAttestation {
  type: 'jws';
  /** Compact JWS with a detached payload: `<protected header>..<signature>`. */
  jws: string;
}

export interface VendorAttestation {
  type: 'vendor';
  format: string;
  binds: 'commitment_hash' | 'receipt' | 'other';
  value: string;
}

export type ReceiptAttestation = JwsAttestation | VendorAttestation;

/** A `macp-receipt/1` decision receipt (RFC-MACP-0013 Appendix A.2). */
export interface DecisionReceipt {
  receipt_format: typeof RECEIPT_FORMAT;
  session_id: string;
  mode: string;
  commitment: ReceiptCommitment;
  commitment_hash: string;
  commitment_wire_b64?: string;
  semantics_rev?: { implementation: string; rev: number };
  transcript?: { digest_alg: string; digest: string; message_count?: number };
  issuer: string;
  issued_at: string;
  attestations: ReceiptAttestation[];
}

/**
 * {@link MacpClient.getDecisionReceipt}'s result: the parsed receipt and the
 * `receipt_json` text exactly as the runtime served it, so a caller can store
 * the issued bytes unchanged (RFC-MACP-0013 §13 item 6 serves them
 * byte-identical). `receipt` is parsed, not validated: {@link verifyReceipt}
 * is the authority on whether it is a well-formed `macp-receipt/1`.
 */
export interface DecisionReceiptResult {
  receipt: DecisionReceipt;
  raw: string;
}

/** One JWK of a receipt key set (`schemas/json/macp-receipt-keys.schema.json`). */
export interface ReceiptJwk {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  alg?: string;
  use?: string;
  [member: string]: unknown;
}

/** A JWK Set [RFC 7517] of receipt verification keys, as `GetReceiptKeys` returns it. */
export interface ReceiptKeySet {
  keys: ReceiptJwk[];
  [member: string]: unknown;
}

/**
 * Signs a receipt with Ed25519: either a 32-byte private key seed, or a
 * callback that returns the 64-byte signature over `signingInput` (for a key
 * held elsewhere, such as an HSM, as long as it signs synchronously).
 */
export type ReceiptSigner =
  { kid: string; privateKey: Uint8Array } | { kid: string; sign: (signingInput: Uint8Array) => Uint8Array };

export interface BuildReceiptOptions {
  sessionId: string;
  mode: string;
  /** Opaque identifier of the issuer (A.2). Not a trust anchor. */
  issuer: string;
  /** RFC 3339 UTC time of issue, recorded verbatim. */
  issuedAt: string;
  /** Adds one `jws` attestation. Without it, `attestations` is `[]`. */
  signer?: ReceiptSigner;
  /** RFC-MACP-0003 §3.2 semantics revision, scoped to its implementation. */
  semanticsRev?: { implementation: string; rev: number };
  /** Implementation-defined digest of the session history (RFC-MACP-0013 §10). */
  transcript?: { digestAlg: string; digest: string; messageCount?: number };
  /** The payload's Protobuf wire encoding; recorded as `commitment_wire_b64`. */
  commitmentWire?: Uint8Array;
}

/** A.4 step 2. `null` only when the receipt is refused at step 1. */
export type ReceiptIntegrity = 'match' | 'mismatch' | 'cannot_verify' | null;
/** A.4 step 3, one per attestation. */
export type AttestationOutcome = 'valid' | 'invalid' | 'unknown_key' | 'unsupported';
/** A.4 step 4 (step 1 for `refused`). */
export type ReceiptVerdict = 'attested' | 'integrity_only' | 'unverified' | 'refused';

export interface ReceiptVerification {
  integrity: ReceiptIntegrity;
  /** One outcome per entry of `attestations`, in order; `[]` unless integrity is `match`. */
  attestations: AttestationOutcome[];
  verdict: ReceiptVerdict;
}

// --- encodings -------------------------------------------------------------

const UTF8 = new TextEncoder();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const STRICT_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const STRICT_B64URL = /^[A-Za-z0-9_-]+$/;

function encodeBase64(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < 4; c++) {
      if (c < chars) out += alphabet[(n >> (18 - 6 * c)) & 63];
      else if (pad) out += '=';
    }
  }
  return out;
}

/** Decodes unpadded base64 digits; the caller has already checked the alphabet. */
function decodeDigits(text: string, alphabet: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (const ch of text) {
    acc = (acc << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Strict standard base64, padding required (Python's `b64decode(validate=True)`). */
function decodeBase64(text: string): Uint8Array | undefined {
  if (!STRICT_B64.test(text)) return undefined;
  return decodeDigits(text.replace(/=+$/, ''), B64);
}

/** Strict unpadded base64url, non-empty. */
function decodeBase64Url(text: string): Uint8Array | undefined {
  if (!STRICT_B64URL.test(text)) return undefined;
  return decodeDigits(text, B64URL);
}

const b64url = (bytes: Uint8Array): string => encodeBase64(bytes, B64URL, false);

/**
 * RFC 8785 serialization of a receipt body. Unlike the §3 projection, a body
 * carries integers (`rev`, `message_count`); `JSON.stringify` of a finite
 * number is exactly the JCS number form. Keys sort by UTF-16 code units,
 * which is JavaScript's default string order.
 */
function jcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return jcsString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MacpSdkError('a receipt body cannot contain a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${jcsString(k)}:${jcs(v)}`).join(',')}}`;
  }
  throw new MacpSdkError(`a receipt body cannot contain a ${typeof value}`);
}

/** The receipt body (A.2): the receipt without `attestations`, in JCS. */
function receiptBody(receipt: Record<string, unknown>): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- removed from the body
  const { attestations: _omitted, ...body } = receipt;
  return UTF8.encode(jcs(body));
}

// --- projection ------------------------------------------------------------

const STRING_FIELDS = [
  'commitment_id',
  'action',
  'authority_scope',
  'reason',
  'mode_version',
  'policy_version',
  'configuration_version',
] as const;
const ALLOWED_FIELDS = new Set<string>([...STRING_FIELDS, 'outcome_positive', 'supersedes']);

/** The §3 projection, with `policy_version`/`outcome_positive` materialized and `supersedes` only when present. */
function project(payload: CommitmentPayload): ReceiptCommitment {
  const out: ReceiptCommitment = {
    commitment_id: payload.commitmentId ?? '',
    action: payload.action ?? '',
    authority_scope: payload.authorityScope ?? '',
    reason: payload.reason ?? '',
    mode_version: payload.modeVersion ?? '',
    policy_version: payload.policyVersion ?? '',
    configuration_version: payload.configurationVersion ?? '',
    outcome_positive: payload.outcomePositive ?? false,
  };
  if (payload.supersedes != null) {
    out.supersedes = {
      session_id: payload.supersedes.sessionId ?? '',
      commitment_hash: payload.supersedes.commitmentHash ?? '',
    };
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Reads a receipt's `commitment` back into a `CommitmentPayload`, or
 * `undefined` when it is not a complete, well-typed §3 projection: an unknown
 * member at either level, a missing member, or a wrongly typed one. That is
 * outside what `macp-commitment-hash/1` covers, so it is `cannot_verify`.
 */
function readCommitment(value: unknown): CommitmentPayload | undefined {
  if (!isRecord(value) || Object.keys(value).some((k) => !ALLOWED_FIELDS.has(k))) return undefined;
  if (STRING_FIELDS.some((f) => typeof value[f] !== 'string') || typeof value.outcome_positive !== 'boolean') {
    return undefined;
  }
  const payload: CommitmentPayload = {
    commitmentId: value.commitment_id as string,
    action: value.action as string,
    authorityScope: value.authority_scope as string,
    reason: value.reason as string,
    modeVersion: value.mode_version as string,
    policyVersion: value.policy_version as string,
    configurationVersion: value.configuration_version as string,
    outcomePositive: value.outcome_positive,
  };
  if ('supersedes' in value) {
    const sup = value.supersedes;
    if (
      !isRecord(sup) ||
      Object.keys(sup).some((k) => k !== 'session_id' && k !== 'commitment_hash') ||
      typeof sup.session_id !== 'string' ||
      typeof sup.commitment_hash !== 'string'
    ) {
      return undefined;
    }
    payload.supersedes = { sessionId: sup.session_id, commitmentHash: sup.commitment_hash };
  }
  return payload;
}

/**
 * Converts a snake_case §3 projection (a receipt's `commitment`, or the same
 * shape from a control plane) into the camelCase `CommitmentPayload` that
 * {@link buildReceipt} and `commitmentHash` take. Throws `MacpSdkError` when
 * it is not a complete, well-typed projection.
 */
export function commitmentFromProjection(projection: ReceiptCommitment): CommitmentPayload {
  const payload = readCommitment(projection);
  if (!payload) throw new MacpSdkError('commitmentFromProjection: not a complete RFC-MACP-0013 §3 projection');
  return payload;
}

function sameProjection(a: ReceiptCommitment, b: ReceiptCommitment): boolean {
  if (STRING_FIELDS.some((f) => a[f] !== b[f]) || a.outcome_positive !== b.outcome_positive) return false;
  if (!a.supersedes || !b.supersedes) return !a.supersedes && !b.supersedes;
  return (
    a.supersedes.session_id === b.supersedes.session_id && a.supersedes.commitment_hash === b.supersedes.commitment_hash
  );
}

// --- build -----------------------------------------------------------------

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw new MacpSdkError(`buildReceipt: ${name} must be a non-empty string`);
  return value;
}

function requireCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MacpSdkError(`buildReceipt: ${name} must be a non-negative integer`);
  }
  return value as number;
}

/**
 * Builds a `macp-receipt/1` receipt for `commitment` (RFC-MACP-0013
 * Appendix A). Computes `commitment_hash`; with a `signer`, adds one
 * detached-payload EdDSA `jws` attestation over the receipt body. Ed25519 is
 * deterministic, so the same inputs always give the same receipt.
 *
 * Throws `MacpSdkError` on a missing required option, and when
 * `commitmentWire` does not verify against, or does not decode to,
 * `commitment`, so no receipt is issued that its own verifier would reject.
 */
export function buildReceipt(commitment: CommitmentPayload, options: BuildReceiptOptions): DecisionReceipt {
  const projection = project(commitment);
  const hash = commitmentHash(commitment);
  const receipt: DecisionReceipt = {
    receipt_format: RECEIPT_FORMAT,
    session_id: requireText(options.sessionId, 'sessionId'),
    mode: requireText(options.mode, 'mode'),
    commitment: projection,
    commitment_hash: hash,
  } as DecisionReceipt;
  // Key order follows the spec's example and vectors: optional members after issued_at.
  if (options.semanticsRev !== undefined) {
    receipt.semantics_rev = {
      implementation: requireText(options.semanticsRev.implementation, 'semanticsRev.implementation'),
      rev: requireCount(options.semanticsRev.rev, 'semanticsRev.rev'),
    };
  }
  receipt.issuer = requireText(options.issuer, 'issuer');
  receipt.issued_at = requireText(options.issuedAt, 'issuedAt');
  if (options.commitmentWire !== undefined) {
    const wire = options.commitmentWire;
    // A §6.1 match means the wire projects to exactly this commitment.
    if (!(wire instanceof Uint8Array) || verifyCommitmentHash(wire, hash) !== 'match') {
      throw new MacpSdkError('buildReceipt: commitmentWire is not the wire encoding of commitment');
    }
    receipt.commitment_wire_b64 = encodeBase64(wire, B64, true);
  }
  if (options.transcript !== undefined) {
    const t = options.transcript;
    receipt.transcript = {
      digest_alg: requireText(t.digestAlg, 'transcript.digestAlg'),
      digest: requireText(t.digest, 'transcript.digest'),
    };
    if (t.messageCount !== undefined)
      receipt.transcript.message_count = requireCount(t.messageCount, 'transcript.messageCount');
  }
  receipt.attestations = [];
  if (options.signer) receipt.attestations.push(sign(receipt, options.signer));
  return receipt;
}

function sign(receipt: DecisionReceipt, signer: ReceiptSigner): JwsAttestation {
  const kid = requireText(signer.kid, 'signer.kid');
  // The protected header in JCS form: {"alg":"EdDSA","kid":"..."}.
  const header = b64url(UTF8.encode(`{"alg":"EdDSA","kid":${jcsString(kid)}}`));
  const signingInput = UTF8.encode(`${header}.${b64url(receiptBody(receipt as unknown as Record<string, unknown>))}`);
  let signature: Uint8Array;
  if ('privateKey' in signer) {
    if (!(signer.privateKey instanceof Uint8Array) || signer.privateKey.length !== 32) {
      throw new MacpSdkError('buildReceipt: signer.privateKey must be a 32-byte Ed25519 seed');
    }
    signature = ed25519.sign(signingInput, signer.privateKey);
  } else {
    signature = signer.sign(signingInput);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) {
      throw new MacpSdkError('buildReceipt: signer.sign must return a 64-byte Ed25519 signature');
    }
  }
  return { type: 'jws', jws: `${header}..${b64url(signature)}` };
}

// --- verify ----------------------------------------------------------------

function integrity(receipt: Record<string, unknown>): Exclude<ReceiptIntegrity, null> {
  const payload = readCommitment(receipt.commitment);
  if (!payload) return 'cannot_verify';
  const claimed = receipt.commitment_hash;
  if (typeof claimed !== 'string' || commitmentHash(payload) !== claimed) return 'mismatch';
  if ('commitment_wire_b64' in receipt) {
    const encoded = receipt.commitment_wire_b64;
    const wire = typeof encoded === 'string' ? decodeBase64(encoded) : undefined;
    if (!wire) return 'cannot_verify';
    const outcome = verifyCommitmentHash(wire, claimed);
    if (outcome !== 'match') return outcome;
    const decoded = decodeCommitmentWire(wire);
    if (!decoded || !sameProjection(project(decoded), project(payload))) return 'mismatch';
  }
  return 'match';
}

function attestation(att: unknown, body: string, trustedKeys: Record<string, string>): AttestationOutcome {
  // `vendor` (whatever it binds) and unknown types: no other format is implemented.
  if (!isRecord(att) || att.type !== 'jws') return 'unsupported';
  const parts = typeof att.jws === 'string' ? att.jws.split('.') : [];
  if (parts.length !== 3 || parts[1] !== '') return 'invalid';
  const headerBytes = decodeBase64Url(parts[0]!);
  const signature = decodeBase64Url(parts[2]!);
  if (!headerBytes || !signature) return 'invalid';
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
  } catch {
    return 'invalid';
  }
  if (!isRecord(header) || header.alg !== 'EdDSA') return 'unsupported';
  const kid = header.kid;
  const key =
    typeof kid === 'string' && Object.prototype.hasOwnProperty.call(trustedKeys, kid) ? trustedKeys[kid] : undefined;
  if (key === undefined) return 'unknown_key';
  const publicKey = typeof key === 'string' ? decodeBase64Url(key) : undefined;
  if (!publicKey || publicKey.length !== 32 || signature.length !== 64) return 'invalid';
  try {
    // zip215: false is RFC 8032's strict verification (canonical encodings, s < L).
    return ed25519.verify(signature, UTF8.encode(`${parts[0]}.${body}`), publicKey, { zip215: false })
      ? 'valid'
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Verifies a decision receipt (RFC-MACP-0013 Appendix A.4) against the keys
 * the caller trusts: `trustedKeys` maps a `kid` to an Ed25519 public key as a
 * JWK `x` (base64url). Returns the integrity outcome, one outcome per
 * attestation, and the overall verdict, in the spec vectors' vocabulary.
 * Never throws: malformed input yields an outcome, not an exception.
 */
export function verifyReceipt(receipt: unknown, trustedKeys: Record<string, string>): ReceiptVerification {
  if (!isRecord(receipt) || receipt.receipt_format !== RECEIPT_FORMAT) {
    return { integrity: null, attestations: [], verdict: 'refused' };
  }
  const result = integrity(receipt);
  if (result !== 'match') return { integrity: result, attestations: [], verdict: 'unverified' };
  let body: string | undefined;
  try {
    body = b64url(receiptBody(receipt));
  } catch {
    body = undefined; // a body with no JCS form: no signature over it can be valid
  }
  const keys = isRecord(trustedKeys) ? (trustedKeys as Record<string, string>) : {};
  const outcomes = (Array.isArray(receipt.attestations) ? receipt.attestations : []).map((att: unknown) =>
    body === undefined
      ? isRecord(att) && att.type === 'jws'
        ? 'invalid'
        : 'unsupported'
      : attestation(att, body, keys),
  );
  return {
    integrity: 'match',
    attestations: outcomes,
    verdict: outcomes.includes('valid') ? 'attested' : 'integrity_only',
  };
}

/** JWK private-key members (RFC 7518 §6); RFC-MACP-0013 §13 item 8 forbids them in a key set. */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** An Ed25519 public verification key usable for an EdDSA `jws` attestation. */
function usableEd25519Key(key: unknown): key is ReceiptJwk & { x: string } {
  if (!isRecord(key)) return false;
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519') return false;
  if (!isNonEmptyString(key.kid) || !isNonEmptyString(key.x)) return false;
  if (key.alg !== undefined && key.alg !== 'EdDSA') return false;
  if (key.use !== undefined && key.use !== 'sig') return false;
  return !PRIVATE_JWK_MEMBERS.some((m) => Object.prototype.hasOwnProperty.call(key, m));
}

/**
 * Turns a receipt key set (the JWK Set `GetReceiptKeys` returns, RFC-MACP-0013
 * §13 item 8) into the `kid → x` map {@link verifyReceipt} takes. Choosing to
 * trust the set is the caller's decision; this only converts it.
 *
 * A key is kept only if it is an Ed25519 public key (`kty` `OKP`, `crv`
 * `Ed25519`) with a non-empty `kid` and `x`, an `alg` (if any) of `EdDSA`, a
 * `use` (if any) of `sig`, and no private member (`d`, `p`, `q`, `dp`, `dq`,
 * `qi`, `oth`, `k`): a key set that publishes private key material is
 * misconfigured and is not trusted silently. A `kid` that more than one entry
 * of the set claims is dropped entirely, even when the other entry is a key
 * this function can't use (an EC key, say): item 8 makes kids unique across
 * the whole set, so a repeated one leaves the set ambiguous about which key it
 * names. Never throws: input that is not a key set yields `{}`.
 */
export function trustedKeysFromJwks(jwks: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) return result;
  // Count every entry's string kid, usable or not, before keeping any.
  const claims = new Map<string, number>();
  for (const key of jwks.keys) {
    if (isRecord(key) && typeof key.kid === 'string') claims.set(key.kid, (claims.get(key.kid) ?? 0) + 1);
  }
  for (const key of jwks.keys) {
    if (!usableEd25519Key(key) || claims.get(key.kid) !== 1) continue;
    // defineProperty, not assignment: a kid of "__proto__" must become an own
    // key (which verifyReceipt's hasOwnProperty lookup finds), not a prototype.
    Object.defineProperty(result, key.kid, { value: key.x, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
