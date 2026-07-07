import type * as grpc from '@grpc/grpc-js';
import type { AuthConfig } from './auth';
import { grpcStatusName, type MacpClient } from './client';
import { MacpTransportError } from './errors';
import type {
  Envelope,
  PolicyDescriptor,
  RegistryChanged,
  RootsChanged,
  SessionLifecycleEvent,
  SessionLifecycleEventType,
} from './types';

/**
 * The lifecycle event types after which a session emits no further events.
 * `EVENT_TYPE_CANCELLED` (proto 0.1.3) is terminal alongside `RESOLVED` and
 * `EXPIRED`; `SUSPENDED` / `RESUMED` are non-terminal. Parity with python-sdk
 * `SessionLifecycle.is_terminal`.
 */
export const TERMINAL_SESSION_LIFECYCLE_EVENT_TYPES: readonly SessionLifecycleEventType[] = [
  'EVENT_TYPE_RESOLVED',
  'EVENT_TYPE_EXPIRED',
  'EVENT_TYPE_CANCELLED',
];

type LifecycleEventOrType = SessionLifecycleEvent | SessionLifecycleEventType;

function lifecycleEventType(e: LifecycleEventOrType): SessionLifecycleEventType {
  return typeof e === 'string' ? e : e.eventType;
}

/**
 * Predicates over a {@link SessionLifecycleEvent} (or a bare
 * {@link SessionLifecycleEventType}), mirroring python-sdk's `SessionLifecycle`
 * properties so consumers can classify lifecycle events without re-deriving the
 * proto enum strings. {@link isTerminalSessionLifecycleEvent} deliberately
 * includes `EVENT_TYPE_CANCELLED`.
 */
export const isSessionCreated = (e: LifecycleEventOrType): boolean => lifecycleEventType(e) === 'EVENT_TYPE_CREATED';
export const isSessionResolved = (e: LifecycleEventOrType): boolean => lifecycleEventType(e) === 'EVENT_TYPE_RESOLVED';
export const isSessionExpired = (e: LifecycleEventOrType): boolean => lifecycleEventType(e) === 'EVENT_TYPE_EXPIRED';
export const isSessionCancelled = (e: LifecycleEventOrType): boolean =>
  lifecycleEventType(e) === 'EVENT_TYPE_CANCELLED';
export const isSessionSuspended = (e: LifecycleEventOrType): boolean =>
  lifecycleEventType(e) === 'EVENT_TYPE_SUSPENDED';
export const isSessionResumed = (e: LifecycleEventOrType): boolean => lifecycleEventType(e) === 'EVENT_TYPE_RESUMED';
export const isTerminalSessionLifecycleEvent = (e: LifecycleEventOrType): boolean =>
  TERMINAL_SESSION_LIFECYCLE_EVENT_TYPES.includes(lifecycleEventType(e));

