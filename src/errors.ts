import type { Ack } from './types';

export class MacpSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacpSdkError';
  }
}

export class MacpTransportError extends MacpSdkError {
  /**
   * gRPC status name (e.g. `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`,
   * `UNAUTHENTICATED`) when the underlying transport failure carried one.
   * Lets consumers distinguish, for example, watch-stream consumer lag
   * (`RESOURCE_EXHAUSTED` → reconnect) from an auth failure (`UNAUTHENTICATED`
   * → do not reconnect). Absent for locally-raised transport errors. For a
   * runtime-raised MACP error prefer {@link macpErrorCode}.
   */
  readonly code?: string;

  /**
   * MACP error-codes registry code (e.g. `SESSION_NOT_FOUND`, `POLICY_DENIED`)
   * from the status's `macp-error-code` trailing metadata (runtime ≥ 0.9.0).
   * Branch on this rather than {@link code}: since 0.9.0 the gRPC status
   * follows the registry's gRPC column, and several registry codes share one
   * status (e.g. `INVALID_ENVELOPE` and `INVALID_SESSION_ID` are both
   * `INVALID_ARGUMENT`). Absent for older runtimes, for statuses the runtime
   * raised without a registry code, and for locally-raised errors.
   */
  readonly macpErrorCode?: string;

  constructor(message: string, code?: string, macpErrorCode?: string) {
    super(message);
    this.name = 'MacpTransportError';
    this.code = code;
    if (macpErrorCode !== undefined) this.macpErrorCode = macpErrorCode;
  }
}

/**
 * One structured `POLICY_DENIED` reason (RFC-MACP-0012 §6.2, runtime ≥ 0.9.0).
 *
 * `code` is an open set: the reference evaluator emits `veto`, `veto_hold`,
 * `quorum_not_met`, `threshold_not_met`, `confidence_below_minimum`,
 * `evaluation_required`, `no_votes`, `decline_over_approval`,
 * `decline_not_backed`, `criterion_not_met`, `output_required`,
 * `reassignment_not_allowed`, `unsupported_schema_version`, `invalid_rules`
 * and `unspecified`, but a custom evaluator may mint its own — treat any code
 * you do not recognise as `unspecified`. `participants` lists the participant
 * ids the reason concerns (e.g. a veto's objectors); since 0.9.0 they are no
 * longer embedded in `message`.
 */
export interface PolicyDenial {
  code: string;
  message: string;
  participants: string[];
}

/** Parsed MACP error `details` JSON: legacy `reasons` strings plus structured `denials`. */
export interface MacpErrorDetails {
  reasons: string[];
  denials: PolicyDenial[];
}

/**
 * Parse the JSON `details` the runtime attaches to a `POLICY_DENIED` error —
 * found on `Ack.error.details`, an inline stream `MACPError.details`, or the
 * `macp-error-details-bin` trailing metadata. Never throws: missing,
 * non-JSON, or malformed input yields empty arrays, and malformed `denials`
 * entries are dropped individually. Pre-0.9.0 runtimes send `reasons` only,
 * so `denials` is `[]` for them.
 */
