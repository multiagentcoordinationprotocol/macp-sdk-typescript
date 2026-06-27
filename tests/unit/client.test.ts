import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../src/auth';
import { MacpClient, MacpStream } from '../../src/client';
import { DecisionSession } from '../../src/decision';
import { HandoffSession } from '../../src/handoff';
import { ProposalSession } from '../../src/proposal';
import { QuorumSession } from '../../src/quorum';
import { TaskSession } from '../../src/task';
import { MacpIdentityMismatchError, MacpSdkError } from '../../src/errors';

/**
 * Build a real MacpClient without any wire activity. Constructor binds a gRPC
 * channel lazily so we can instantiate safely; every test that emits envelopes
 * stubs `client.send` so nothing leaves the process.
 */
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

describe('MacpClient constructor — TLS guard', () => {
  it('defaults to secure: true and accepts no further flags', () => {
    // No throw on construction; actual TLS handshake is lazy.
    expect(() => new MacpClient({ address: '127.0.0.1:50051' })).not.toThrow();
  });

  it('throws when secure: false is passed without allowInsecure', () => {
    expect(
      () =>
        new MacpClient({
          address: '127.0.0.1:50051',
          secure: false,
        }),
    ).toThrow(MacpSdkError);

    expect(
      () =>
        new MacpClient({
          address: '127.0.0.1:50051',
          secure: false,
        }),
    ).toThrow(/allowInsecure/);
  });

  it('throws when secure: false is paired with allowInsecure: false', () => {
    expect(
      () =>
        new MacpClient({
          address: '127.0.0.1:50051',
          secure: false,
          allowInsecure: false,
        }),
    ).toThrow(MacpSdkError);
  });

  it('allows secure: false when allowInsecure: true', () => {
    expect(
      () =>
        new MacpClient({
          address: '127.0.0.1:50051',
          secure: false,
          allowInsecure: true,
        }),
    ).not.toThrow();
  });

  it('ignores allowInsecure when secure: true (TLS wins)', () => {
    expect(
      () =>
        new MacpClient({
          address: '127.0.0.1:50051',
          secure: true,
          allowInsecure: true,
        }),
    ).not.toThrow();
  });
});

// ── Identity guard on mode helpers ──────────────────────────────────
//
// TS-2: every mode helper must refuse to emit an envelope whose `sender`
// disagrees with auth.expectedSender. Covered here once per mode — the
// `senderFor` helper is shared so this exercises all action methods.

