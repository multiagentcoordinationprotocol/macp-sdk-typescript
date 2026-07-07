import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MacpClient } from '../../src/client';
import {
  ModeRegistryWatcher,
  PolicyWatcher,
  RootsWatcher,
  SessionLifecycleWatcher,
  SignalWatcher,
  TERMINAL_SESSION_LIFECYCLE_EVENT_TYPES,
  isSessionCancelled,
  isSessionCreated,
  isSessionExpired,
  isSessionResolved,
  isSessionResumed,
  isSessionSuspended,
  isTerminalSessionLifecycleEvent,
} from '../../src/watchers';
import type { SessionLifecycleEvent } from '../../src/types';

/**
 * Fake gRPC readable stream: an EventEmitter with a .cancel() method.
 * Drives the async-generator-adapter in src/watchers.ts without any network.
 */
class FakeReadableStream extends EventEmitter {
  cancel = vi.fn();
  emitData<T>(value: T): void {
    this.emit('data', value);
  }
  emitError(err: Error): void {
    this.emit('error', err);
  }
  emitEnd(): void {
    this.emit('end');
  }
}

function makeClientWith(method: string, stream: FakeReadableStream): MacpClient {
  const stub = vi.fn().mockReturnValue(stream);
  return { [method]: stub } as unknown as MacpClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModeRegistryWatcher', () => {
  it('yields a RegistryChanged then returns on end', async () => {
    const stream = new FakeReadableStream();
    const watcher = new ModeRegistryWatcher(makeClientWith('watchModeRegistry', stream));

    const iter = watcher.changes();
    const next = iter.next();

    stream.emitData({ observedAtUnixMs: 100 });
    const first = await next;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ observedAtUnixMs: 100 });

    stream.emitEnd();
    const done = await iter.next();
    expect(done.done).toBe(true);
  });

  it('propagates stream errors through the async generator', async () => {
    const stream = new FakeReadableStream();
    const watcher = new ModeRegistryWatcher(makeClientWith('watchModeRegistry', stream));

    const iter = watcher.changes();
    const next = iter.next();
    stream.emitError(new Error('boom'));
    await expect(next).rejects.toThrow('boom');
  });

  it('cancels the underlying stream when the AbortSignal fires', async () => {
    const stream = new FakeReadableStream();
    const watcher = new ModeRegistryWatcher(makeClientWith('watchModeRegistry', stream));
    const controller = new AbortController();

    const iter = watcher.changes(controller.signal);
    // Prime the consumer so the generator subscribes.
    const pending = iter.next();
    controller.abort();

    expect(stream.cancel).toHaveBeenCalledTimes(1);

    // Clean up the pending promise so vitest doesn't warn about a dangling promise.
    stream.emitEnd();
    await pending;
  });

  it('nextChange returns exactly the first change and then cancels', async () => {
    const stream = new FakeReadableStream();
    const watcher = new ModeRegistryWatcher(makeClientWith('watchModeRegistry', stream));

    const pending = watcher.nextChange();
    stream.emitData({ observedAtUnixMs: 42 });
    const change = await pending;
    expect(change).toEqual({ observedAtUnixMs: 42 });
    // Generator.return() is invoked via nextChange → triggers stream.cancel().
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('nextChange throws if the stream ends before a change arrives', async () => {
    const stream = new FakeReadableStream();
    const watcher = new ModeRegistryWatcher(makeClientWith('watchModeRegistry', stream));

    const pending = watcher.nextChange();
    stream.emitEnd();
    await expect(pending).rejects.toThrow('stream ended before receiving a change');
  });

  it('watch() drives the handler for each change', async () => {
    const stream = new FakeReadableStream();
    const watcher = new ModeRegistryWatcher(makeClientWith('watchModeRegistry', stream));
    const seen: number[] = [];

    const promise = watcher.watch((change) => {
      seen.push(change.observedAtUnixMs);
    });

    stream.emitData({ observedAtUnixMs: 1 });
    stream.emitData({ observedAtUnixMs: 2 });
    stream.emitEnd();
    await promise;

    expect(seen).toEqual([1, 2]);
  });
});

