/* eslint-disable @typescript-eslint/no-explicit-any --
 * The gRPC service client returned by `protoLoader.loadSync()` is typed as
 * `any` by `@grpc/proto-loader`; method signatures (Send, StreamSession,
 * WatchModeRegistry, …) are runtime-generated. Narrowing these with hand-rolled
 * interfaces would drift as the proto evolves. This file isolates that `any`
 * boundary — no other file in `src/` should need the rule disabled. See
 * CLAUDE.md (`warnings for \`any\` in gRPC layer are expected`).
 */
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { assertSenderMatchesIdentity, authSender, type AuthConfig, metadataFromAuth } from './auth';
import { buildEnvelope, buildProgressPayload, buildSignalPayload } from './envelope';
import { MacpAckError, MacpSdkError, MacpSessionError, MacpTimeoutError, MacpTransportError } from './errors';
import { ProtoRegistry } from './proto-registry';
import { validateSignalType } from './validation';
import type {
  Ack,
  AgentManifest,
  Envelope,
  InitializeResult,
  ModeDescriptor,
  PolicyDescriptor,
  SessionMetadata,
  Root,
} from './types';

interface MacpClientOptions {
  address: string;
  /**
   * Use TLS credentials. Defaults to `true` per RFC-MACP-0006 §3. Pass
   * `secure: false` together with {@link MacpClientOptions.allowInsecure}
   * `true` for local development against an insecure runtime.
   */
  secure?: boolean;
  /**
   * Opt out of the secure-by-default guard. Must be set to `true` whenever
   * `secure` is `false`; otherwise the constructor throws. Intentionally
   * verbose so agents never ship to production with TLS off by accident.
   */
  allowInsecure?: boolean;
  auth?: AuthConfig;
  rootCertificates?: Buffer;
  defaultDeadlineMs?: number;
  clientName?: string;
  clientVersion?: string;
  protoDir?: string;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: T) => void> = [];

  push(item: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve(item);
    else this.items.push(item);
  }

  unshift(item: T): void {
    this.items.unshift(item);
  }

  shift(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.resolvers.push(resolve));
  }

  shiftWithTimeout(timeoutMs: number): Promise<T | typeof TIMEOUT> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T | typeof TIMEOUT>((resolve) => {
      let settled = false;
      const resolver = (value: T): void => {
        if (settled) {
          // Timeout already fired; put the value back so it isn't lost.
          this.items.unshift(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      this.resolvers.push(resolver);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.resolvers.indexOf(resolver);
        if (idx >= 0) this.resolvers.splice(idx, 1);
        resolve(TIMEOUT);
      }, timeoutMs);
    });
  }
}

/**
 * Map a gRPC `ServiceError.code` (numeric `grpc.status`) to its status name
 * (e.g. `8` → `'RESOURCE_EXHAUSTED'`). Returns `undefined` for non-numeric or
 * unknown codes. Used to populate {@link MacpTransportError.code}.
 */
export function grpcStatusName(code: unknown): string | undefined {
  if (typeof code !== 'number') return undefined;
  const name = (grpc.status as Record<number, string>)[code];
  return typeof name === 'string' ? name : undefined;
}

const TIMEOUT = Symbol('stream-read-timeout');

const STREAM_END = Symbol('stream-end');

type StreamItem = Envelope | Error | typeof STREAM_END;

export type InlineErrorCallback = (error: { code?: string; message?: string }) => void;

export class MacpStream {
  private readonly queue = new AsyncQueue<StreamItem>();
  private closed = false;
  private readonly inlineErrorCallbacks: InlineErrorCallback[] = [];

  constructor(private readonly call: grpc.ClientDuplexStream<any, any>) {
    call.on('data', (chunk: any) => {
      // Support both old format (chunk.envelope) and new oneof format (chunk.response.envelope)
      const envelope = chunk?.response?.envelope ?? chunk?.envelope;
      if (envelope) {
        this.queue.push(envelope);
      } else if (chunk?.response?.error) {
        // Inline application-level error — stream stays open
        for (const cb of this.inlineErrorCallbacks) cb(chunk.response.error);
      }
    });
    call.on('error', (error: grpc.ServiceError) => {
      this.queue.push(new MacpTransportError(error.details || error.message, grpcStatusName(error.code)));
    });
    call.on('end', () => {
      this.queue.push(STREAM_END);
    });
  }