describe('Identity guard — mode helpers', () => {
  it('DecisionSession.propose throws when sender conflicts with expectedSender', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(session.propose({ proposalId: 'p1', option: 'x', sender: 'mallory' })).rejects.toBeInstanceOf(
      MacpIdentityMismatchError,
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('DecisionSession allows sender equal to expectedSender', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const ack = await session.propose({ proposalId: 'p1', option: 'x', sender: 'alice' });
    expect(ack.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('DecisionSession auto-fills sender from expectedSender when caller omits it', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'x' });
    const envelope = sendSpy.mock.calls[0][0];
    expect(envelope.sender).toBe('alice');
  });

  it('ProposalSession.propose enforces the guard', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(session.propose({ proposalId: 'p1', title: 't', sender: 'mallory' })).rejects.toBeInstanceOf(
      MacpIdentityMismatchError,
    );
  });

  it('TaskSession.requestTask enforces the guard', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(
      session.requestTask({
        taskId: 't1',
        title: 'Review',
        instructions: 'something',
        assignee: 'bob',
        sender: 'mallory',
      }),
    ).rejects.toBeInstanceOf(MacpIdentityMismatchError);
  });

  it('HandoffSession.offer enforces the guard', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(
      session.offer({ handoffId: 'h1', targetParticipant: 'bob', sender: 'mallory' }),
    ).rejects.toBeInstanceOf(MacpIdentityMismatchError);
  });

  it('QuorumSession.requestApproval enforces the guard', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(
      session.requestApproval({
        requestId: 'r1',
        action: 'deploy',
        summary: 'ship it',
        requiredApprovals: 1,
        sender: 'mallory',
      }),
    ).rejects.toBeInstanceOf(MacpIdentityMismatchError);
  });

  it('guard is silent for legacy Auth.bearer(token, senderHintString)', async () => {
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.bearer('token', 'alice'),
    });
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const ack = await session.propose({ proposalId: 'p1', option: 'x', sender: 'anyone' });
    expect(ack.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('guard is silent for Auth.devAgent', async () => {
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.devAgent('alice'),
    });
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const ack = await session.propose({ proposalId: 'p1', option: 'x', sender: 'bob' });
    expect(ack.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

// ── client.sendSignal / sendProgress ────────────────────────────────

describe('client.sendSignal / sendProgress identity guard', () => {
  it('client.sendSignal throws when sender conflicts with expectedSender', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(client.sendSignal({ signalType: 'heartbeat', sender: 'mallory' })).rejects.toBeInstanceOf(
      MacpIdentityMismatchError,
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('client.sendProgress throws when sender conflicts with expectedSender', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(
      client.sendProgress({
        progressToken: 'tok',
        progress: 1,
        total: 2,
        sender: 'mallory',
      }),
    ).rejects.toBeInstanceOf(MacpIdentityMismatchError);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ── MacpClient.listSessions ─────────────────────────────────────────
//
// Parity with SDK-PY-2: the TS SDK exposes ListSessions so orchestrators
// and diagnostics tools can enumerate active sessions without polling
// GetSession per id. The runtime guarantees an array response; the SDK
// normalises a missing/undefined `sessions` field to `[]`.

describe('MacpClient.listSessions', () => {
  it('returns the runtime-reported sessions array verbatim', async () => {
    const client = makeClient();
    const sessions = [
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: 'macp.mode.decision.v1',
        state: 'SESSION_STATE_OPEN',
        participants: ['alice', 'bob'],
        contextId: 'ctx-1',
        extensionKeys: ['aitp.tct'],
      },
    ];
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    grpcClient.ListSessions = (_req: unknown, _meta: unknown, cb: (err: null, res: unknown) => void) => {
      cb(null, { sessions });
    };

    const result = await client.listSessions();
    expect(result).toEqual(sessions);
  });

  it('normalises a missing `sessions` field to an empty array', async () => {
    // Protobuf drops empty `repeated` fields on the wire; the SDK must not
    // leak `undefined` to callers doing `for (const s of result)`.
    const client = makeClient();
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    grpcClient.ListSessions = (_req: unknown, _meta: unknown, cb: (err: null, res: unknown) => void) => {
      cb(null, {});
    };

    const result = await client.listSessions();
    expect(result).toEqual([]);
  });
});

// ── Session lifecycle control RPCs (proto 0.1.3) ────────────────────
//
// CancelSession now terminates as CANCELLED (was EXPIRED); SuspendSession /
// ResumeSession are the new non-terminal pause/restore pair. All three are
// control-plane unary RPCs that return an Ack; the SDK raises on a NACK
// unless raiseOnNack is false.

describe('MacpClient session lifecycle control', () => {
  function stubRpc(client: MacpClient, name: string, ack: Record<string, unknown>) {
    const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
    const calls: unknown[] = [];
    grpcClient[name] = (req: unknown, _meta: unknown, _opts: unknown, cb?: (err: null, res: unknown) => void) => {
      // unary() passes (req, metadata, {deadline}, cb) when both metadata and
      // deadline are present, else (req, metadata, cb). Auth is always set here,
      // so the callback is the 3rd or 4th positional arg.
      const callback = (typeof _opts === 'function' ? _opts : cb) as (err: null, res: unknown) => void;
      calls.push(req);
      callback(null, { ack });
    };
    return calls;
  }

  it('cancelSession surfaces CANCELLED in the Ack', async () => {
    const client = makeClient();
    const calls = stubRpc(client, 'CancelSession', { ok: true, sessionState: 'SESSION_STATE_CANCELLED' });
    const ack = await client.cancelSession('s1', 'done');
    expect(ack.ok).toBe(true);
    expect(ack.sessionState).toBe('SESSION_STATE_CANCELLED');
    expect(calls[0]).toMatchObject({ sessionId: 's1', reason: 'done' });
  });

  it('suspendSession surfaces SUSPENDED in the Ack', async () => {
    const client = makeClient();
    const calls = stubRpc(client, 'SuspendSession', { ok: true, sessionState: 'SESSION_STATE_SUSPENDED' });
    const ack = await client.suspendSession('s1', 'pausing');
    expect(ack.ok).toBe(true);
    expect(ack.sessionState).toBe('SESSION_STATE_SUSPENDED');
    expect(calls[0]).toMatchObject({ sessionId: 's1', reason: 'pausing' });
  });

  it('resumeSession surfaces OPEN in the Ack', async () => {
    const client = makeClient();
    const calls = stubRpc(client, 'ResumeSession', { ok: true, sessionState: 'SESSION_STATE_OPEN' });
    const ack = await client.resumeSession('s1', 'back');
    expect(ack.ok).toBe(true);
    expect(ack.sessionState).toBe('SESSION_STATE_OPEN');
    expect(calls[0]).toMatchObject({ sessionId: 's1', reason: 'back' });
  });

  it('suspendSession raises on a NACK', async () => {
    const client = makeClient();
    stubRpc(client, 'SuspendSession', { ok: false, error: { code: 'FORBIDDEN', message: 'not initiator' } });
    await expect(client.suspendSession('s1', 'pausing')).rejects.toThrow();
  });

  it('suspendSession honours raiseOnNack: false', async () => {
    const client = makeClient();
    stubRpc(client, 'SuspendSession', { ok: false, error: { code: 'FORBIDDEN', message: 'not initiator' } });
    const ack = await client.suspendSession('s1', 'pausing', { raiseOnNack: false });
    expect(ack.ok).toBe(false);
  });
});

// ── newSessionId export ─────────────────────────────────────────────
//
// TS-3: `newSessionId` must be reachable from the top-level entry point so
// callers can pre-allocate sessionIds before handing them to an initiator.

describe('newSessionId public export', () => {
  it('is re-exported from the top-level index', async () => {
    const mod = await import('../../src/index');
    expect(typeof mod.newSessionId).toBe('function');
    const id = mod.newSessionId();
    // UUID v4 shape — matches runtime validator in macp-runtime/src/session.rs.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns distinct ids across calls', async () => {
    const mod = await import('../../src/index');
    const a = mod.newSessionId();
    const b = mod.newSessionId();
    expect(a).not.toBe(b);
  });
});

// ── MacpStream.sendSubscribe (RFC-MACP-0006-A1) ─────────────────────
//
// The subscribe frame is the first write the adapter sends after opening a
// StreamSession call. The runtime treats it as a subscribe-only frame and
// replays accepted envelopes from `afterSequence` before switching to live
// broadcast, so non-initiators see SessionStart regardless of join order.

interface MockDuplex {
  on: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

type DuplexCtorArg = ConstructorParameters<typeof MacpStream>[0];

function makeMockDuplex(writeImpl?: (frame: unknown, cb?: (err?: Error | null) => void) => boolean): MockDuplex {
  return {
    on: vi.fn(),
    write: vi.fn(
      writeImpl ??
        ((_frame, cb) => {
          if (cb) cb(null);
          return true;
        }),
    ),
    end: vi.fn(),
  };
}

function makeStream(duplex: MockDuplex): MacpStream {
  return new MacpStream(duplex as unknown as DuplexCtorArg);
}

describe('MacpStream.sendSubscribe', () => {
  it('writes a subscribe-only frame with sessionId + afterSequence=0 by default', async () => {
    const duplex = makeMockDuplex();
    const stream = makeStream(duplex);

    await stream.sendSubscribe('session-xyz');

    expect(duplex.write).toHaveBeenCalledTimes(1);
    const [frame, cb] = duplex.write.mock.calls[0];
    expect(frame).toEqual({ subscribeSessionId: 'session-xyz', afterSequence: 0 });
    // The write callback is required — without it the Promise would never resolve.
    expect(typeof cb).toBe('function');
  });

  it('passes afterSequence through for replay cursor', async () => {
    const duplex = makeMockDuplex();
    const stream = makeStream(duplex);

    await stream.sendSubscribe('session-xyz', 42);

    const frame = duplex.write.mock.calls[0][0];
    expect(frame).toEqual({ subscribeSessionId: 'session-xyz', afterSequence: 42 });
  });

  it('does not write an envelope field on subscribe frames', async () => {
    // Regression guard: the runtime distinguishes subscribe-only frames by the
    // absence of `envelope`. If we ever start packing one, the runtime would
    // try to validate it and NACK.
    const duplex = makeMockDuplex();
    const stream = makeStream(duplex);

    await stream.sendSubscribe('session-xyz');

    const frame = duplex.write.mock.calls[0][0] as Record<string, unknown>;
    expect(frame).not.toHaveProperty('envelope');
  });

  it('rejects when called on a closed stream', async () => {
    const duplex = makeMockDuplex();
    const stream = makeStream(duplex);

    stream.close();

    await expect(stream.sendSubscribe('session-xyz')).rejects.toBeInstanceOf(MacpSdkError);
    // close() ends the underlying call but does not write the subscribe frame
    expect(duplex.write).not.toHaveBeenCalled();
    expect(duplex.end).toHaveBeenCalledTimes(1);
  });

  it('propagates write errors from the underlying duplex', async () => {
    const duplex = makeMockDuplex((_frame, cb) => {
      if (cb) cb(new Error('backpressure'));
      return false;
    });
    const stream = makeStream(duplex);

    await expect(stream.sendSubscribe('session-xyz')).rejects.toThrow(/backpressure/);
  });

  it('allows multiple sequential subscribe frames (resume with new cursor)', async () => {
    // A reconnect path may send a subscribe at seq=0 and later re-issue with a
    // new cursor. Both writes must reach the underlying duplex.
    const duplex = makeMockDuplex();
    const stream = makeStream(duplex);

    await stream.sendSubscribe('session-xyz');
    await stream.sendSubscribe('session-xyz', 17);

    expect(duplex.write).toHaveBeenCalledTimes(2);
    expect(duplex.write.mock.calls[0][0]).toEqual({ subscribeSessionId: 'session-xyz', afterSequence: 0 });
    expect(duplex.write.mock.calls[1][0]).toEqual({ subscribeSessionId: 'session-xyz', afterSequence: 17 });
  });
});