describe('RootsWatcher', () => {
  it('yields a RootsChanged payload then returns on end', async () => {
    const stream = new FakeReadableStream();
    const watcher = new RootsWatcher(makeClientWith('watchRoots', stream));

    const iter = watcher.changes();
    const pending = iter.next();
    stream.emitData({ roots: [{ uri: 'file:///x', name: 'x' }], observedAtUnixMs: 10 });
    const first = await pending;
    expect(first.value).toMatchObject({ observedAtUnixMs: 10 });

    stream.emitEnd();
    const done = await iter.next();
    expect(done.done).toBe(true);
  });

  it('surfaces transport errors', async () => {
    const stream = new FakeReadableStream();
    const watcher = new RootsWatcher(makeClientWith('watchRoots', stream));
    const pending = watcher.nextChange();
    stream.emitError(new Error('roots-transport'));
    await expect(pending).rejects.toThrow('roots-transport');
  });
});

describe('SignalWatcher', () => {
  it('unwraps envelopes from the wire frame', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SignalWatcher(makeClientWith('watchSignals', stream));

    const iter = watcher.signals();
    const pending = iter.next();
    stream.emitData({ envelope: { mode: '', messageType: 'Signal', messageId: 'm1' } });
    const first = await pending;
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ messageType: 'Signal', messageId: 'm1' });
  });

  it('skips frames that carry no envelope', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SignalWatcher(makeClientWith('watchSignals', stream));

    const iter = watcher.signals();
    const pending = iter.next();
    stream.emitData({}); // no envelope — watcher should not yield
    stream.emitData({ envelope: { mode: '', messageType: 'Signal', messageId: 'm2' } });
    const first = await pending;
    expect(first.value).toMatchObject({ messageId: 'm2' });
  });

  it('nextSignal rejects when the stream ends empty', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SignalWatcher(makeClientWith('watchSignals', stream));

    const pending = watcher.nextSignal();
    stream.emitEnd();
    await expect(pending).rejects.toThrow('stream ended before receiving a signal');
  });
});

describe('PolicyWatcher', () => {
  it('yields PolicyChange snapshots', async () => {
    const stream = new FakeReadableStream();
    const watcher = new PolicyWatcher(makeClientWith('watchPolicies', stream));

    const iter = watcher.changes();
    const pending = iter.next();
    stream.emitData({ descriptors: [{ policyId: 'p1' }], observedAtUnixMs: 5 });
    const first = await pending;
    expect(first.value).toMatchObject({ observedAtUnixMs: 5 });
    expect(first.value?.descriptors?.[0]?.policyId).toBe('p1');
  });

  it('wires the abort signal', async () => {
    const stream = new FakeReadableStream();
    const watcher = new PolicyWatcher(makeClientWith('watchPolicies', stream));
    const controller = new AbortController();

    const iter = watcher.changes(controller.signal);
    const pending = iter.next();
    controller.abort();
    expect(stream.cancel).toHaveBeenCalledTimes(1);

    stream.emitEnd();
    await pending;
  });
});

