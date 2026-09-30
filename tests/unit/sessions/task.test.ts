import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { TaskSession } from '../../../src/task';
import { MacpAckError, MacpIdentityMismatchError } from '../../../src/errors';
import { MODE_TASK } from '../../../src/constants';
import type { Envelope } from '../../../src/types';

// Issue #108.5/4e: each of these four task actions defaults `assignee` to the
// resolved sender when omitted or empty (`task.ts:126,140,166,180`). One table
// drives both the omitted- and empty-string cases below.
const TASK_ACTIONS: Array<{
  name: string;
  messageType: string;
  invoke: (session: TaskSession, assignee: string | undefined) => Promise<unknown>;
}> = [
  {
    name: 'acceptTask',
    messageType: 'TaskAccept',
    invoke: (session, assignee) => session.acceptTask({ taskId: 't1', assignee }),
  },
  {
    name: 'rejectTask',
    messageType: 'TaskReject',
    invoke: (session, assignee) => session.rejectTask({ taskId: 't1', assignee, reason: 'no' }),
  },
  {
    name: 'completeTask',
    messageType: 'TaskComplete',
    invoke: (session, assignee) => session.completeTask({ taskId: 't1', assignee, summary: 'done' }),
  },
  {
    name: 'failTask',
    messageType: 'TaskFail',
    invoke: (session, assignee) => session.failTask({ taskId: 't1', assignee, reason: 'boom', retryable: true }),
  },
];

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

