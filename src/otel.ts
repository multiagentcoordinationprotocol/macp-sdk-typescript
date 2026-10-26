/**
 * Optional OpenTelemetry instrumentation (docs/opentelemetry.md in the spec
 * repo, semconv `span.macp.send`; propagation per RFC-MACP-0006 §2.1).
 *
 * `@opentelemetry/api` is an optional peer dependency. It is required lazily,
 * on the first RPC, never at import, so loading the SDK never touches it, and
 * when it is not installed every function here is a no-op. Nothing in this
 * module may throw into the send path: instrumentation must never fail a call.
 *
 * Internal: not exported from `src/index.ts`, and never imported by the
 * browser-safe `./receipt` subpath.
 */
import type * as OtelApiModule from '@opentelemetry/api';
import { MacpAckError, MacpTransportError } from './errors';
import type { Ack, Envelope } from './types';

type OtelApi = typeof OtelApiModule;

/** A span context, opaque outside this module. */
export type TraceContext = OtelApiModule.SpanContext;

const TRACER_NAME = 'macp-sdk-typescript';
/** OpenTelemetry's fallback `error.type` when no better value is known. */
const ERROR_TYPE_OTHER = '_OTHER';

// undefined: not tried yet; null: tried, absent.
let loaded: OtelApi | null | undefined;
let override: OtelApi | null | undefined;
let tracerVersion: string | undefined;

/**
 * Test seam: `null` forces "not installed", a module object replaces the real
 * one, `undefined` restores normal loading.
 */
export function setOtelApiForTesting(api: OtelApi | null | undefined): void {
  override = api;
}

function otelApi(): OtelApi | undefined {
  if (override !== undefined) return override ?? undefined;
  if (loaded === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loaded = require('@opentelemetry/api') as OtelApi;
    } catch {
      loaded = null;
    }
  }
  return loaded ?? undefined;
}

function sdkVersion(): string | undefined {
  if (tracerVersion === undefined) {
    try {
      // Resolves to the package root from both src/ and dist/.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      tracerVersion = String((require('../package.json') as { version?: unknown }).version ?? '');
    } catch {
      tracerVersion = '';
    }
  }
  return tracerVersion || undefined;
}

/**
 * W3C `traceparent`/`tracestate` for the given span context, or the active
 * one when none is given. Built from the API alone rather than through the
 * global propagator, which would also inject `baggage` (arbitrary user data)
 * and follow a user's B3/Jaeger configuration; §2.1 names only these two.
 */
export function traceHeaders(explicit?: TraceContext): Array<[string, string]> {
  const api = otelApi();
  if (!api) return [];
  try {
    const spanContext = explicit ?? api.trace.getSpanContext(api.context.active());
    if (!spanContext || !api.isSpanContextValid(spanContext)) return [];
    const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
    const headers: Array<[string, string]> = [
      ['traceparent', `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`],
    ];
    const tracestate = spanContext.traceState?.serialize();
    if (tracestate) headers.push(['tracestate', tracestate]);
    return headers;
  } catch {
    return [];
  }
}

/** One in-flight `send {macp.mode.id}` CLIENT span. */
export interface SendSpan {
  /** The span's own context, injected into the Send metadata. */
  readonly context: TraceContext | undefined;
  /**
   * Run `fn` with this span active, so a transport client span (for example
   * from gRPC auto-instrumentation) is its child, as the semconv note on
   * `span.macp.send` requires. Calls `fn` exactly once; an OpenTelemetry
   * failure falls back to calling it directly.
   */
  run<T>(fn: () => T): T;
  /** Record the outcome and end the span. Safe to call once; never throws. */
  end(result: { ack: Ack } | { error: unknown }): void;
}

/**
 * Start the CLIENT span for one `send()`, or return `undefined` when
 * OpenTelemetry is not installed (or the tracer fails). Only identifiers and
 * types are recorded — never payload, `reason`, or any error message.
 */
export function startSendSpan(envelope: Envelope): SendSpan | undefined {
  const api = otelApi();
  if (!api) return undefined;
  try {
    const attributes: OtelApiModule.Attributes = {
      'macp.operation.name': 'send',
      'macp.message.id': envelope.messageId,
      'macp.message.type': envelope.messageType,
    };
    if (envelope.macpVersion) attributes['macp.version'] = envelope.macpVersion;
    if (envelope.sessionId) attributes['macp.session.id'] = envelope.sessionId;
    if (envelope.mode) attributes['macp.mode.id'] = envelope.mode;
    if (envelope.sender) attributes['macp.sender.id'] = envelope.sender;
    const name = envelope.mode ? `send ${envelope.mode}` : 'send';
    const span = api.trace
      .getTracer(TRACER_NAME, sdkVersion())
      .startSpan(name, { kind: api.SpanKind.CLIENT, attributes }, api.context.active());
    let ended = false;
    return {
      context: safe(() => span.spanContext()),
      run(fn) {
        let called = false;
        let returned = false;
        let result: ReturnType<typeof fn>;
        const once = () => {
          called = true;
          result = fn();
          returned = true;
          return result;
        };
        try {
          return api.context.with(api.trace.setSpan(api.context.active(), span), once);
        } catch (error) {
          // fn's own throw propagates; an OpenTelemetry failure before or
          // after fn never replaces the call's real result.
          if (!called) return fn();
          if (returned) return result!;
          throw error;
        }
      },
      end(result) {
        if (ended) return;
        ended = true;
        safe(() => {
          recordOutcome(api, span, result);
        });
        safe(() => span.end());
      },
    };
  } catch {
    return undefined;
  }
}

function recordOutcome(api: OtelApi, span: OtelApiModule.Span, result: { ack: Ack } | { error: unknown }): void {
  if ('ack' in result) {
    const { ack } = result;
    if (ack.duplicate) span.setAttribute('macp.envelope.outcome', 'duplicate');
    else if (ack.ok) span.setAttribute('macp.envelope.outcome', 'accepted');
    else rejected(span, ack.error?.code);
    return;
  }
  const { error } = result;
  // A rejection is a normal protocol outcome: status stays UNSET. The SDK
  // raises MacpAckError for a NACK, a status carrying `macp-error-code`, and
  // the pre-0.9 status fallback — the span classifies exactly as the caller's
  // exception does.
  if (error instanceof MacpAckError) {
    rejected(span, error.failure.code);
    return;
  }
  const errorType =
    (error instanceof MacpTransportError ? (error.macpErrorCode ?? error.code) : undefined) || ERROR_TYPE_OTHER;
  span.setAttribute('error.type', errorType);
  // The description is the code only; exception messages are never recorded.
  span.setStatus({ code: api.SpanStatusCode.ERROR, message: errorType });
}

function rejected(span: OtelApiModule.Span, code: string | undefined): void {
  span.setAttribute('macp.envelope.outcome', 'rejected');
  span.setAttribute('error.type', code || ERROR_TYPE_OTHER);
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