describe('SessionLifecycleWatcher', () => {
  it('unwraps events from the wire frame', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SessionLifecycleWatcher(makeClientWith('watchSessions', stream));

    const iter = watcher.changes();
    const pending = iter.next();
    stream.emitData({
      event: {
        eventType: 'EVENT_TYPE_CREATED',
        session: { sessionId: 's1', mode: 'macp.mode.decision.v1' },
        observedAtUnixMs: '100',
      },
    });
    const first = await pending;
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      eventType: 'EVENT_TYPE_CREATED',
      session: { sessionId: 's1' },
    });
  });

  it('skips frames that carry no event', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SessionLifecycleWatcher(makeClientWith('watchSessions', stream));

    const iter = watcher.changes();
    const pending = iter.next();
    stream.emitData({}); // no event — watcher should not yield
    stream.emitData({
      event: {
        eventType: 'EVENT_TYPE_RESOLVED',
        session: { sessionId: 's2' },
        observedAtUnixMs: '200',
      },
    });
    const first = await pending;
    expect(first.value).toMatchObject({ eventType: 'EVENT_TYPE_RESOLVED', session: { sessionId: 's2' } });
  });

  it('nextChange rejects when the stream ends empty', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SessionLifecycleWatcher(makeClientWith('watchSessions', stream));

    const pending = watcher.nextChange();
    stream.emitEnd();
    await expect(pending).rejects.toThrow('stream ended before receiving a session lifecycle event');
  });

  it('wires the abort signal', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SessionLifecycleWatcher(makeClientWith('watchSessions', stream));
    const controller = new AbortController();

    const iter = watcher.changes(controller.signal);
    const pending = iter.next();
    controller.abort();
    expect(stream.cancel).toHaveBeenCalledTimes(1);

    stream.emitEnd();
    await pending;
  });

  it('watch() drives the handler for each event', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SessionLifecycleWatcher(makeClientWith('watchSessions', stream));
    const seen: string[] = [];

    const promise = watcher.watch((event) => {
      seen.push(event.eventType);
    });

    stream.emitData({
      event: { eventType: 'EVENT_TYPE_CREATED', session: { sessionId: 's1' }, observedAtUnixMs: '1' },
    });
    stream.emitData({
      event: { eventType: 'EVENT_TYPE_EXPIRED', session: { sessionId: 's1' }, observedAtUnixMs: '2' },
    });
    stream.emitEnd();
    await promise;

    expect(seen).toEqual(['EVENT_TYPE_CREATED', 'EVENT_TYPE_EXPIRED']);
  });

  it('surfaces the proto 0.1.3 suspend/resume/cancel event types verbatim', async () => {
    const stream = new FakeReadableStream();
    const watcher = new SessionLifecycleWatcher(makeClientWith('watchSessions', stream));
    const seen: string[] = [];

    const promise = watcher.watch((event) => {
      seen.push(event.eventType);
    });

    stream.emitData({
      event: { eventType: 'EVENT_TYPE_SUSPENDED', session: { sessionId: 's1' }, observedAtUnixMs: '1' },
    });
    stream.emitData({
      event: { eventType: 'EVENT_TYPE_RESUMED', session: { sessionId: 's1' }, observedAtUnixMs: '2' },
    });
    stream.emitData({
      event: {
        eventType: 'EVENT_TYPE_CANCELLED',
        session: { sessionId: 's1', state: 'SESSION_STATE_CANCELLED' },
        observedAtUnixMs: '3',
      },
    });
    stream.emitEnd();
    await promise;

    expect(seen).toEqual(['EVENT_TYPE_SUSPENDED', 'EVENT_TYPE_RESUMED', 'EVENT_TYPE_CANCELLED']);
  });
});

// ── Lifecycle event predicates (parity with python-sdk SessionLifecycle) ──

describe('session lifecycle predicates', () => {
  const event = (eventType: SessionLifecycleEvent['eventType']): SessionLifecycleEvent => ({
    eventType,
    session: { sessionId: 's1' },
    observedAtUnixMs: '1',
  });

  it('classifies each event type by both event object and bare type', () => {
    expect(isSessionCreated('EVENT_TYPE_CREATED')).toBe(true);
    expect(isSessionCreated(event('EVENT_TYPE_CREATED'))).toBe(true);
    expect(isSessionResolved(event('EVENT_TYPE_RESOLVED'))).toBe(true);
    expect(isSessionExpired(event('EVENT_TYPE_EXPIRED'))).toBe(true);
    expect(isSessionCancelled(event('EVENT_TYPE_CANCELLED'))).toBe(true);
    expect(isSessionSuspended(event('EVENT_TYPE_SUSPENDED'))).toBe(true);
    expect(isSessionResumed(event('EVENT_TYPE_RESUMED'))).toBe(true);
    // negative case
    expect(isSessionCreated('EVENT_TYPE_RESOLVED')).toBe(false);
  });

  it('treats RESOLVED, EXPIRED, and CANCELLED as terminal — and CANCELLED in particular', () => {
    expect(isTerminalSessionLifecycleEvent('EVENT_TYPE_RESOLVED')).toBe(true);
    expect(isTerminalSessionLifecycleEvent('EVENT_TYPE_EXPIRED')).toBe(true);
    expect(isTerminalSessionLifecycleEvent(event('EVENT_TYPE_CANCELLED'))).toBe(true);
    expect(TERMINAL_SESSION_LIFECYCLE_EVENT_TYPES).toContain('EVENT_TYPE_CANCELLED');
  });

  it('treats CREATED, SUSPENDED, and RESUMED as non-terminal', () => {
    expect(isTerminalSessionLifecycleEvent('EVENT_TYPE_CREATED')).toBe(false);
    expect(isTerminalSessionLifecycleEvent('EVENT_TYPE_SUSPENDED')).toBe(false);
    expect(isTerminalSessionLifecycleEvent('EVENT_TYPE_RESUMED')).toBe(false);
  });
});
