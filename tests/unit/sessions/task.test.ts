import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { TaskSession } from '../../../src/task';
import { MacpAckError } from '../../../src/errors';

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

  it('requestTask() records a requested task in activeTasks()', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'look it over' });
    expect(session.projection.activeTasks().map((t) => t.taskId)).toEqual(['t1']);
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

  it('completeTask() flips isComplete()', async () => {
    const client = makeClient();
    const session = new TaskSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestTask({ taskId: 't1', title: 'review', instructions: 'x' });
    await session.completeTask({ taskId: 't1', assignee: 'bob', summary: 'done' });
    expect(session.projection.isComplete('t1')).toBe(true);
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
