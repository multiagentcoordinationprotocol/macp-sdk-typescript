/**
 * OpenTelemetry send spans and trace propagation against a live MACP runtime
 * (W5 S2). The unit suite (tests/unit/otel.test.ts) pins the span contract
 * against a stubbed transport; this proves the real wire: the runtime accepts
 * Send/Initialize calls carrying `traceparent`/`tracestate` metadata, and
 * real accepted and rejected Acks/statuses are classified as agreed.
 *
 * Its own file so the global tracer provider and context manager it registers
 * never reach runtime.test.ts (Vitest isolates files).
 */
import * as otel from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Auth, DecisionSession, MacpAckError, MacpClient } from '../../src/index';

const RUNTIME_ADDRESS = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';
const DECISION = 'macp.mode.decision.v1';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();
let client: MacpClient;

beforeAll(() => {
  otel.trace.setGlobalTracerProvider(provider);
  otel.context.setGlobalContextManager(contextManager.enable());
  client = new MacpClient({
    address: RUNTIME_ADDRESS,
    secure: false,
    allowInsecure: true,
    auth: Auth.devAgent('alice'),
  });
});

afterEach(() => {
  exporter.reset();
});

afterAll(() => {
  client.close();
  otel.trace.disable();
  otel.context.disable();
});

describe('OpenTelemetry against a live runtime', () => {
  it('accepted and rejected sends produce the agreed spans, under the caller trace', async () => {
    const parent = provider.getTracer('test').startSpan('workflow');
    const active = otel.trace.setSpan(otel.ROOT_CONTEXT, parent);
    const session = new DecisionSession(client, { auth: Auth.devAgent('alice') });
    const start = {
      intent: 'otel integration',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
      sender: 'alice',
    };

    await otel.context.with(active, async () => {
      // Every RPC here carries traceparent (and Initialize carries it
      // without a send span): the runtime must accept the metadata.
      await client.initialize(5000);
      expect((await session.start(start)).ok).toBe(true);
      // The same session again: the runtime refuses it, as a NACK Ack or a
      // coded gRPC status depending on version — either way a rejection.
      const again = new DecisionSession(client, { auth: Auth.devAgent('alice'), sessionId: session.sessionId });
      await expect(again.start(start)).rejects.toBeInstanceOf(MacpAckError);
    });
    parent.end();

    const sends = exporter.getFinishedSpans().filter((s) => s.name.startsWith('send'));
    expect(sends.map((s) => s.name)).toEqual([`send ${DECISION}`, `send ${DECISION}`]);
    const [accepted, rejected] = sends;

    expect(accepted!.kind).toBe(otel.SpanKind.CLIENT);
    expect(accepted!.attributes['macp.envelope.outcome']).toBe('accepted');
    expect(accepted!.attributes['macp.session.id']).toBe(session.sessionId);
    expect(accepted!.attributes['macp.message.type']).toBe('SessionStart');
    expect(accepted!.status.code).toBe(otel.SpanStatusCode.UNSET);

    expect(rejected!.attributes['macp.envelope.outcome']).toBe('rejected');
    expect(typeof rejected!.attributes['error.type']).toBe('string');
    expect(rejected!.attributes['error.type']).not.toBe('_OTHER');
    expect(rejected!.status.code).toBe(otel.SpanStatusCode.UNSET);

    for (const span of sends) {
      expect(span.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(span.events).toEqual([]);
    }
  });
});
