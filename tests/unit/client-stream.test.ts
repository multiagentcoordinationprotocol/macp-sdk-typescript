import { EventEmitter } from 'node:events';
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../src/auth';
import { MacpClient, MacpStream } from '../../src/client';
import { MacpSdkError, MacpTimeoutError, MacpTransportError } from '../../src/errors';
import type { Envelope } from '../../src/types';

// ── MacpStream runtime path ─────────────────────────────────────────
//
// The duplex-stream data path (data/error/end events, read()/responses(),
// inline errors, the internal AsyncQueue) was previously exercised only by the
// Docker-gated integration suite. These tests drive it with an EventEmitter
// standing in for the gRPC duplex, so the full unwrap/queue/close behaviour is
// covered in-process.

/**
 * Emitting stand-in for the gRPC duplex: `MacpStream` registers its handlers
 * via `on()`, so an EventEmitter lets tests drive data/error/end. `write` and
 * `end` are spies with a success-callback default.
 */
class FakeDuplex extends EventEmitter {
  write = vi.fn((_frame: unknown, cb?: (err?: Error | null) => void) => {
    cb?.(null);
    return true;
  });
  end = vi.fn();
}

type DuplexCtorArg = ConstructorParameters<typeof MacpStream>[0];

function makeStream(duplex: FakeDuplex): MacpStream {
  return new MacpStream(duplex as unknown as DuplexCtorArg);
}

function makeEnvelope(messageId: string): Envelope {
  return {
    macpVersion: '1.0',
    mode: 'macp.mode.decision.v1',
    messageType: 'Proposal',
    messageId,
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    sender: 'alice',
    timestampUnixMs: '1',
    payload: Buffer.alloc(0),
  };
}

function makeClient(): MacpClient {
  return new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MacpClient.openStream', () => {
  it('throws a clear client-side error when no auth is configured', () => {
    const client = new MacpClient({ address: '127.0.0.1:50051', secure: false, allowInsecure: true });
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const streamSpy = vi.fn();
    grpcClient.StreamSession = streamSpy;

    expect(() => client.openStream()).toThrow(MacpSdkError);
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('opens a StreamSession call with bearer metadata and wraps it in MacpStream', () => {
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const duplex = new FakeDuplex();
    const streamSpy = vi.fn(() => duplex);
    grpcClient.StreamSession = streamSpy;

    const stream = client.openStream();

    expect(stream).toBeInstanceOf(MacpStream);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    const metadata = streamSpy.mock.calls[0]![0] as unknown as grpc.Metadata;
    expect(metadata).toBeInstanceOf(grpc.Metadata);
    expect(metadata.get('authorization')).toEqual(['Bearer alice-token']);
  });

  it('per-call auth overrides the client credential', () => {
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const streamSpy = vi.fn(() => new FakeDuplex());
    grpcClient.StreamSession = streamSpy;

    client.openStream({ auth: Auth.bearer('bob-token') });

    const metadata = streamSpy.mock.calls[0]![0] as unknown as grpc.Metadata;
    expect(metadata.get('authorization')).toEqual(['Bearer bob-token']);
  });
});

describe('MacpStream — data delivery', () => {
  it('delivers the new oneof format (chunk.response.envelope)', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    duplex.emit('data', { response: { envelope } });

    await expect(stream.read()).resolves.toEqual(envelope);
  });

  it('still accepts the legacy format (chunk.envelope)', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    duplex.emit('data', { envelope });

    await expect(stream.read()).resolves.toEqual(envelope);
  });

  it('ignores chunks carrying neither envelope nor error', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    duplex.emit('data', {});
    duplex.emit('data', { response: {} });
    duplex.emit('data', { response: { envelope } });

    // The empty chunks queued nothing; the first read sees the real envelope.
    await expect(stream.read()).resolves.toEqual(envelope);
  });

  it('fires onInlineError callbacks for chunk.response.error and keeps the stream open', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const first = vi.fn();
    const second = vi.fn();
    stream.onInlineError(first);
    stream.onInlineError(second);

    const inlineError = { code: 'POLICY_DENIED', message: 'not allowed' };
    duplex.emit('data', { response: { error: inlineError } });
    const envelope = makeEnvelope('m1');
    duplex.emit('data', { response: { envelope } });

    expect(first).toHaveBeenCalledWith(inlineError);
    expect(second).toHaveBeenCalledWith(inlineError);
    // Stream is still readable after an inline error.
    await expect(stream.read()).resolves.toEqual(envelope);
  });
});

