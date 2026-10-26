import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as otel from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../../src/auth';
import { MacpClient } from '../../src/client';
import { buildEnvelope } from '../../src/envelope';
import { MacpAckError, MacpSdkError, MacpTransportError } from '../../src/errors';
import { setOtelApiForTesting } from '../../src/otel';
import { retrySend } from '../../src/retry';
import type { Envelope } from '../../src/types';
import { stubUnary } from './helpers/grpc-stub';

// W5 S2: optional OpenTelemetry send spans and W3C trace propagation
// (spec docs/opentelemetry.md, semconv group span.macp.send in
// tests/otel/macp-semconv.json, RFC-MACP-0006 §2.1). The `otel_*` test names
// are shared with macp-sdk-python (`test_<name>`), so the two SDKs' suites
// line up one to one.

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('test');

const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  otel.trace.setGlobalTracerProvider(provider);
  // Without a context manager `context.with` is a no-op, so the active
  // context would never reach the SDK.
  otel.context.setGlobalContextManager(contextManager.enable());
  // The test's own module instance, so src/ and this file can't diverge on
  // a second copy of the API.
  setOtelApiForTesting(otel);
});

afterEach(() => {
  exporter.reset();
  setOtelApiForTesting(otel);
});

afterAll(() => {
  otel.trace.disable();
  otel.context.disable();
  setOtelApiForTesting(undefined);
});

const DECISION = 'macp.mode.decision.v1';
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function makeClient(auth = Auth.bearer('alice-token')): MacpClient {
  return new MacpClient({ address: '127.0.0.1:50051', secure: false, allowInsecure: true, auth });
}

function makeBareClient(): MacpClient {
  return new MacpClient({ address: '127.0.0.1:50051', secure: false, allowInsecure: true });
}

function vote(overrides: Partial<Parameters<typeof buildEnvelope>[0]> = {}): Envelope {
  return buildEnvelope({
    mode: DECISION,
    messageType: 'Vote',
    sessionId: 'session-1',
    sender: 'alice',
    messageId: 'msg-1',
    payload: Buffer.from('{}'),
    ...overrides,
  });
}

