import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../src/auth';
import { MacpClient } from '../../src/client';
import { MacpAckError, MacpSdkError, MacpSessionError, MacpTransportError } from '../../src/errors';
import type { Ack, Envelope } from '../../src/types';
import { stubUnary } from './helpers/grpc-stub';

// ── MacpClient unary RPC surface ────────────────────────────────────
//
// Every unary method routes through the private `unary()` dispatcher; these
// tests cover the request shapes, response unwrapping, and the four-way
// metadata/deadline dispatch matrix that were previously exercised only by the
// Docker-gated integration suite.

function makeClient(): MacpClient {
  return new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
  });
}

function makeBareClient(options?: { defaultDeadlineMs?: number }): MacpClient {
  return new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    defaultDeadlineMs: options?.defaultDeadlineMs,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unary() dispatch matrix', () => {
  it('passes (req, cb) with neither auth nor deadline', async () => {
    const client = makeBareClient();
    const calls = stubUnary(client, 'ListModes', { modes: [] });

    await client.listModes();

    expect(calls[0]!.extras).toEqual([]);
  });

  it('passes (req, metadata, cb) with auth only', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'GetSession', { metadata: {} });

    await client.getSession('s1');

    expect(calls[0]!.extras).toHaveLength(1);
    const metadata = calls[0]!.extras[0] as grpc.Metadata;
    expect(metadata).toBeInstanceOf(grpc.Metadata);
    expect(metadata.get('authorization')).toEqual(['Bearer alice-token']);
  });

  it('passes (req, {deadline}, cb) with deadline only', async () => {
    const client = makeBareClient({ defaultDeadlineMs: 5_000 });
    const calls = stubUnary(client, 'ListModes', { modes: [] });

    const before = Date.now();
    await client.listModes();

    expect(calls[0]!.extras).toHaveLength(1);
    const { deadline } = calls[0]!.extras[0] as { deadline: Date };
    expect(deadline).toBeInstanceOf(Date);
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + 5_000);
    expect(deadline.getTime()).toBeLessThan(before + 6_000);
  });

  it('passes (req, metadata, {deadline}, cb) with both, and a per-call deadline wins', async () => {
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.bearer('alice-token'),
      defaultDeadlineMs: 60_000,
    });
    const calls = stubUnary(client, 'GetSession', { metadata: {} });

    const before = Date.now();
    await client.getSession('s1', { deadlineMs: 1_000 });

    expect(calls[0]!.extras).toHaveLength(2);
    expect(calls[0]!.extras[0]).toBeInstanceOf(grpc.Metadata);
    const { deadline } = calls[0]!.extras[1] as { deadline: Date };
    // Reflects the per-call 1s deadline, not the 60s client default.
    expect(deadline.getTime()).toBeLessThan(before + 2_000);
  });

  it('wraps a unary failure into MacpTransportError with the status name', async () => {
    const client = makeClient();
    stubUnary(client, 'GetSession', { code: 16, details: '', message: '16 UNAUTHENTICATED: expired' }, { fail: true });

    let caught: unknown;
    try {
      await client.getSession('s1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpTransportError);
    expect((caught as MacpTransportError).code).toBe('UNAUTHENTICATED');
    // Empty `details` falls back to `message`.
    expect((caught as MacpTransportError).message).toBe('16 UNAUTHENTICATED: expired');
  });
});

describe('MacpClient.initialize', () => {
  it('sends protocol 1.0, client info, and the capability set', async () => {
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      clientName: 'my-agent',
      clientVersion: '9.9.9',
    });
    const result = { protocolVersion: '1.0', serverInfo: { name: 'runtime' } };
    const calls = stubUnary(client, 'Initialize', result);

    await expect(client.initialize()).resolves.toEqual(result);

    expect(calls[0]!.request).toMatchObject({
      supportedProtocolVersions: ['1.0'],
      clientInfo: { name: 'my-agent', version: '9.9.9' },
      capabilities: {
        sessions: { stream: true, listSessions: true, watchSessions: true },
        cancellation: { cancelSession: true },
      },
    });
  });
});

