import { MacpSessionError } from './errors';

// A string with the structural shape of a UUID (36 chars, hyphens at
// 8-13-18-23, hex-only otherwise) — case-insensitive, any version/variant.
const UUID_SHAPE_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Strict lowercase UUID v4/v7 (version nibble 4 or 7, RFC 9562 variant 8/9/a/b).
const UUID_V4V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]{22,}$/;

/**
 * Validate that `sid` is a lowercase UUID v4/v7 or base64url (22+ chars).
 *
 * Mirrors the runtime's **no-fall-through** rule (issue #108.1, and
 * `macp-sdk-python`'s `validate_session_id`, `validation.py:33-58`, which
 * this ports verbatim in shape): a string with the *structural* shape of a
 * UUID (36 chars, hyphens at 8-13-18-23, hex-only) is validated strictly as
 * a lowercase v4/v7 UUID — it is never reinterpreted as base64url, which
 * would otherwise let an uppercase, wrong-version, or bad-variant UUID slip
 * through since it also happens to satisfy the base64url charset. A single
 * combined regex cannot express this: the absence of fall-through is itself
 * the rule. Only a string that is not UUID-shaped at all reaches the
 * base64url branch.
 */
export function validateSessionId(sid: string): void {
  if (UUID_SHAPE_RE.test(sid)) {
    if (!UUID_V4V7_RE.test(sid)) {
      throw new MacpSessionError(
        `session_id is UUID-shaped but not a lowercase v4/v7 UUID (no fall-through to base64url), got: ${sid}`,
      );
    }
    return;
  }
  if (BASE64URL_RE.test(sid)) return;
  throw new MacpSessionError(`session_id must be a lowercase UUID v4/v7 or base64url (22+ chars), got: ${sid}`);
}

const VALID_VOTES = new Set(['APPROVE', 'REJECT', 'ABSTAIN']);

export function validateVote(value: string): string {
  const normalized = value.toUpperCase();
  if (!VALID_VOTES.has(normalized)) {
    throw new MacpSessionError(`invalid vote value '${value}': must be one of APPROVE, REJECT, ABSTAIN`);
  }
  return normalized;
}

const VALID_RECOMMENDATIONS = new Set(['APPROVE', 'REVIEW', 'BLOCK', 'REJECT']);

export function validateRecommendation(value: string): string {
  const normalized = value.toUpperCase();
  if (!VALID_RECOMMENDATIONS.has(normalized)) {
    throw new MacpSessionError(`invalid recommendation '${value}': must be one of APPROVE, REVIEW, BLOCK, REJECT`);
  }
  return normalized;
}

export function validateConfidence(value: number): void {
  // `Number.isFinite` (matching this file's own `ttlMs`/`maxSuspendMs`
  // idiom) rather than two range comparisons alone: `NaN < 0` and
  // `NaN > 1.0` are both `false`, so a bare range check silently *accepts*
  // `NaN` (issue #108.2) — verified by execution before this fix. `Infinity`
  // was already rejected incidentally (`Infinity > 1.0`); this also rejects
  // it explicitly rather than by accident.
  if (!Number.isFinite(value) || value < 0.0 || value > 1.0) {
    throw new MacpSessionError(`confidence must be in [0.0, 1.0], got ${value}`);
  }
}

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

export function validateSeverity(value: string): string {
  const normalized = value.toLowerCase();
  if (!VALID_SEVERITIES.has(normalized)) {
    throw new MacpSessionError(`invalid severity '${value}': must be one of critical, high, medium, low`);
  }
  return normalized;
}

const MAX_PARTICIPANTS = 1000;

export function validateParticipantCount(count: number): void {
  if (count > MAX_PARTICIPANTS) {
    throw new MacpSessionError(`Maximum ${MAX_PARTICIPANTS} participants per session`);
  }
}

export function validateSignalType(signalType: string, data?: Buffer | Uint8Array): void {
  if (data && data.length > 0 && !signalType.trim()) {
    throw new MacpSessionError('signalType must be non-empty when data is present');
  }
}