function onlySpan(): ReadableSpan {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

function metadataOf(extras: unknown[]): grpc.Metadata | undefined {
  return extras.find((e): e is grpc.Metadata => e instanceof grpc.Metadata);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function grpcError(code: grpc.status, macpErrorCode?: string, message = 'refused') {
  const metadata = new grpc.Metadata();
  if (macpErrorCode) metadata.set('macp-error-code', macpErrorCode);
  return { code, details: message, message, metadata };
}

describe('send span', () => {
  it('otel_send_span_name_and_attributes', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: true, messageId: 'msg-1' } });

    await client.send(vote());

    const span = onlySpan();
    expect(span.name).toBe(`send ${DECISION}`);
    expect(span.kind).toBe(otel.SpanKind.CLIENT);
    expect(span.instrumentationScope.name).toBe('macp-sdk-typescript');
    expect(span.instrumentationScope.version).toBe((require('../../package.json') as { version: string }).version);
    // Exactly the semconv span.macp.send attributes — no SDK-only extras.
    expect(span.attributes).toEqual({
      'macp.operation.name': 'send',
      'macp.message.id': 'msg-1',
      'macp.message.type': 'Vote',
      'macp.session.id': 'session-1',
      'macp.mode.id': DECISION,
      'macp.sender.id': 'alice',
      'macp.version': '1.0',
      'macp.envelope.outcome': 'accepted',
    });
    expect(span.status.code).toBe(otel.SpanStatusCode.UNSET);
    expect(span.events).toEqual([]);
  });

  it('otel_send_span_empty_mode_bare_name', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: true } });

    // An ambient Signal: no mode, no session, and no sender (the runtime
    // fills an empty sender from auth, a value the SDK doesn't know).
    await client.send(vote({ mode: '', sessionId: '', sender: '', messageType: 'Signal', macpVersion: '' }));

    const span = onlySpan();
    expect(span.name).toBe('send');
    expect(span.attributes).not.toHaveProperty('macp.mode.id');
    expect(span.attributes).not.toHaveProperty('macp.session.id');
    expect(span.attributes).not.toHaveProperty('macp.sender.id');
    // Recommended attributes carry nothing when empty, so they're omitted.
    expect(span.attributes).not.toHaveProperty('macp.version');
    expect(span.attributes['macp.message.type']).toBe('Signal');
  });

  it('otel_send_span_nack_rejected_status_unset', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: false, error: { code: 'SESSION_NOT_OPEN', message: 'closed' } } });

    const error = await caught(client.send(vote()));
    expect(error).toBeInstanceOf(MacpAckError);

    const span = onlySpan();
    expect(span.attributes['macp.envelope.outcome']).toBe('rejected');
    expect(span.attributes['error.type']).toBe('SESSION_NOT_OPEN');
    // A rejection is a protocol outcome, not a failure: status stays UNSET.
    expect(span.status.code).toBe(otel.SpanStatusCode.UNSET);
    expect(span.status.message).toBeUndefined();
  });

  it('records a NACK as rejected when raiseOnNack is false, without throwing', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: false, error: { code: 'POLICY_DENIED', message: 'no' } } });

    const ack = await client.send(vote(), { raiseOnNack: false });

    expect(ack.ok).toBe(false);
    const span = onlySpan();
    expect(span.attributes['macp.envelope.outcome']).toBe('rejected');
    expect(span.attributes['error.type']).toBe('POLICY_DENIED');
    expect(span.status.code).toBe(otel.SpanStatusCode.UNSET);
  });

  it.each([
    ['no error object', { ok: false }],
    ['an empty code', { ok: false, error: { code: '', message: 'x' } }],
  ])('a NACK with %s records error.type _OTHER', async (_label, ack) => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack });

    await client.send(vote(), { raiseOnNack: false });

    expect(onlySpan().attributes['error.type']).toBe('_OTHER');
  });

  it('otel_send_span_coded_status_rejected', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', grpcError(grpc.status.PERMISSION_DENIED, 'POLICY_DENIED'), { fail: true });

    const error = await caught(client.send(vote()));
    expect(error).toBeInstanceOf(MacpAckError);

    const span = onlySpan();
    expect(span.attributes['macp.envelope.outcome']).toBe('rejected');
    expect(span.attributes['error.type']).toBe('POLICY_DENIED');
    expect(span.status.code).toBe(otel.SpanStatusCode.UNSET);
  });

  it.each([
    ['ALREADY_EXISTS', grpc.status.ALREADY_EXISTS, 'SESSION_ALREADY_EXISTS'],
    ['FAILED_PRECONDITION', grpc.status.FAILED_PRECONDITION, 'POLICY_DENIED'],
  ])('a pre-0.9 uncoded %s status is rejected with the fallback code %s', async (_name, status, code) => {
    const client = makeClient();
    stubUnary(client, 'Send', grpcError(status), { fail: true });

    const error = await caught(client.send(vote()));
    expect((error as MacpAckError).failure.code).toBe(code);

    const span = onlySpan();
    expect(span.attributes['macp.envelope.outcome']).toBe('rejected');
    expect(span.attributes['error.type']).toBe(code);
    expect(span.status.code).toBe(otel.SpanStatusCode.UNSET);
  });

  it('otel_send_span_transport_failure_error_status', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', grpcError(grpc.status.UNAVAILABLE), { fail: true });

    const error = await caught(client.send(vote()));
    expect(error).toBeInstanceOf(MacpTransportError);

    const span = onlySpan();
    expect(span.attributes).not.toHaveProperty('macp.envelope.outcome');
    expect(span.attributes['error.type']).toBe('UNAVAILABLE');
    expect(span.status).toEqual({ code: otel.SpanStatusCode.ERROR, message: 'UNAVAILABLE' });
  });

  it('a deadline is a transport failure with error.type DEADLINE_EXCEEDED', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'Send', grpcError(grpc.status.DEADLINE_EXCEEDED), { fail: true });

    await caught(client.send(vote(), { deadlineMs: 50 }));

    expect(calls[0]!.extras.some((e) => typeof e === 'object' && e !== null && 'deadline' in e)).toBe(true);
    const span = onlySpan();
    expect(span.attributes['error.type']).toBe('DEADLINE_EXCEEDED');
    expect(span.status).toEqual({ code: otel.SpanStatusCode.ERROR, message: 'DEADLINE_EXCEEDED' });
  });

  it('an error with no gRPC status records error.type _OTHER', async () => {
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    grpcClient.Send = () => {
      throw Object.assign(new Error('socket exploded'), { code: 'ERR_SOCKET' });
    };

    await caught(client.send(vote()));

    const span = onlySpan();
    expect(span.attributes['error.type']).toBe('_OTHER');
    expect(span.status).toEqual({ code: otel.SpanStatusCode.ERROR, message: '_OTHER' });
  });

  it('otel_send_span_duplicate_outcome', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: true, duplicate: true } });

    await client.send(vote());

    const span = onlySpan();
    expect(span.attributes['macp.envelope.outcome']).toBe('duplicate');
    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.status.code).toBe(otel.SpanStatusCode.UNSET);
  });

  it('otel_no_payload_or_reason_recorded', async () => {
    const secrets = ['REASON-7f3a', 'RATIONALE-91bc', 'NACK-MESSAGE-44de', 'TRANSPORT-DETAIL-0c2e'];
    const payload = Buffer.from(JSON.stringify({ reason: secrets[0], rationale: secrets[1] }));
    const client = makeClient();

    stubUnary(client, 'Send', { ack: { ok: false, error: { code: 'POLICY_DENIED', message: secrets[2] } } });
    await caught(client.send(vote({ payload })));
    stubUnary(client, 'Send', grpcError(grpc.status.PERMISSION_DENIED, 'POLICY_DENIED', secrets[2]), { fail: true });
    await caught(client.send(vote({ payload })));
    stubUnary(client, 'Send', grpcError(grpc.status.UNAVAILABLE, undefined, secrets[3]), { fail: true });
    await caught(client.send(vote({ payload })));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      // No recordException: an exception event would carry the message.
      expect(span.events).toEqual([]);
      expect(span.links).toEqual([]);
      const recorded = JSON.stringify({ name: span.name, attributes: span.attributes, status: span.status });
      for (const secret of secrets) expect(recorded).not.toContain(secret);
    }
  });

  it('starts no span when the call never reaches the wire', async () => {
    const bare = makeBareClient();
    await expect(bare.send(vote())).rejects.toThrow(MacpSdkError);
    const badToken = makeClient(Auth.bearer(''));
    await expect(badToken.send(vote())).rejects.toThrow('bearerToken is required');

    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('retrySend emits one span per attempt', async () => {
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    let attempt = 0;
    grpcClient.Send = (...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: unknown, res?: unknown) => void;
      attempt += 1;
      if (attempt === 1) callback(grpcError(grpc.status.UNAVAILABLE));
      else callback(null, { ack: { ok: true } });
    };

    await retrySend(client, vote(), { policy: { maxRetries: 2, backoffBase: 0.001, backoffMax: 0.001 } });

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.attributes['error.type'] ?? s.attributes['macp.envelope.outcome'])).toEqual([
      'UNAVAILABLE',
      'accepted',
    ]);
  });

  it('a throwing tracer never fails send()', async () => {
    const broken = {
      ...otel,
      trace: {
        ...otel.trace,
        getTracer: () => {
          throw new Error('tracer exploded');
        },
      },
    } as unknown as typeof otel;
    setOtelApiForTesting(broken);
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: true } });

    await expect(client.send(vote())).resolves.toEqual({ ok: true });
  });

  it('a span whose methods throw never fails send()', async () => {
    const explodingSpan = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('span exploded');
        },
      },
    );
    const broken = {
      ...otel,
      trace: { ...otel.trace, getTracer: () => ({ startSpan: () => explodingSpan }) },
    } as unknown as typeof otel;
    setOtelApiForTesting(broken);
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: false, error: { code: 'POLICY_DENIED', message: 'no' } } });

    const error = await caught(client.send(vote()));
    // The caller still sees exactly the SDK's own error.
    expect(error).toBeInstanceOf(MacpAckError);
  });
});