describe('MacpClient.send', () => {
  const envelope = { messageId: 'm1', sessionId: 's1' } as unknown as Envelope;

  it('returns the ack on ok', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'Send', { ack: { ok: true, envelopeId: 'e1' } });

    const ack = await client.send(envelope);

    expect(ack).toEqual({ ok: true, envelopeId: 'e1' });
    expect(calls[0]!.request).toEqual({ envelope });
  });

  it('treats duplicate acks as success even when ok=false', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: false, duplicate: true } });

    const ack = await client.send(envelope);

    expect(ack.duplicate).toBe(true);
  });

  it('throws MacpAckError on a NACK by default', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: false, error: { code: 'POLICY_DENIED', message: 'no' } } });

    let caught: unknown;
    try {
      await client.send(envelope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpAckError);
    expect((caught as MacpAckError).ack).toMatchObject({ error: { code: 'POLICY_DENIED' } });
  });

  it('returns the NACK ack when raiseOnNack is false', async () => {
    const client = makeClient();
    stubUnary(client, 'Send', { ack: { ok: false, error: { code: 'POLICY_DENIED' } } });

    const ack = await client.send(envelope, { raiseOnNack: false });

    expect(ack.ok).toBe(false);
  });

  it('requires auth before hitting the wire', async () => {
    const client = makeBareClient();
    const calls = stubUnary(client, 'Send', { ack: { ok: true } });

    await expect(client.send(envelope)).rejects.toThrow(MacpSdkError);
    expect(calls).toHaveLength(0);
  });

  // Issue #107 3b: a gRPC-level ALREADY_EXISTS/FAILED_PRECONDITION on Send is
  // an application-level rejection the runtime couldn't express as a normal
  // NACK — surface it as MacpAckError, matching macp-sdk-python. Fails on old
  // code, which unconditionally wrapped every ServiceError in MacpTransportError.
  it('issue #107: gRPC ALREADY_EXISTS raises MacpAckError(SESSION_ALREADY_EXISTS)', async () => {
    const client = makeClient();
    stubUnary(
      client,
      'Send',
      { code: grpc.status.ALREADY_EXISTS, details: 'session already exists', message: '6 ALREADY_EXISTS' },
      { fail: true },
    );

    let caught: unknown;
    try {
      await client.send(envelope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpAckError);
    expect((caught as MacpAckError).failure.code).toBe('SESSION_ALREADY_EXISTS');
    expect((caught as MacpAckError).failure.message).toBe('session already exists');
  });

  it('issue #107: gRPC FAILED_PRECONDITION raises MacpAckError(POLICY_DENIED)', async () => {
    const client = makeClient();
    stubUnary(
      client,
      'Send',
      { code: grpc.status.FAILED_PRECONDITION, details: 'policy denies this', message: '9 FAILED_PRECONDITION' },
      { fail: true },
    );

    let caught: unknown;
    try {
      await client.send(envelope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpAckError);
    expect((caught as MacpAckError).failure.code).toBe('POLICY_DENIED');
  });

  it('issue #107: failure.reasons is extracted from the macp-error-details-bin trailing metadata', async () => {
    const client = makeClient();
    const metadata = new grpc.Metadata();
    metadata.set('macp-error-details-bin', Buffer.from(JSON.stringify({ reasons: ['rule-a', 'rule-b'] })));
    stubUnary(
      client,
      'Send',
      { code: grpc.status.FAILED_PRECONDITION, details: 'no', message: 'nope', metadata },
      { fail: true },
    );

    let caught: unknown;
    try {
      await client.send(envelope);
    } catch (err) {
      caught = err;
    }
    expect((caught as MacpAckError).failure.reasons).toEqual(['rule-a', 'rule-b']);
  });

  it('issue #107: malformed macp-error-details-bin metadata yields reasons: [] without throwing', async () => {
    const client = makeClient();
    const metadata = new grpc.Metadata();
    metadata.set('macp-error-details-bin', Buffer.from('not json'));
    stubUnary(
      client,
      'Send',
      { code: grpc.status.FAILED_PRECONDITION, details: 'no', message: 'nope', metadata },
      { fail: true },
    );

    let caught: unknown;
    try {
      await client.send(envelope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpAckError);
    expect((caught as MacpAckError).failure.reasons).toEqual([]);
  });

  it('issue #107: an error with no metadata at all still constructs MacpAckError with reasons: []', async () => {
    const client = makeClient();
    stubUnary(
      client,
      'Send',
      { code: grpc.status.FAILED_PRECONDITION, details: 'no', message: 'nope' },
      { fail: true },
    );

    let caught: unknown;
    try {
      await client.send(envelope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpAckError);
    expect((caught as MacpAckError).failure.reasons).toEqual([]);
  });

  // Non-vacuity guard against over-broad mapping: other gRPC statuses on
  // Send must still surface as MacpTransportError with .code set.
  it.each(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'UNAUTHENTICATED'] as const)(
    'issue #107: gRPC %s on Send is still MacpTransportError',
    async (statusName) => {
      const client = makeClient();
      const code = grpc.status[statusName];
      stubUnary(client, 'Send', { code, details: 'x', message: `${code} ${statusName}` }, { fail: true });

      let caught: unknown;
      try {
        await client.send(envelope);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MacpTransportError);
      expect((caught as MacpTransportError).code).toBe(statusName);
    },
  );
});

describe('MacpClient discovery and registry RPCs', () => {
  it('getSession passes the sessionId', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'GetSession', { metadata: { sessionId: 's1', state: 'SESSION_STATE_OPEN' } });

    const res = await client.getSession('s1');

    expect(calls[0]!.request).toEqual({ sessionId: 's1' });
    expect(res.metadata.state).toBe('SESSION_STATE_OPEN');
  });

  it('getManifest defaults agentId to the empty string and forwards explicit ids', async () => {
    const client = makeBareClient();
    const calls = stubUnary(client, 'GetManifest', { manifest: { agentId: 'a1' } });

    await client.getManifest();
    await client.getManifest('a1');

    expect(calls[0]!.request).toEqual({ agentId: '' });
    expect(calls[1]!.request).toEqual({ agentId: 'a1' });
  });

  it.each([
    ['listModes', 'ListModes', { modes: [{ mode: 'macp.mode.decision.v1' }] }],
    ['listExtModes', 'ListExtModes', { modes: [{ mode: 'ext.custom.v1' }] }],
    ['listRoots', 'ListRoots', { roots: [{ uri: 'file:///workspace' }] }],
  ] as const)('%s sends an empty request and returns the response verbatim', async (method, rpc, response) => {
    const client = makeBareClient();
    const calls = stubUnary(client, rpc, response);

    const res = await (client[method] as () => Promise<unknown>)();

    expect(calls[0]!.request).toEqual({});
    expect(res).toEqual(response);
  });

  it('registerExtMode sends { modeDescriptor } when the descriptor declares a terminal Commitment', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'RegisterExtMode', { ok: true });
    const descriptor = {
      mode: 'ext.custom.v1',
      modeVersion: '1.0.0',
      description: 'x',
      messageTypes: ['SessionStart', 'Contribute', 'Commitment'],
      terminalMessageTypes: ['Commitment'],
    };

    const res = await client.registerExtMode(descriptor);

    expect(res.ok).toBe(true);
    expect(calls[0]!.request).toEqual({ modeDescriptor: descriptor });
  });

  it('unregisterExtMode sends { mode }', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'UnregisterExtMode', { ok: true });

    await client.unregisterExtMode('ext.custom.v1');

    expect(calls[0]!.request).toEqual({ mode: 'ext.custom.v1' });
  });

  it('promoteMode defaults promotedModeName to the empty string and forwards explicit names', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'PromoteMode', { ok: true, mode: 'macp.mode.custom.v1' });

    await client.promoteMode('ext.custom.v1');
    await client.promoteMode('ext.custom.v1', 'custom');

    expect(calls[0]!.request).toEqual({ mode: 'ext.custom.v1', promotedModeName: '' });
    expect(calls[1]!.request).toEqual({ mode: 'ext.custom.v1', promotedModeName: 'custom' });
  });
});