describe('MacpStream — error and end events', () => {
  it("surfaces 'error' as MacpTransportError with the gRPC status name", async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);

    duplex.emit('error', { code: 14, details: 'connection dropped', message: '14 UNAVAILABLE' });

    let caught: unknown;
    try {
      await stream.read();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpTransportError);
    expect((caught as MacpTransportError).code).toBe('UNAVAILABLE');
    expect((caught as MacpTransportError).message).toBe('connection dropped');
  });

  it('falls back to error.message when details is empty', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);

    duplex.emit('error', { code: 16, details: '', message: '16 UNAUTHENTICATED: token expired' });

    let caught: unknown;
    try {
      await stream.read();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpTransportError);
    expect((caught as MacpTransportError).code).toBe('UNAUTHENTICATED');
    expect((caught as MacpTransportError).message).toBe('16 UNAUTHENTICATED: token expired');
  });

  it("read() returns null on 'end' — and null again (STREAM_END is re-pushed)", async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    duplex.emit('data', { response: { envelope } });
    duplex.emit('end');

    await expect(stream.read()).resolves.toEqual(envelope);
    await expect(stream.read()).resolves.toBeNull();
    // The end marker must persist so every later read also observes it.
    await expect(stream.read()).resolves.toBeNull();
  });
});

describe('MacpStream.responses()', () => {
  it('yields queued envelopes in order, then returns on end', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const e1 = makeEnvelope('m1');
    const e2 = makeEnvelope('m2');

    duplex.emit('data', { response: { envelope: e1 } });
    duplex.emit('data', { response: { envelope: e2 } });
    duplex.emit('end');

    const seen: Envelope[] = [];
    for await (const envelope of stream.responses()) seen.push(envelope);
    expect(seen).toEqual([e1, e2]);

    // The end marker was re-pushed, so a second iteration terminates immediately.
    const secondPass: Envelope[] = [];
    for await (const envelope of stream.responses()) secondPass.push(envelope);
    expect(secondPass).toEqual([]);
  });

  it('throws the transport error in-band while iterating', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const e1 = makeEnvelope('m1');

    duplex.emit('data', { response: { envelope: e1 } });
    duplex.emit('error', { code: 14, details: 'gone', message: '14 UNAVAILABLE' });

    const seen: Envelope[] = [];
    let caught: unknown;
    try {
      for await (const envelope of stream.responses()) seen.push(envelope);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([e1]);
    expect(caught).toBeInstanceOf(MacpTransportError);
  });
});

describe('MacpStream.read() timeouts', () => {
  it('blocks until data arrives when no timeout is given', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    const pending = stream.read();
    duplex.emit('data', { response: { envelope } });

    await expect(pending).resolves.toEqual(envelope);
  });

  it('throws MacpTimeoutError when nothing arrives within timeoutMs', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);

    await expect(stream.read(5)).rejects.toBeInstanceOf(MacpTimeoutError);
    await expect(stream.read(5)).rejects.toThrow(/timed out after 5ms/);
  });

  it('does not swallow an envelope that arrives after a timed-out read', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    await expect(stream.read(5)).rejects.toBeInstanceOf(MacpTimeoutError);
    // The timed-out resolver was spliced out of the queue, so the next data
    // event must satisfy the NEXT read, not vanish into the dead resolver.
    duplex.emit('data', { response: { envelope } });
    await expect(stream.read(5)).resolves.toEqual(envelope);
  });

  it('resolves normally when data arrives before the timeout fires', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    const pending = stream.read(1_000);
    duplex.emit('data', { response: { envelope } });

    await expect(pending).resolves.toEqual(envelope);
  });

  it('puts a value back when the resolver fires after the timeout already settled', async () => {
    // White-box: the guarded branch in AsyncQueue.shiftWithTimeout's resolver
    // is unreachable through the event API (the timeout handler splices the
    // resolver out synchronously), so invoke the captured resolver directly to
    // pin the value-is-not-lost contract.
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const queue = (stream as unknown as { queue: { resolvers: Array<(v: unknown) => void>; items: unknown[] } }).queue;
    const envelope = makeEnvelope('m1');

    const pending = stream.read(5);
    const lateResolver = queue.resolvers[0];
    expect(typeof lateResolver).toBe('function');
    await expect(pending).rejects.toBeInstanceOf(MacpTimeoutError);

    lateResolver!(envelope);
    expect(queue.items[0]).toEqual(envelope);
    await expect(stream.read(5)).resolves.toEqual(envelope);
  });
});

describe('MacpStream.send / close', () => {
  it('writes { envelope } and resolves when the write callback succeeds', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);
    const envelope = makeEnvelope('m1');

    await stream.send(envelope);

    expect(duplex.write).toHaveBeenCalledTimes(1);
    expect(duplex.write.mock.calls[0]![0]).toEqual({ envelope });
  });

  it('rejects when the write callback reports an error', async () => {
    const duplex = new FakeDuplex();
    duplex.write.mockImplementation((_frame, cb) => {
      cb?.(new Error('backpressure'));
      return false;
    });
    const stream = makeStream(duplex);

    await expect(stream.send(makeEnvelope('m1'))).rejects.toThrow(/backpressure/);
  });

  it('rejects send() after close without writing', async () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);

    stream.close();

    await expect(stream.send(makeEnvelope('m1'))).rejects.toBeInstanceOf(MacpSdkError);
    expect(duplex.write).not.toHaveBeenCalled();
  });

  it('close() is idempotent — call.end() runs exactly once', () => {
    const duplex = new FakeDuplex();
    const stream = makeStream(duplex);

    stream.close();
    stream.close();

    expect(duplex.end).toHaveBeenCalledTimes(1);
  });
});