describe('send span against the vendored semconv', () => {
  const semconv = JSON.parse(readFileSync(path.join(__dirname, '..', 'otel', 'macp-semconv.json'), 'utf-8')) as {
    groups: Array<{ id: string; span_kind?: string; span_name?: string; attributes?: Array<{ ref?: string }> }>;
  };
  const group = semconv.groups.find((g) => g.id === 'span.macp.send')!;
  const allowed = new Set(group.attributes!.map((a) => a.ref));

  it('emits only attributes the span.macp.send group defines, with its kind and name', async () => {
    expect(group.span_kind).toBe('client');
    expect(group.span_name).toBe('send {macp.mode.id}');
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: true } });
    await client.send(vote());
    stubUnary(client, 'Send', { ack: { ok: false, error: { code: 'POLICY_DENIED', message: 'no' } } });
    await caught(client.send(vote()));
    stubUnary(client, 'Send', grpcError(grpc.status.UNAVAILABLE), { fail: true });
    await caught(client.send(vote()));

    const emitted = new Set(exporter.getFinishedSpans().flatMap((span) => Object.keys(span.attributes)));
    for (const key of emitted) expect(allowed, key).toContain(key);
    // Every attribute the group defines is emitted on some path.
    expect([...allowed].sort()).toEqual([...emitted].sort());
  });
});

