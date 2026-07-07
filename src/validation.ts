import { MacpSessionError } from './errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]{22,}$/;

export function validateSessionId(sid: string): void {
  if (!UUID_RE.test(sid) && !BASE64URL_RE.test(sid)) {
    throw new MacpSessionError(`session_id must be UUID v4/v7 or base64url (22+ chars), got: ${sid}`);
  }
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
  if (value < 0.0 || value > 1.0) {
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

export function validateSessionStart(input: {
  intent: string;
  participants: string[];
  ttlMs: number;
  maxSuspendMs?: number;
  modeVersion: string;
  configurationVersion: string;
}): void {
  validateRequiredField('intent', input.intent);
  validateParticipants(input.participants);
  validateTtlMs(input.ttlMs);
  if (input.maxSuspendMs !== undefined) validateMaxSuspendMs(input.maxSuspendMs);
  validateRequiredField('modeVersion', input.modeVersion);
  validateRequiredField('configurationVersion', input.configurationVersion);
}