describe('MacpClient policy RPCs', () => {
  const descriptor = {
    policyId: 'pol-1',
    policyVersion: 'policy.v1',
    mode: 'macp.mode.decision.v1',
    description: 'majority',
    rules: [],
  };

  it('registerPolicy sends { policyDescriptor }', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'RegisterPolicy', { ok: true });

    await expect(client.registerPolicy(descriptor)).resolves.toEqual({ ok: true });
    expect(calls[0]!.request).toEqual({ policyDescriptor: descriptor });
  });

  it('unregisterPolicy sends { policyId }', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'UnregisterPolicy', { ok: true });

    await client.unregisterPolicy('pol-1');

    expect(calls[0]!.request).toEqual({ policyId: 'pol-1' });
  });

  it('getPolicy unwraps res.policyDescriptor', async () => {
    const client = makeClient();
    stubUnary(client, 'GetPolicy', { policyDescriptor: descriptor });

    await expect(client.getPolicy('pol-1')).resolves.toEqual(descriptor);
  });

  it('listPolicies defaults mode to the empty string and returns descriptors', async () => {
    const client = makeClient();
    const calls = stubUnary(client, 'ListPolicies', { descriptors: [descriptor] });

    const res = await client.listPolicies();

    expect(calls[0]!.request).toEqual({ mode: '' });
    expect(res).toEqual([descriptor]);
  });

  it('listPolicies normalises a missing descriptors field to []', async () => {
    const client = makeClient();
    stubUnary(client, 'ListPolicies', {});

    await expect(client.listPolicies('macp.mode.decision.v1')).resolves.toEqual([]);
  });
});