describe('trace context propagation', () => {
  it('otel_traceparent_injected_in_metadata', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'Send', { ack: { ok: true } });
    const parent = tracer.startSpan('parent');
    const parentContext = otel.trace.setSpan(otel.context.active(), parent);

    await otel.context.with(parentContext, () => client.send(vote()));
    parent.end();

    const metadata = metadataOf(calls[0]!.extras)!;
    const [traceparent] = metadata.get('traceparent') as string[];
    const match = TRACEPARENT.exec(traceparent!);
    expect(match).not.toBeNull();
    const send = exporter.getFinishedSpans().find((s) => s.name.startsWith('send'))!;
    // On Send, the injected context is the send span's own.
    expect(match![1]).toBe(send.spanContext().traceId);
    expect(match![2]).toBe(send.spanContext().spanId);
    expect(match![3]).toBe('01');
    expect(match![1]).toBe(parent.spanContext().traceId);
    // Only the W3C headers: no baggage, whatever the global propagator does.
    expect(metadata.get('baggage')).toEqual([]);
    expect(metadata.get('authorization')).toEqual(['Bearer alice-token']);
  });

  it('the send span is active during the call, so a transport client span is its child', async () => {
    const client = makeClient();
    let activeDuringCall: string | undefined;
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    grpcClient.Send = (...args: unknown[]) => {
      activeDuringCall = otel.trace.getSpan(otel.context.active())?.spanContext().spanId;
      (args[args.length - 1] as (e: unknown, r: unknown) => void)(null, { ack: { ok: true } });
    };

    await client.send(vote());

    expect(activeDuringCall).toBe(onlySpan().spanContext().spanId);
    // Restored afterwards.
    expect(otel.trace.getSpan(otel.context.active())).toBeUndefined();
  });

  it('a context manager that throws falls back to a plain call, made exactly once', async () => {
    const broken = {
      ...otel,
      context: {
        ...otel.context,
        active: () => otel.context.active(),
        with: () => {
          throw new Error('context manager exploded');
        },
      },
    } as unknown as typeof otel;
    setOtelApiForTesting(broken);
    const client = makeClient();
    const calls = stubUnary(client, 'Send', { ack: { ok: true } });

    await expect(client.send(vote())).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it('a context manager that throws after the call returns the real result', async () => {
    const broken = {
      ...otel,
      context: {
        ...otel.context,
        active: () => otel.context.active(),
        with: (_ctx: unknown, fn: () => unknown) => {
          fn();
          throw new Error('context manager exploded on exit');
        },
      },
    } as unknown as typeof otel;
    setOtelApiForTesting(broken);
    const client = makeClient();
    const calls = stubUnary(client, 'Send', { ack: { ok: true } });

    await expect(client.send(vote())).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(onlySpan().attributes['macp.envelope.outcome']).toBe('accepted');
  });

  it('with the API installed but no provider, Send records nothing and forwards the parent context', async () => {
    const noProvider = {
      ...otel,
      trace: { ...otel.trace, getTracer: () => new otel.ProxyTracerProvider().getTracer('none') },
    } as unknown as typeof otel;
    const parent = tracer.startSpan('parent');
    setOtelApiForTesting(noProvider);
    const client = makeClient();
    const calls = stubUnary(client, 'Send', { ack: { ok: true } });

    await otel.context.with(otel.trace.setSpan(otel.ROOT_CONTEXT, parent), () => client.send(vote()));
    parent.end();

    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['parent']);
    const { traceId, spanId } = parent.spanContext();
    expect(metadataOf(calls[0]!.extras)!.get('traceparent')).toEqual([`00-${traceId}-${spanId}-01`]);
  });

  it('a Send that resolves with no response still ends its span', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', undefined);

    await expect(client.send(vote())).rejects.toBeInstanceOf(MacpAckError);

    const span = onlySpan();
    expect(span.attributes['macp.envelope.outcome']).toBe('rejected');
    expect(span.attributes['error.type']).toBe('_OTHER');
  });

  it('other RPCs carry the active span context, with no auth required', async () => {
    const parent = tracer.startSpan('parent');
    const traceState = otel.createTraceState('vendor=abc,other=1');
    const spanContext = { ...parent.spanContext(), traceState, traceFlags: otel.TraceFlags.NONE };
    const active = otel.trace.setSpanContext(otel.ROOT_CONTEXT, spanContext);
    const client = makeBareClient();
    const calls = stubUnary(client, 'GetManifest', { manifest: {} });

    await otel.context.with(active, () => client.getManifest());

    const metadata = metadataOf(calls[0]!.extras)!;
    expect(metadata).toBeInstanceOf(grpc.Metadata);
    expect(metadata.get('traceparent')).toEqual([`00-${spanContext.traceId}-${spanContext.spanId}-00`]);
    expect(metadata.get('tracestate')).toEqual(['vendor=abc,other=1']);
    expect(metadata.get('authorization')).toEqual([]);
    parent.end();
  });

  it('writes no trace keys without a valid active span context', async () => {
    const client = makeBareClient();
    const calls = stubUnary(client, 'GetManifest', { manifest: {} });
    const invalid = otel.trace.setSpanContext(otel.ROOT_CONTEXT, otel.INVALID_SPAN_CONTEXT);

    await client.getManifest();
    await otel.context.with(invalid, () => client.getManifest());

    // Same (req, cb) shape as without OpenTelemetry.
    expect(calls.map((c) => c.extras)).toEqual([[], []]);
  });

  it('stream factories and watchSignals carry the context too', () => {
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const seen: Record<string, grpc.Metadata> = {};
    for (const name of ['StreamSession', 'WatchSignals', 'WatchSessions']) {
      grpcClient[name] = (...args: unknown[]) => {
        seen[name] = metadataOf(args)!;
        return { on: () => undefined };
      };
    }
    const parent = tracer.startSpan('parent');
    const active = otel.trace.setSpan(otel.ROOT_CONTEXT, parent);

    otel.context.with(active, () => {
      client.openStream();
      client.watchSignals();
      client.watchSessions();
    });
    parent.end();

    const expected = `00-${parent.spanContext().traceId}-${parent.spanContext().spanId}-01`;
    for (const name of ['StreamSession', 'WatchSignals', 'WatchSessions']) {
      expect(seen[name]!.get('traceparent'), name).toEqual([expected]);
      expect(seen[name]!.get('authorization'), name).toEqual(['Bearer alice-token']);
    }
  });
});