export function parseErrorDetails(details: Buffer | Uint8Array | string | null | undefined): MacpErrorDetails {
  const empty: MacpErrorDetails = { reasons: [], denials: [] };
  if (details === null || details === undefined) return empty;
  let parsed: unknown;
  try {
    const raw = typeof details === 'string' ? details : Buffer.from(details).toString('utf-8');
    if (raw.length === 0) return empty;
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const obj = parsed as { reasons?: unknown; denials?: unknown };
  const reasons = Array.isArray(obj.reasons) ? obj.reasons.filter((r): r is string => typeof r === 'string') : [];
  const denials: PolicyDenial[] = [];
  if (Array.isArray(obj.denials)) {
    for (const d of obj.denials) {
      if (typeof d !== 'object' || d === null) continue;
      const { code, message, participants } = d as { code?: unknown; message?: unknown; participants?: unknown };
      if (typeof message !== 'string') continue;
      denials.push({
        code: typeof code === 'string' && code.length > 0 ? code : 'unspecified',
        message,
        participants: Array.isArray(participants) ? participants.filter((p): p is string => typeof p === 'string') : [],
      });
    }
  }
  return { reasons, denials };
}

/** Value of the `macp-error-code` trailing-metadata key, if present (runtime ≥ 0.9.0). */
export function macpErrorCodeFromMetadata(
  grpcMetadata?: Array<{ key: string; value: string | Buffer }>,
): string | undefined {
  const entry = grpcMetadata?.find((item) => item.key === 'macp-error-code');
  if (!entry) return undefined;
  const value = typeof entry.value === 'string' ? entry.value : entry.value.toString('utf-8');
  return value.length > 0 ? value : undefined;
}

/**
 * Structured NACK record. Mirrors python-sdk's `AckFailure` dataclass so
 * cross-SDK code can share the same shape when logging or persisting a
 * rejected message.
 */
export interface AckFailure {
  code: string;
  message: string;
  sessionId: string;
  messageId: string;
  reasons: string[];
  /**
   * Structured policy-denial reasons (runtime ≥ 0.9.0). Empty for non-policy
   * NACKs and for older runtimes, which send `reasons` strings only.
   */
  denials: PolicyDenial[];
}

export class MacpAckError extends MacpSdkError {
  readonly ack: Ack;
  /** Optional gRPC trailing metadata for extracting additional error details. */
  readonly grpcMetadata?: Array<{ key: string; value: string | Buffer }>;
  /** Structured NACK record — parity with python-sdk `MacpAckError.failure`. */
  readonly failure: AckFailure;
  /**
   * The registry code from the `macp-error-code` metadata (runtime ≥ 0.9.0)
   * when this NACK was synthesized from a gRPC status. Usually equal to
   * `failure.code`; differs on the registry-mutation RPCs, which keep
   * `failure.code: 'FAILED_PRECONDITION'` for compatibility while this names
   * the precise cause (e.g. `REGISTRY_READ_ONLY`).
   */
  readonly macpErrorCode?: string;

  constructor(ack: Ack, grpcMetadata?: Array<{ key: string; value: string | Buffer }>) {
    super(`${ack.error?.code ?? 'UNKNOWN'}: ${ack.error?.message ?? 'runtime returned nack'}`);
    this.name = 'MacpAckError';
    this.ack = ack;
    this.grpcMetadata = grpcMetadata;
    const { reasons, denials } = MacpAckError._extractDetails(ack, grpcMetadata);
    this.failure = {
      code: ack.error?.code ?? 'UNKNOWN',
      message: ack.error?.message ?? 'runtime returned nack',
      sessionId: ack.sessionId ?? ack.error?.sessionId ?? '',
      messageId: ack.messageId ?? ack.error?.messageId ?? '',
      reasons,
      denials,
    };
    const macpErrorCode = macpErrorCodeFromMetadata(grpcMetadata);
    if (macpErrorCode !== undefined) this.macpErrorCode = macpErrorCode;
  }

  private static _extractDetails(
    ack: Ack,
    grpcMetadata?: Array<{ key: string; value: string | Buffer }>,
  ): MacpErrorDetails {
    // First try: ack.error.details (matches Python _parse_ack_reasons)
    const fromAck = parseErrorDetails(ack.error?.details);
    if (fromAck.reasons.length > 0 || fromAck.denials.length > 0) return fromAck;
    // Second try: gRPC trailing metadata (matches Python _parse_grpc_metadata_reasons)
    const entry = grpcMetadata?.find((item) => item.key === 'macp-error-details-bin');
    return parseErrorDetails(entry?.value);
  }
}

export class MacpSessionError extends MacpSdkError {
  constructor(message: string) {
    super(message);
    this.name = 'MacpSessionError';
  }
}

export class MacpTimeoutError extends MacpTransportError {
  constructor(message: string) {
    super(message);
    this.name = 'MacpTimeoutError';
  }
}

export class MacpRetryError extends MacpTransportError {
  constructor(message: string) {
    super(message);
    this.name = 'MacpRetryError';
  }
}

/**
 * Raised when an explicit `sender` supplied to a mode helper conflicts with
 * the authenticated identity declared on {@link AuthConfig.expectedSender}.
 *
 * Surfaced by the SDK rather than the runtime so agents fail fast before
 * forging an envelope the runtime would reject (RFC-MACP-0004 §4).
 */
export class MacpIdentityMismatchError extends MacpSdkError {
  readonly expectedSender: string;
  readonly actualSender: string;

  constructor(expectedSender: string, actualSender: string) {
    super(
      `envelope sender "${actualSender}" does not match the authenticated identity "${expectedSender}"; ` +
        'remove the explicit sender or reconfigure Auth.bearer(token, { expectedSender })',
    );
    this.name = 'MacpIdentityMismatchError';
    this.expectedSender = expectedSender;
    this.actualSender = actualSender;
  }
}