  onInlineError(callback: InlineErrorCallback): void {
    this.inlineErrorCallbacks.push(callback);
  }

  send(envelope: Envelope): Promise<void> {
    if (this.closed) return Promise.reject(new MacpSdkError('stream is already closed'));
    return new Promise<void>((resolve, reject) => {
      this.call.write({ envelope }, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * RFC-MACP-0006 §3.2: Send a subscribe-only frame to receive session history
   * + live broadcast. The runtime replays accepted envelopes strictly after
   * `afterSequence`, then continues with live broadcast.
   *
   * `afterSequence` is the **1-based accepted-envelope ordinal**, exclusive:
   * `0` (default) replays from the very start; `k` replays envelopes with
   * ordinal `> k`. Clients derive the ordinal by counting delivered envelopes
   * (the Nth accepted envelope has ordinal N) — see
   * `IncomingMessage.seq`, which is exactly this ordinal under the new contract.
   * Ordinals are stable across log compaction and runtime restart. Resuming
   * below a compacted base returns `FAILED_PRECONDITION` (inspectable via
   * `MacpTransportError.code`) rather than silently skipping history (runtime
   * ≥ 0.5.0; older runtimes compared inclusively against a raw log index).
   */
  sendSubscribe(sessionId: string, afterSequence = 0): Promise<void> {
    if (this.closed) return Promise.reject(new MacpSdkError('stream is already closed'));
    return new Promise<void>((resolve, reject) => {
      this.call.write({ subscribeSessionId: sessionId, afterSequence }, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async *responses(): AsyncGenerator<Envelope, void, void> {
    while (true) {
      const item = await this.queue.shift();
      if (item === STREAM_END) {
        // Re-push so a subsequent read()/responses() call also observes end-of-stream.
        this.queue.unshift(STREAM_END);
        return;
      }
      if (item instanceof Error) throw item;
      yield item;
    }
  }

  /**
   * Read a single envelope from the stream. Parity with python-sdk's
   * {@code MacpStream.read(timeout)}.
   *
   * @param timeoutMs  Maximum time to wait for the next envelope. If omitted,
   *                   blocks indefinitely until an envelope arrives, the stream
   *                   ends, or an error occurs.
   * @returns          The next envelope, or {@code null} if the stream has
   *                   ended.
   * @throws MacpTimeoutError  If {@code timeoutMs} elapses before an envelope
   *                           arrives.
   * @throws MacpTransportError  If the underlying stream errored.
   */
  async read(timeoutMs?: number): Promise<Envelope | null> {
    const item = timeoutMs === undefined ? await this.queue.shift() : await this.queue.shiftWithTimeout(timeoutMs);
    if (item === TIMEOUT) {
      throw new MacpTimeoutError(`stream read timed out after ${timeoutMs}ms`);
    }
    if (item === STREAM_END) {
      // Re-push so future calls (including responses()) also observe the end.
      this.queue.unshift(STREAM_END);
      return null;
    }
    if (item instanceof Error) throw item;
    return item;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.call.end();
  }
}

export class MacpClient {
  readonly auth?: AuthConfig;
  readonly protoRegistry: ProtoRegistry;
  private readonly client: any;
  private readonly secure: boolean;
  private readonly defaultDeadlineMs?: number;
  private readonly clientName: string;
  private readonly clientVersion: string;

  constructor(options: MacpClientOptions) {
    this.auth = options.auth;
    this.secure = options.secure ?? true;
    if (!this.secure && options.allowInsecure !== true) {
      throw new MacpSdkError(
        'MacpClient requires TLS. Pass secure: true (default) or, for local development only, ' +
          'both secure: false and allowInsecure: true. See RFC-MACP-0006 §3.',
      );
    }
    this.defaultDeadlineMs = options.defaultDeadlineMs;
    this.clientName = options.clientName ?? 'macp-sdk-typescript';
    this.clientVersion = options.clientVersion ?? '0.5.0';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { protoDir: defaultProtoDir } = require('@multiagentcoordinationprotocol/proto');
    const protoDir = options.protoDir ?? defaultProtoDir;
    this.protoRegistry = new ProtoRegistry(protoDir);
    const packageDefinition = protoLoader.loadSync(
      [
        path.join(protoDir, 'macp/v1/core.proto'),
        path.join(protoDir, 'macp/v1/envelope.proto'),
        path.join(protoDir, 'macp/v1/policy.proto'),
      ],
      {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [protoDir],
      },
    );
    const descriptor = grpc.loadPackageDefinition(packageDefinition) as any;
    const credentials = this.secure
      ? grpc.credentials.createSsl(options.rootCertificates)
      : grpc.credentials.createInsecure();
    this.client = new descriptor.macp.v1.MACPRuntimeService(options.address, credentials);
  }

  private requireAuth(auth?: AuthConfig): AuthConfig {
    const selected = auth ?? this.auth;
    if (!selected) throw new MacpSdkError('this operation requires auth; pass auth= or configure client.auth');
    return selected;
  }

  private metadata(auth?: AuthConfig): grpc.Metadata | undefined {
    const selected = auth ?? this.auth;
    if (!selected) return undefined;
    return metadataFromAuth(selected);
  }

  private deadline(deadlineMs?: number): Date | undefined {
    const resolved = deadlineMs ?? this.defaultDeadlineMs;
    return resolved ? new Date(Date.now() + resolved) : undefined;
  }

  private unary<TRequest, TResponse>(
    method: string,
    request: TRequest,
    auth?: AuthConfig,
    deadlineMs?: number,
  ): Promise<TResponse> {
    return new Promise<TResponse>((resolve, reject) => {
      const callback = (error: grpc.ServiceError | null, response: TResponse) => {
        if (error) reject(new MacpTransportError(error.details || error.message, grpcStatusName(error.code)));
        else resolve(response);
      };
      const deadline = this.deadline(deadlineMs);
      const metadata = this.metadata(auth);
      if (metadata && deadline) this.client[method](request, metadata, { deadline }, callback);
      else if (metadata) this.client[method](request, metadata, callback);
      else if (deadline) this.client[method](request, { deadline }, callback);
      else this.client[method](request, callback);
    });
  }

  async initialize(deadlineMs?: number): Promise<InitializeResult> {
    return this.unary(
      'Initialize',
      {
        supportedProtocolVersions: ['1.0'],
        clientInfo: {
          name: this.clientName,
          title: this.clientName,
          version: this.clientVersion,
          description: 'TypeScript SDK for the MACP runtime',
          websiteUrl: '',
        },
        capabilities: {
          sessions: { stream: true, listSessions: true, watchSessions: true },
          cancellation: { cancelSession: true },
          progress: { progress: true },
          manifest: { getManifest: true },
          modeRegistry: { listModes: true, listChanged: true },
          roots: { listRoots: true, listChanged: true },
          policyRegistry: { registerPolicy: true, listPolicies: true, listChanged: true },
          experimental: { features: {} },
        },
      },
      undefined,
      deadlineMs,
    ) as Promise<InitializeResult>;
  }

  async send(
    envelope: Envelope,
    options?: { auth?: AuthConfig; deadlineMs?: number; raiseOnNack?: boolean },
  ): Promise<Ack> {
    const auth = this.requireAuth(options?.auth);
    const response = await this.unary<{ envelope: Envelope }, { ack: Ack }>(
      'Send',
      { envelope },
      auth,
      options?.deadlineMs,
    );
    const ack = response.ack;
    // Duplicate acks are success — the message was already accepted
    if (ack?.duplicate) return ack;
    if (options?.raiseOnNack !== false && !ack?.ok) throw new MacpAckError(ack ?? {});
    return ack;
  }

  async getSession(
    sessionId: string,
    options?: { auth?: AuthConfig; deadlineMs?: number },
  ): Promise<{ metadata: SessionMetadata }> {
    const auth = this.requireAuth(options?.auth);
    return this.unary('GetSession', { sessionId }, auth, options?.deadlineMs) as Promise<{ metadata: SessionMetadata }>;
  }

  /**
   * Terminate a session via the `CancelSession` control-plane RPC.
   *
   * As of proto 0.1.3 the resulting `Ack.sessionState` is
   * `SESSION_STATE_CANCELLED` (previously `SESSION_STATE_EXPIRED`) — distinct
   * from TTL/policy expiry so consumers can tell explicit cancellation apart.
   */
  async cancelSession(
    sessionId: string,
    reason: string,
    options?: { auth?: AuthConfig; deadlineMs?: number; raiseOnNack?: boolean; cancelledBy?: string },
  ): Promise<Ack> {
    const auth = this.requireAuth(options?.auth);
    const request: Record<string, string> = { sessionId, reason };
    if (options?.cancelledBy) request.cancelledBy = options.cancelledBy;
    const response = await this.unary<Record<string, string>, { ack: Ack }>(
      'CancelSession',
      request,
      auth,
      options?.deadlineMs,
    );
    const ack = response.ack;
    if (options?.raiseOnNack !== false && !ack?.ok) throw new MacpAckError(ack ?? {});
    return ack;
  }

  /**
   * Pause a session via the `SuspendSession` control-plane RPC (proto 0.1.3+).
   *
   * Suspension is non-terminal: the resulting `Ack.sessionState` is
   * `SESSION_STATE_SUSPENDED`, the session's remaining TTL is banked, and
   * messages sent to a suspended session are rejected until {@link resumeSession}
   * restores it to `SESSION_STATE_OPEN`. Restricted to the initiator and
   * policy-delegated roles, mirroring {@link cancelSession}.
   */
  async suspendSession(
    sessionId: string,
    reason: string,
    options?: { auth?: AuthConfig; deadlineMs?: number; raiseOnNack?: boolean },
  ): Promise<Ack> {
    const auth = this.requireAuth(options?.auth);
    const response = await this.unary<Record<string, string>, { ack: Ack }>(
      'SuspendSession',
      { sessionId, reason },
      auth,
      options?.deadlineMs,
    );
    const ack = response.ack;
    if (options?.raiseOnNack !== false && !ack?.ok) throw new MacpAckError(ack ?? {});
    return ack;
  }

  /**
   * Resume a suspended session via the `ResumeSession` control-plane RPC
   * (proto 0.1.3+).
   *
   * Restores `SESSION_STATE_OPEN` and adds the banked TTL back to the session's
   * absolute deadline. Restricted to the initiator and policy-delegated roles,
   * mirroring {@link suspendSession}.
   */
  async resumeSession(
    sessionId: string,
    reason: string,
    options?: { auth?: AuthConfig; deadlineMs?: number; raiseOnNack?: boolean },
  ): Promise<Ack> {
    const auth = this.requireAuth(options?.auth);
    const response = await this.unary<Record<string, string>, { ack: Ack }>(
      'ResumeSession',
      { sessionId, reason },
      auth,
      options?.deadlineMs,
    );
    const ack = response.ack;
    if (options?.raiseOnNack !== false && !ack?.ok) throw new MacpAckError(ack ?? {});
    return ack;
  }

  async getManifest(agentId = '', deadlineMs?: number): Promise<{ manifest: AgentManifest }> {
    return this.unary('GetManifest', { agentId }, undefined, deadlineMs) as Promise<{ manifest: AgentManifest }>;
  }

  async listModes(deadlineMs?: number): Promise<{ modes: ModeDescriptor[] }> {
    return this.unary('ListModes', {}, undefined, deadlineMs) as Promise<{ modes: ModeDescriptor[] }>;
  }

  async listExtModes(deadlineMs?: number): Promise<{ modes: ModeDescriptor[] }> {
    return this.unary('ListExtModes', {}, undefined, deadlineMs) as Promise<{ modes: ModeDescriptor[] }>;
  }

  async listRoots(deadlineMs?: number): Promise<{ roots: Root[] }> {
    return this.unary('ListRoots', {}, undefined, deadlineMs) as Promise<{ roots: Root[] }>;
  }

  /**
   * Register an extension-mode descriptor (runtime 0.5.0 guardrails,
   * change-review A5):
   * - the descriptor MUST declare `Commitment` among `terminalMessageTypes` —
   *   an ext mode without a terminal `Commitment` can never resolve, so the
   *   runtime rejects it. This method fails fast client-side to match.
   * - a later {@link promoteMode} into the reserved `macp.mode.*` namespace is
   *   rejected by the runtime.
   * - a SessionStart with an empty `mode_version` binds the registered
   *   descriptor's `modeVersion`; a subsequent Commitment must echo that bound
   *   version (echoing `""` no longer matches vacuously). `BaseSession`
   *   defaults `modeVersion` to `'1.0.0'`, so set the descriptor's version to
   *   match, or override the session's `modeVersion`.
   */
  async registerExtMode(
    descriptor: ModeDescriptor,
    options?: { auth?: AuthConfig; deadlineMs?: number },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!descriptor.terminalMessageTypes?.includes('Commitment')) {
      throw new MacpSessionError(
        `ext-mode descriptor '${descriptor.mode}' must declare 'Commitment' in terminalMessageTypes; ` +
          'a mode without a terminal Commitment can never resolve and the runtime rejects it.',
      );
    }
    const auth = this.requireAuth(options?.auth);
    return this.unary('RegisterExtMode', { modeDescriptor: descriptor }, auth, options?.deadlineMs) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }

  async unregisterExtMode(
    mode: string,
    options?: { auth?: AuthConfig; deadlineMs?: number },
  ): Promise<{ ok: boolean; error?: string }> {
    const auth = this.requireAuth(options?.auth);
    return this.unary('UnregisterExtMode', { mode }, auth, options?.deadlineMs) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }

  async promoteMode(
    mode: string,
    promotedModeName = '',
    options?: { auth?: AuthConfig; deadlineMs?: number },
  ): Promise<{ ok: boolean; error?: string; mode?: string }> {
    const auth = this.requireAuth(options?.auth);
    return this.unary('PromoteMode', { mode, promotedModeName }, auth, options?.deadlineMs) as Promise<{
      ok: boolean;
      error?: string;
      mode?: string;
    }>;
  }

  async registerPolicy(
    descriptor: PolicyDescriptor,
    options?: { auth?: AuthConfig; deadlineMs?: number },
  ): Promise<{ ok: boolean; error?: string }> {
    const auth = this.requireAuth(options?.auth);
    return this.unary('RegisterPolicy', { policyDescriptor: descriptor }, auth, options?.deadlineMs) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }

  async unregisterPolicy(
    policyId: string,
    options?: { auth?: AuthConfig; deadlineMs?: number },
  ): Promise<{ ok: boolean; error?: string }> {
    const auth = this.requireAuth(options?.auth);
    return this.unary('UnregisterPolicy', { policyId }, auth, options?.deadlineMs) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  }

  async getPolicy(policyId: string, options?: { auth?: AuthConfig; deadlineMs?: number }): Promise<PolicyDescriptor> {
    const auth = this.requireAuth(options?.auth);
    const res = await this.unary<{ policyId: string }, { policyDescriptor: PolicyDescriptor }>(
      'GetPolicy',
      { policyId },
      auth,
      options?.deadlineMs,
    );
    return res.policyDescriptor;
  }

  async listPolicies(mode?: string, options?: { auth?: AuthConfig; deadlineMs?: number }): Promise<PolicyDescriptor[]> {
    const auth = this.requireAuth(options?.auth);
    const res = await this.unary<{ mode: string }, { descriptors?: PolicyDescriptor[] }>(
      'ListPolicies',
      { mode: mode || '' },
      auth,
      options?.deadlineMs,
    );
    return res.descriptors || [];
  }

  /**
   * Fetch a single page of sessions (proto ≥ 0.1.6). `pageSize: 0` (or absent)
   * lets the server choose the page size; the server MAY cap it. Callers MUST
   * NOT assume the listing is complete unless `nextPageToken` is empty. Pass a
   * returned non-empty `nextPageToken` back as `pageToken` to fetch the next
   * page; a stale token yields `INVALID_ARGUMENT`.
   */
  async listSessionsPage(options?: {
    pageSize?: number;
    pageToken?: string;
    auth?: AuthConfig;
    deadlineMs?: number;
  }): Promise<{ sessions: SessionMetadata[]; nextPageToken: string }> {
    const auth = this.requireAuth(options?.auth);
    const res = await this.unary<
      { pageSize: number; pageToken: string },
      { sessions?: SessionMetadata[]; nextPageToken?: string }
    >(
      'ListSessions',
      { pageSize: options?.pageSize ?? 0, pageToken: options?.pageToken ?? '' },
      auth,
      options?.deadlineMs,
    );
    return { sessions: res.sessions ?? [], nextPageToken: res.nextPageToken ?? '' };
  }

  /**
   * Enumerate ALL sessions, transparently walking pages until the runtime
   * returns an empty `nextPageToken`. Preserves the "complete list" semantics
   * this method has always documented, even against runtimes that cap page
   * sizes (proto ≥ 0.1.6). For manual page control, use {@link listSessionsPage}.
   */
  async listSessions(options?: {
    auth?: AuthConfig;
    deadlineMs?: number;
    pageSize?: number;
  }): Promise<SessionMetadata[]> {
    const all: SessionMetadata[] = [];
    let pageToken = '';
    // Bound the walk defensively so a misbehaving runtime that never returns an
    // empty token cannot spin forever.
    for (let page = 0; page < 100_000; page++) {
      const res = await this.listSessionsPage({
        pageSize: options?.pageSize,
        pageToken,
        auth: options?.auth,
        deadlineMs: options?.deadlineMs,
      });
      all.push(...res.sessions);
      if (!res.nextPageToken) return all;
      pageToken = res.nextPageToken;
    }
    return all;
  }

  watchSessions(auth?: AuthConfig): grpc.ClientReadableStream<any> {
    const metadata = this.metadata(auth);
    return metadata ? (this.client as any).WatchSessions({}, metadata) : (this.client as any).WatchSessions({});
  }

  watchPolicies(auth?: AuthConfig): grpc.ClientReadableStream<any> {
    const metadata = this.metadata(auth);
    return metadata ? (this.client as any).WatchPolicies({}, metadata) : (this.client as any).WatchPolicies({});
  }

  openStream(options?: { auth?: AuthConfig }): MacpStream {
    const auth = this.requireAuth(options?.auth);
    const metadata = this.metadata(auth) as grpc.Metadata;
    const call = (this.client as any).StreamSession(metadata);
    return new MacpStream(call);
  }

  watchModeRegistry(auth?: AuthConfig): grpc.ClientReadableStream<any> {
    const metadata = this.metadata(auth);
    return metadata ? (this.client as any).WatchModeRegistry({}, metadata) : (this.client as any).WatchModeRegistry({});
  }

  watchRoots(auth?: AuthConfig): grpc.ClientReadableStream<any> {
    const metadata = this.metadata(auth);
    return metadata ? (this.client as any).WatchRoots({}, metadata) : (this.client as any).WatchRoots({});
  }

  /**
   * Subscribe to the ambient signal plane. Requires auth as of runtime 0.5.0 —
   * routed through {@link requireAuth} so a missing credential fails fast with a
   * clear client-side error instead of a stream `UNAUTHENTICATED`.
   */
  watchSignals(auth?: AuthConfig): grpc.ClientReadableStream<any> {
    const selected = this.requireAuth(auth);
    const metadata = metadataFromAuth(selected);
    return (this.client as any).WatchSignals({}, metadata);
  }

  async sendSignal(options: {
    signalType: string;
    data?: Buffer;
    confidence?: number;
    correlationSessionId?: string;
    sender?: string;
    auth?: AuthConfig;
    deadlineMs?: number;
  }): Promise<Ack> {
    validateSignalType(options.signalType, options.data);
    const auth = this.requireAuth(options.auth);
    assertSenderMatchesIdentity(auth, options.sender);
    const signalPayload = buildSignalPayload({
      signalType: options.signalType,
      data: options.data,
      confidence: options.confidence,
      correlationSessionId: options.correlationSessionId,
    });
    const payload = this.protoRegistry.encodeKnownPayload(
      '',
      'Signal',
      signalPayload as unknown as Record<string, unknown>,
    );
    const envelope = buildEnvelope({
      mode: '',
      messageType: 'Signal',
      sessionId: '',
      sender: options.sender ?? this.senderHint(auth) ?? '',
      payload,
    });
    return this.send(envelope, { auth, deadlineMs: options.deadlineMs });
  }

  async sendProgress(options: {
    sessionId?: string;
    mode?: string;
    progressToken: string;
    progress: number;
    total: number;
    message?: string;
    targetMessageId?: string;
    sender?: string;
    auth?: AuthConfig;
    deadlineMs?: number;
  }): Promise<Ack> {
    const auth = this.requireAuth(options.auth);
    assertSenderMatchesIdentity(auth, options.sender);
    const progressPayload = buildProgressPayload({
      progressToken: options.progressToken,
      progress: options.progress,
      total: options.total,
      message: options.message,
      targetMessageId: options.targetMessageId,
    });
    const payload = this.protoRegistry.encodeKnownPayload(
      '',
      'Progress',
      progressPayload as unknown as Record<string, unknown>,
    );
    const envelope = buildEnvelope({
      mode: options.mode ?? '',
      messageType: 'Progress',
      sessionId: options.sessionId ?? '',
      sender: options.sender ?? this.senderHint(auth) ?? '',
      payload,
    });
    return this.send(envelope, { auth, deadlineMs: options.deadlineMs });
  }

  senderHint(auth?: AuthConfig): string | undefined {
    return authSender(auth ?? this.auth);
  }

  close(): void {
    if (typeof this.client.close === 'function') this.client.close();
  }
}