describe('TaskSession — projection roundtrip', () => {
  it('start() appends SessionStart to transcript on ack.ok=true', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const before = session.projection.transcript.length;
    await session.start({ intent: 'delegate', participants: ['alice', 'bob'], ttlMs: 10_000 });
    expect(session.projection.transcript.length).toBe(before + 1);
  });

  it('start() accepts an empty intent (issue #124 item 3)', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(session.start({ intent: '', participants: ['alice', 'bob'], ttlMs: 10_000 })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('requestTask() records a requested task in activeTasks()', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'look it over' });
    expect(session.projection.activeTasks().map((t) => t.taskId)).toEqual(['t1']);
    expect(session.projection.getTask('t1')?.status).toBe('requested');
  });

  it('requestTask() accepts an empty instructions string (issue #124 item 3)', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: '' });
    expect(session.projection.getTask('t1')?.status).toBe('requested');
  });

  it('requestTask() accepts an omitted instructions field (issue #124 item 3 AC4 -- a non-TS/as-cast caller may omit it entirely, wire-identical to "")', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const input = { taskId: 't1', title: 'review' } as Parameters<typeof session.requestTask>[0];
    await session.requestTask(input);
    expect(session.projection.getTask('t1')?.status).toBe('requested');
  });

  it('does NOT mutate projection when client.send throws MacpAckError', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockRejectedValue(
      new MacpAckError({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } }),
    );

    await expect(session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' })).rejects.toBeInstanceOf(
      MacpAckError,
    );
    expect(session.projection.tasks.has('t1')).toBe(false);
  });

  it('acceptTask() transitions status to accepted and records the assignee', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' });
    await session.acceptTask({ taskId: 't1', assignee: 'bob' });
    expect(session.projection.getTask('t1')?.status).toBe('accepted');
    expect(session.projection.getTask('t1')?.assignee).toBe('bob');
    expect(session.projection.isAccepted('t1')).toBe(true);
  });

  it('rejectTask() flips status to rejected', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' });
    await session.rejectTask({ taskId: 't1', assignee: 'bob', reason: 'overloaded' });
    expect(session.projection.getTask('t1')?.status).toBe('rejected');
  });

  it('updateTask() records progress and flips task to in_progress', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' });
    await session.updateTask({ taskId: 't1', status: 'working', progress: 0.5 });
    expect(session.projection.progressOf('t1')).toBe(0.5);
    expect(session.projection.getTask('t1')?.status).toBe('in_progress');
  });

  it('completeTask() flips isCompleted()', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' });
    await session.completeTask({ taskId: 't1', assignee: 'bob', summary: 'done' });
    expect(session.projection.isCompleted('t1')).toBe(true);
  });

  it('failTask() flips isFailed() and records the failure', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' });
    await session.failTask({ taskId: 't1', assignee: 'bob', reason: 'boom', retryable: true });
    expect(session.projection.isFailed('t1')).toBe(true);
    expect(session.projection.isRetryable('t1')).toBe(true);
  });

  it('commit() flips projection.isCommitted', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.commit({ action: 'close', authorityScope: 'team', reason: 'ok' });
    expect(session.projection.isCommitted).toBe(true);
  });

  it('a resolved NACK is returned but not applied to the projection', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } });

    const ack = await session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' });
    expect(ack.ok).toBe(false);
    expect(session.projection.tasks.has('t1')).toBe(false);
    expect(session.projection.transcript).toHaveLength(0);
  });

  // Fails on old code: assignee was a required field passed straight through,
  // so omitting/emptying it either failed validation or reached the wire blank.
  it.each(TASK_ACTIONS)(
    'issue #108.5: $name defaults assignee to the resolved sender when omitted',
    async ({ messageType, invoke }) => {
      const client = makeClient();
      const session = new TaskSession(client);
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

      await invoke(session, undefined);

      const envelope = sendSpy.mock.calls[0]![0] as Envelope;
      const decoded = client.protoRegistry.decodeKnownPayload(MODE_TASK, messageType, envelope.payload);
      expect(decoded).toMatchObject({ assignee: 'alice' });
    },
  );

  it.each(TASK_ACTIONS)(
    'issue #108.5: $name defaults assignee to the resolved sender when explicitly empty',
    async ({ messageType, invoke }) => {
      const client = makeClient();
      const session = new TaskSession(client);
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

      await invoke(session, '');

      const envelope = sendSpy.mock.calls[0]![0] as Envelope;
      const decoded = client.protoRegistry.decodeKnownPayload(MODE_TASK, messageType, envelope.payload);
      expect(decoded).toMatchObject({ assignee: 'alice' });
    },
  );

  // Negative case for issue #108.5: an explicitly-supplied non-empty assignee
  // must be preserved, not overwritten by the resolved sender. Fails on a
  // mutation that unconditionally sets assignee = sender.
  it.each(TASK_ACTIONS)(
    'issue #108.5: $name preserves an explicitly-supplied assignee',
    async ({ messageType, invoke }) => {
      const client = makeClient();
      const session = new TaskSession(client);
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

      await invoke(session, 'bob');

      const envelope = sendSpy.mock.calls[0]![0] as Envelope;
      const decoded = client.protoRegistry.decodeKnownPayload(MODE_TASK, messageType, envelope.payload);
      expect(decoded).toMatchObject({ assignee: 'bob' });
    },
  );

  // Issue #108.4/4d: start()'s input type gained an `auth` field. Fails on old
  // code: previously start() ignored a per-call `auth` entirely, so a
  // conflicting per-call `auth.expectedSender` could never surface here.
  it('issue #108.4: start() with a per-call auth.expectedSender conflicting with sender throws MacpIdentityMismatchError', async () => {
    // Client-level auth is deliberately permissive (no expectedSender) so this
    // test only passes if start() actually threads input.auth into senderFor()
    // — makeClient()'s expectedSender:'alice' would make this vacuous, since
    // sender:'mallory' would conflict with the client credential regardless.
    // Auth.bearer(token, senderHintString) (the legacy 2-arg form), not
    // Auth.devAgent -- since issue #124, devAgent also sets expectedSender,
    // which would make this vacuous the same way (client.test.ts:153's
    // precedent for this legacy-permissive construction).
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.bearer('devtok', 'alice'),
    });
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(
      session.start({
        intent: 'delegate',
        participants: ['alice', 'bob'],
        ttlMs: 10_000,
        sender: 'mallory',
        auth: Auth.bearer('tok', { expectedSender: 'alice' }),
      }),
    ).rejects.toBeInstanceOf(MacpIdentityMismatchError);
  });

  it('issue #108.4: start() forwards a per-call auth to client.send', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const perCallAuth = Auth.bearer('carol-token', { expectedSender: 'carol' });

    await session.start({
      intent: 'delegate',
      participants: ['alice', 'bob'],
      ttlMs: 10_000,
      sender: 'carol',
      auth: perCallAuth,
    });

    expect(sendSpy.mock.calls[0]![1]).toMatchObject({ auth: perCallAuth });
  });
});

describe('TaskSession — lifecycle delegation', () => {
  it('cancel() delegates to client.cancelSession with the session id', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    const spy = vi
      .spyOn(client, 'cancelSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_CANCELLED' });

    const ack = await session.cancel('done');
    expect(ack.sessionState).toBe('SESSION_STATE_CANCELLED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'done', expect.objectContaining({ raiseOnNack: true }));
  });

  it('suspend() delegates to client.suspendSession with the session id', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    const spy = vi
      .spyOn(client, 'suspendSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_SUSPENDED' });

    const ack = await session.suspend('pausing');
    expect(ack.sessionState).toBe('SESSION_STATE_SUSPENDED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'pausing', expect.objectContaining({ raiseOnNack: true }));
  });

  it('resume() delegates to client.resumeSession with the session id', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    const spy = vi.spyOn(client, 'resumeSession').mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_OPEN' });

    const ack = await session.resume('back');
    expect(ack.sessionState).toBe('SESSION_STATE_OPEN');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'back', expect.objectContaining({ raiseOnNack: true }));
  });
});