describe('without @opentelemetry/api', () => {
  it('send and metadata behave as before when the API is absent (in process)', async () => {
    setOtelApiForTesting(null);
    const client = makeClient();
    const calls = stubUnary(client, 'Send', { ack: { ok: true } });
    const bare = makeBareClient();
    const manifestCalls = stubUnary(bare, 'GetManifest', { manifest: {} });
    const active = otel.trace.setSpan(otel.ROOT_CONTEXT, tracer.startSpan('parent'));

    await otel.context.with(active, async () => {
      await client.send(vote());
      await bare.getManifest();
    });

    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(metadataOf(calls[0]!.extras)!.get('traceparent')).toEqual([]);
    expect(manifestCalls[0]!.extras).toEqual([]);
  });

  it('otel_absent_no_import', () => {
    // A real child process with every @opentelemetry/* specifier made
    // unresolvable (helpers/block-otel.cjs), exactly as when the optional
    // peer isn't installed — the in-process seam can't prove what require()
    // does. A second, unblocked child proves nothing loads at import.
    const run = (preload: boolean) => {
      const result = spawnSync(
        process.execPath,
        [
          ...(preload ? ['--require', path.join(__dirname, 'helpers', 'block-otel.cjs')] : []),
          '--import',
          'tsx',
          path.join(__dirname, 'helpers', 'otel-child.ts'),
        ],
        { encoding: 'utf-8', timeout: 30_000, cwd: path.join(__dirname, '..', '..') },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as {
        afterImport: string[];
        afterConstruct: string[];
        afterCalls: number;
        requireCalls: number | null;
        calls: unknown[][];
        ack: unknown;
      };
    };

    const absent = run(true);
    // Nothing emitted, no metadata added, nothing thrown.
    expect(absent.afterCalls).toBe(0);
    expect(absent.calls).toEqual([[], [], [{ authorization: 'Bearer t' }]]);
    expect(absent.ack).toEqual({ ok: true });
    // Three RPCs, one require attempt: the failure is memoized.
    expect(absent.requireCalls).toBe(1);

    const installed = run(false);
    // Installed, yet never loaded by importing the SDK or building a client.
    expect(installed.afterImport).toEqual([]);
    expect(installed.afterConstruct).toEqual([]);
    expect(installed.afterCalls).toBeGreaterThan(0);
  }, 60_000);
});