// Issue #107 3c: the five registry-mutation RPCs raise MacpAckError(code:
// 'FAILED_PRECONDITION') against a read-only registry, matching
// macp-sdk-python's `_map_registry_mutation_error`. Fails on old code for all
// five, which unconditionally wrapped every ServiceError in MacpTransportError.
const REGISTRY_MUTATION_CALLS: Array<{
  name: string;
  rpc: string;
  invoke: (client: MacpClient) => Promise<unknown>;
}> = [
  {
    name: 'registerExtMode',
    rpc: 'RegisterExtMode',
    invoke: (client) =>
      client.registerExtMode({
        mode: 'ext.custom.v1',
        modeVersion: '1.0.0',
        description: 'x',
        messageTypes: ['SessionStart', 'Contribute', 'Commitment'],
        terminalMessageTypes: ['Commitment'],
      }),
  },
  {
    name: 'unregisterExtMode',
    rpc: 'UnregisterExtMode',
    invoke: (client) => client.unregisterExtMode('ext.custom.v1'),
  },
  { name: 'promoteMode', rpc: 'PromoteMode', invoke: (client) => client.promoteMode('ext.custom.v1') },
  {
    name: 'registerPolicy',
    rpc: 'RegisterPolicy',
    invoke: (client) =>
      client.registerPolicy({
        policyId: 'pol-1',
        policyVersion: 'policy.v1',
        mode: 'macp.mode.decision.v1',
        description: 'x',
        rules: [],
      }),
  },
  { name: 'unregisterPolicy', rpc: 'UnregisterPolicy', invoke: (client) => client.unregisterPolicy('pol-1') },
];