function serverStreamToAsyncGenerator<T>(stream: grpc.ClientReadableStream<T>): AsyncGenerator<T, void, void> {
  const queue: Array<{ value: T } | { error: Error } | { done: true }> = [];
  let resolve: ((value: void) => void) | null = null;

  stream.on('data', (data: T) => {
    queue.push({ value: data });
    if (resolve) {
      resolve();
      resolve = null;
    }
  });
  stream.on('error', (error: Error) => {
    // Wrap the raw gRPC ServiceError into a coded MacpTransportError so
    // consumers can branch on `.code`: consumer lag terminates a watch stream
    // with RESOURCE_EXHAUSTED (reconnect + re-sync), an unauthenticated
    // WatchSignals with UNAUTHENTICATED (fix auth, do NOT reconnect).
    const code = grpcStatusName((error as grpc.ServiceError).code);
    const serviceErr = error as grpc.ServiceError;
    const wrapped = new MacpTransportError(serviceErr.details || error.message, code);
    queue.push({ error: wrapped });
    if (resolve) {
      resolve();
      resolve = null;
    }
  });
  stream.on('end', () => {
    queue.push({ done: true });
    if (resolve) {
      resolve();
      resolve = null;
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<T, void>> {
      while (true) {
        const item = queue.shift();
        if (item) {
          if ('done' in item) return { value: undefined, done: true };
          if ('error' in item) throw item.error;
          return { value: item.value, done: false };
        }
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    },
    async return(): Promise<IteratorResult<T, void>> {
      stream.cancel();
      return { value: undefined, done: true };
    },
    async throw(err: Error): Promise<IteratorResult<T, void>> {
      stream.cancel();
      throw err;
    },
  };
}

export class ModeRegistryWatcher {
  private readonly client: MacpClient;
  private readonly auth?: AuthConfig;

  constructor(client: MacpClient, options?: { auth?: AuthConfig }) {
    this.client = client;
    this.auth = options?.auth;
  }

  async *changes(signal?: AbortSignal): AsyncGenerator<RegistryChanged, void, void> {
    const stream = this.client.watchModeRegistry(this.auth) as grpc.ClientReadableStream<RegistryChanged>;
    if (signal) {
      signal.addEventListener('abort', () => stream.cancel(), { once: true });
    }
    yield* serverStreamToAsyncGenerator(stream);
  }

  async watch(handler: (change: RegistryChanged) => void | Promise<void>): Promise<void> {
    for await (const change of this.changes()) {
      await handler(change);
    }
  }

  async nextChange(): Promise<RegistryChanged> {
    const gen = this.changes();
    const result = await gen.next();
    await gen.return(undefined as never);
    if (result.done) throw new Error('stream ended before receiving a change');
    return result.value;
  }
}

export class RootsWatcher {
  private readonly client: MacpClient;
  private readonly auth?: AuthConfig;

  constructor(client: MacpClient, options?: { auth?: AuthConfig }) {
    this.client = client;
    this.auth = options?.auth;
  }

  async *changes(signal?: AbortSignal): AsyncGenerator<RootsChanged, void, void> {
    const stream = this.client.watchRoots(this.auth) as grpc.ClientReadableStream<RootsChanged>;
    if (signal) {
      signal.addEventListener('abort', () => stream.cancel(), { once: true });
    }
    yield* serverStreamToAsyncGenerator(stream);
  }

  async watch(handler: (change: RootsChanged) => void | Promise<void>): Promise<void> {
    for await (const change of this.changes()) {
      await handler(change);
    }
  }

  async nextChange(): Promise<RootsChanged> {
    const gen = this.changes();
    const result = await gen.next();
    await gen.return(undefined as never);
    if (result.done) throw new Error('stream ended before receiving a change');
    return result.value;
  }
}

/**
 * Watches the ambient signal plane. **Requires auth** as of runtime 0.5.0: if
 * no credential is configured on the watcher or the client, iterating
 * {@link SignalWatcher.signals} throws immediately (via `client.watchSignals`).
 *
 * Consumer lag terminates the stream with a coded `MacpTransportError`
 * (`code === 'RESOURCE_EXHAUSTED'`); the correct response is to reconnect.
 * A missing/invalid credential surfaces as `code === 'UNAUTHENTICATED'` — fix
 * auth, do not reconnect.
 */
export class SignalWatcher {
  private readonly client: MacpClient;
  private readonly auth?: AuthConfig;

  constructor(client: MacpClient, options?: { auth?: AuthConfig }) {
    this.client = client;
    this.auth = options?.auth;
  }

  async *signals(signal?: AbortSignal): AsyncGenerator<Envelope, void, void> {
    const stream = this.client.watchSignals(this.auth) as grpc.ClientReadableStream<{ envelope?: Envelope }>;
    if (signal) {
      signal.addEventListener('abort', () => stream.cancel(), { once: true });
    }
    const gen = serverStreamToAsyncGenerator(stream);
    for await (const response of gen) {
      if (response.envelope) yield response.envelope;
    }
  }

  async watch(handler: (envelope: Envelope) => void | Promise<void>): Promise<void> {
    for await (const envelope of this.signals()) {
      await handler(envelope);
    }
  }

  async nextSignal(): Promise<Envelope> {
    const gen = this.signals();
    const result = await gen.next();
    await gen.return(undefined as never);
    if (result.done) throw new Error('stream ended before receiving a signal');
    return result.value;
  }
}

export interface PolicyChange {
  descriptors: PolicyDescriptor[];
  observedAtUnixMs: number;
}

export class PolicyWatcher {
  private readonly client: MacpClient;
  private readonly auth?: AuthConfig;

  constructor(client: MacpClient, options?: { auth?: AuthConfig }) {
    this.client = client;
    this.auth = options?.auth;
  }

  async *changes(signal?: AbortSignal): AsyncGenerator<PolicyChange, void, void> {
    const stream = this.client.watchPolicies(this.auth) as grpc.ClientReadableStream<PolicyChange>;
    if (signal) {
      signal.addEventListener('abort', () => stream.cancel(), { once: true });
    }
    yield* serverStreamToAsyncGenerator(stream);
  }

  async watch(handler: (change: PolicyChange) => void | Promise<void>): Promise<void> {
    for await (const change of this.changes()) {
      await handler(change);
    }
  }

  async nextChange(): Promise<PolicyChange> {
    const gen = this.changes();
    const result = await gen.next();
    await gen.return(undefined as never);
    if (result.done) throw new Error('stream ended before receiving a policy change');
    return result.value;
  }
}

/**
 * Watches session lifecycle events (`WatchSessions`). Consumer lag terminates
 * the stream with a coded `MacpTransportError` (`code === 'RESOURCE_EXHAUSTED'`);
 * the correct response is to reconnect and re-sync current state via
 * {@link MacpClient.listSessions}, since events emitted during the gap are lost.
 */
export class SessionLifecycleWatcher {
  private readonly client: MacpClient;
  private readonly auth?: AuthConfig;

  constructor(client: MacpClient, options?: { auth?: AuthConfig }) {
    this.client = client;
    this.auth = options?.auth;
  }

  async *changes(signal?: AbortSignal): AsyncGenerator<SessionLifecycleEvent, void, void> {
    const stream = this.client.watchSessions(this.auth) as grpc.ClientReadableStream<{ event?: SessionLifecycleEvent }>;
    if (signal) {
      signal.addEventListener('abort', () => stream.cancel(), { once: true });
    }
    const gen = serverStreamToAsyncGenerator(stream);
    for await (const response of gen) {
      if (response.event) yield response.event;
    }
  }

  async watch(handler: (event: SessionLifecycleEvent) => void | Promise<void>): Promise<void> {
    for await (const event of this.changes()) {
      await handler(event);
    }
  }

  async nextChange(): Promise<SessionLifecycleEvent> {
    const gen = this.changes();
    const result = await gen.next();
    await gen.return(undefined as never);
    if (result.done) throw new Error('stream ended before receiving a session lifecycle event');
    return result.value;
  }
}
