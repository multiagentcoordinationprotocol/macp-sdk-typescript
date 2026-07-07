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
   * → do not reconnect), or a passive-subscribe resume below a compacted base
   * (`FAILED_PRECONDITION`). Absent for locally-raised transport errors.
   */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'MacpTransportError';
    this.code = code;
  }
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
}

export class MacpAckError extends MacpSdkError {
  readonly ack: Ack;
  /** Optional gRPC trailing metadata for extracting additional error details. */
  readonly grpcMetadata?: Array<{ key: string; value: string | Buffer }>;
  /** Structured NACK record — parity with python-sdk `MacpAckError.failure`. */
  readonly failure: AckFailure;

  constructor(ack: Ack, grpcMetadata?: Array<{ key: string; value: string | Buffer }>) {
    super(`${ack.error?.code ?? 'UNKNOWN'}: ${ack.error?.message ?? 'runtime returned nack'}`);
    this.name = 'MacpAckError';
    this.ack = ack;
    this.grpcMetadata = grpcMetadata;
    const reasons = MacpAckError._extractReasons(ack, grpcMetadata);
    this.failure = {
      code: ack.error?.code ?? 'UNKNOWN',
      message: ack.error?.message ?? 'runtime returned nack',
      sessionId: ack.sessionId ?? ack.error?.sessionId ?? '',
      messageId: ack.messageId ?? ack.error?.messageId ?? '',
      reasons,
    };
  }

  private static _extractReasons(ack: Ack, grpcMetadata?: Array<{ key: string; value: string | Buffer }>): string[] {
    // First try: parse from ack.error.details (matches Python _parse_ack_reasons)
    const fromDetails = MacpAckError._parseAckReasons(ack);
    if (fromDetails.length > 0) return fromDetails;
    // Second try: parse from gRPC trailing metadata (matches Python _parse_grpc_metadata_reasons)
    return MacpAckError._parseGrpcMetadataReasons(grpcMetadata);
  }

  private static _parseAckReasons(ack: Ack): string[] {
    if (!ack.error?.details) return [];
    try {
      const details = ack.error.details;
      const raw = Buffer.isBuffer(details) ? details.toString('utf-8') : String(details);
      const parsed = JSON.parse(raw);
      const reasons = parsed.reasons;
      return Array.isArray(reasons) ? reasons : [];
    } catch {
      return [];
    }
  }

  private static _parseGrpcMetadataReasons(grpcMetadata?: Array<{ key: string; value: string | Buffer }>): string[] {
    if (!grpcMetadata) return [];
    try {
      for (const item of grpcMetadata) {
        if (item.key === 'macp-error-details-bin') {
          const data = Buffer.isBuffer(item.value)
            ? item.value.toString('utf-8')
            : typeof item.value === 'string'
              ? item.value
              : Buffer.from(item.value).toString('utf-8');
          const parsed = JSON.parse(data);
          const reasons = parsed.reasons;
          return Array.isArray(reasons) ? reasons : [];
        }
      }
    } catch {
      // Intentionally swallowed — matches Python's bare except
    }
    return [];
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