describe('MacpClient registry-mutation RPCs — gRPC FAILED_PRECONDITION mapping', () => {
  it.each(REGISTRY_MUTATION_CALLS)(
    'issue #107: $name raises MacpAckError(FAILED_PRECONDITION) on a gRPC FAILED_PRECONDITION',
    async ({ rpc, invoke }) => {
      const client = makeClient();
      stubUnary(
        client,
        rpc,
        { code: grpc.status.FAILED_PRECONDITION, details: 'read-only registry', message: 'nope' },
        {
          fail: true,
        },
      );

      let caught: unknown;
      try {
        await invoke(client);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MacpAckError);
      expect((caught as MacpAckError).failure.code).toBe('FAILED_PRECONDITION');
    },
  );

  it('issue #107: a registry method given ALREADY_EXISTS (not in its map) still raises MacpTransportError — proves the maps are per-RPC', async () => {
    const client = makeClient();
    stubUnary(
      client,
      'RegisterPolicy',
      { code: grpc.status.ALREADY_EXISTS, details: 'x', message: 'dup' },
      { fail: true },
    );

    let caught: unknown;
    try {
      await client.registerPolicy({
        policyId: 'pol-1',
        policyVersion: 'policy.v1',
        mode: 'macp.mode.decision.v1',
        description: 'x',
        rules: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MacpTransportError);
    expect((caught as MacpTransportError).code).toBe('ALREADY_EXISTS');
  });
});

describe('MacpClient.sendSignal / sendProgress happy paths', () => {
  it('sendSignal builds a Signal envelope with the sender auto-filled from auth', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true } as Ack);

    await client.sendSignal({ signalType: 'macp.signal.heartbeat', correlationSessionId: 's1' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const envelope = sendSpy.mock.calls[0]![0];
    expect(envelope).toMatchObject({
      mode: '',
      messageType: 'Signal',
      sessionId: '',
      sender: 'alice',
    });
    const decoded = client.protoRegistry.decodeKnownPayload('', 'Signal', envelope.payload) as Record<string, unknown>;
    expect(decoded.signalType).toBe('macp.signal.heartbeat');
    expect(decoded.correlationSessionId).toBe('s1');
  });

  it('sendProgress builds a Progress envelope with defaulted sessionId and mode', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true } as Ack);

    await client.sendProgress({ progressToken: 'tok', progress: 3, total: 10 });

    const envelope = sendSpy.mock.calls[0]![0];
    expect(envelope).toMatchObject({
      mode: '',
      messageType: 'Progress',
      sessionId: '',
      sender: 'alice',
    });
    const decoded = client.protoRegistry.decodeKnownPayload('', 'Progress', envelope.payload) as Record<
      string,
      unknown
    >;
    expect(decoded.progressToken).toBe('tok');
  });

  it('sendProgress forwards explicit sessionId and mode', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true } as Ack);

    await client.sendProgress({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      mode: 'macp.mode.task.v1',
      progressToken: 'tok',
      progress: 1,
      total: 2,
    });

    expect(sendSpy.mock.calls[0]![0]).toMatchObject({
      mode: 'macp.mode.task.v1',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  // RFC-MACP-0001 §6 (spec PR #91) makes `Progress` tri-state: ambient (both
  // empty) or session-scoped (both non-empty), never mixed. macp-runtime
  // rejects the mixed shape with INVALID_ENVELOPE as of PR #137; the SDK
  // fails fast so the caller gets a message naming the mismatch. The two
  // legal forms are covered by the two happy-path cases above.
  it('sendProgress rejects a sessionId with no mode without sending', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true } as Ack);

    await expect(
      client.sendProgress({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        progressToken: 'tok',
        progress: 1,
        total: 4,
      }),
    ).rejects.toThrow(MacpSessionError);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sendProgress rejects a mode with no sessionId without sending', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true } as Ack);

    await expect(
      client.sendProgress({
        mode: 'macp.mode.task.v1',
        progressToken: 'tok',
        progress: 1,
        total: 4,
      }),
    ).rejects.toThrow(MacpSessionError);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('MacpClient.senderHint / close', () => {
  it('senderHint derives the sender from client auth, per-call auth, or returns undefined', () => {
    expect(makeClient().senderHint()).toBe('alice');
    expect(makeBareClient().senderHint()).toBeUndefined();
    expect(makeBareClient().senderHint(Auth.devAgent('bob'))).toBe('bob');
  });

  it('close() delegates to the gRPC client and tolerates a missing close fn', () => {
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const closeSpy = vi.fn();
    grpcClient.close = closeSpy;

    client.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    grpcClient.close = undefined;
    expect(() => client.close()).not.toThrow();
  });
});

describe('MacpClient watch* stream factories', () => {
  const WATCHES = [
    ['watchModeRegistry', 'WatchModeRegistry'],
    ['watchRoots', 'WatchRoots'],
    ['watchSessions', 'WatchSessions'],
    ['watchPolicies', 'WatchPolicies'],
  ] as const;

  it.each(WATCHES)('%s subscribes with metadata when auth is present', (method, rpc) => {
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const sentinel = {};
    const watchSpy = vi.fn(() => sentinel);
    grpcClient[rpc] = watchSpy;

    const stream = (client[method] as () => unknown)();

    expect(stream).toBe(sentinel);
    expect(watchSpy).toHaveBeenCalledTimes(1);
    expect(watchSpy.mock.calls[0]).toHaveLength(2);
    expect((watchSpy.mock.calls[0] as unknown[])[0]).toEqual({});
    expect((watchSpy.mock.calls[0] as unknown[])[1]).toBeInstanceOf(grpc.Metadata);
  });

  it.each(WATCHES)('%s subscribes without metadata when no auth is configured', (method, rpc) => {
    const client = makeBareClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const sentinel = {};
    const watchSpy = vi.fn(() => sentinel);
    grpcClient[rpc] = watchSpy;

    const stream = (client[method] as () => unknown)();

    expect(stream).toBe(sentinel);
    expect(watchSpy.mock.calls[0]).toHaveLength(1);
    expect((watchSpy.mock.calls[0] as unknown[])[0]).toEqual({});
  });
});