/**
 * Validate the `Progress` scope pairing (RFC-MACP-0001 §6).
 *
 * `Progress` is legal in exactly two shapes — ambient (`sessionId` and `mode`
 * both empty) or session-scoped (both non-empty). An envelope with exactly one
 * of the two empty is a mixed shape that the runtime rejects with
 * `INVALID_ENVELOPE`; raising here names the mismatched field instead.
 *
 * Unlike Signals, `Progress` is *not* required to be ambient — this is a
 * tri-state rule, so neither field may be inferred from the other.
 *
 * The emptiness test deliberately mirrors `macp-runtime`'s
 * `validate_envelope_shape` **exactly**, including its asymmetry: `sessionId`
 * is compared raw while `mode` is trimmed first. Mirroring rather than
 * normalising is the only choice under which the SDK neither accepts a shape
 * the runtime rejects nor rejects one it accepts. Concretely, a
 * whitespace-only `mode` alongside an empty `sessionId` is ambient to the
 * runtime, so it stays ambient here.
 */
export function validateProgressScope(sessionId: string, mode: string): void {
  const sessionIdEmpty = sessionId === '';
  const modeEmpty = mode.trim() === '';
  if (sessionIdEmpty === modeEmpty) return;
  const detail = sessionIdEmpty
    ? `mode is ${JSON.stringify(mode)} but sessionId is empty`
    : `sessionId is ${JSON.stringify(sessionId)} but mode is empty`;
  throw new MacpSessionError(
    `Progress must be either ambient (sessionId and mode both empty) or session-scoped ` +
      `(both non-empty), but ${detail} (RFC-MACP-0001 §6). ` +
      'Pass both fields for a session-scoped Progress, or neither for an ambient one.',
  );
}

const MAX_TTL_MS = 86_400_000; // 24 hours

export function validateTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new MacpSessionError(`ttl_ms must be in [1, ${MAX_TTL_MS}], got ${ttlMs}`);
  }
}

export function validateMaxSuspendMs(maxSuspendMs: number): void {
  // 0 = "use runtime default"; only negatives are rejected (matches the
  // runtime, which rejects negative max_suspend_ms at SessionStart).
  if (!Number.isFinite(maxSuspendMs) || maxSuspendMs < 0) {
    throw new MacpSessionError(`max_suspend_ms must be >= 0 (0 = runtime default), got ${maxSuspendMs}`);
  }
}

export function validateParticipants(participants: string[]): void {
  if (!participants.length) {
    throw new MacpSessionError('participants must be non-empty');
  }
  const seen = new Set<string>();
  for (const p of participants) {
    if (seen.has(p)) {
      throw new MacpSessionError(`duplicate participant: ${p}`);
    }
    seen.add(p);
  }
  validateParticipantCount(participants.length);
}

export function validateRequiredField(fieldName: string, value: string): void {
  if (!value?.trim()) {
    throw new MacpSessionError(`${fieldName} must be non-empty`);
  }
}

const COMMITMENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function validateCommitmentHash(value: string, field = 'commitmentHash'): void {
  if (!COMMITMENT_HASH_RE.test(value)) {
    throw new MacpSessionError(`${field} must be 'sha256:' followed by 64 lowercase hex characters, got: ${value}`);
  }
}

export function validateSessionStart(input: {
  intent: string;
  participants: string[];
  ttlMs: number;
  maxSuspendMs?: number;
  modeVersion: string;
  configurationVersion: string;
}): void {
  // `intent` is a proto3 singular string field (implicit presence -- an
  // omitted field and an explicit "" serialize identically on the wire), and
  // RFC-MACP-0001 §7.1 states a runtime "MUST NOT reject a SessionStart
  // solely because intent is empty" -- no client-side non-empty check here
  // (issue #124 item 3).
  validateParticipants(input.participants);
  validateTtlMs(input.ttlMs);
  if (input.maxSuspendMs !== undefined) validateMaxSuspendMs(input.maxSuspendMs);
  validateRequiredField('modeVersion', input.modeVersion);
  validateRequiredField('configurationVersion', input.configurationVersion);
}
