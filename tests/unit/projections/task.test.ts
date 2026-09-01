import { describe, it, expect, beforeEach } from 'vitest';
import { TaskProjection } from '../../../src/projections/task';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_TASK } from '../../../src/constants';

const registry = new ProtoRegistry();

function makeEnvelope(messageType: string, payload: Record<string, unknown>, sender = 'coordinator') {
  return buildEnvelope({
    mode: MODE_TASK,
    messageType,
    sessionId: 'test-session',
    sender,
    payload: registry.encodeKnownPayload(MODE_TASK, messageType, payload),
  });
}

describe('TaskProjection', () => {
  let projection: TaskProjection;

  beforeEach(() => {
    projection = new TaskProjection();
  });

  it('starts in Pending phase', () => {
    expect(projection.phase).toBe('Pending');
  });

  it('tracks task requests and transitions to Requested phase', () => {
    projection.applyEnvelope(
      makeEnvelope('TaskRequest', { taskId: 't1', title: 'Build feature', instructions: 'implement it' }),
      registry,
    );
    expect(projection.tasks.size).toBe(1);
    const task = projection.getTask('t1');
    expect(task).toMatchObject({ taskId: 't1', title: 'Build feature', status: 'requested', progress: 0 });
    expect(projection.phase).toBe('Requested');
  });

  it('tracks task acceptance', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker' }, 'worker'), registry);

    expect(projection.getTask('t1')?.status).toBe('accepted');
    expect(projection.getTask('t1')?.assignee).toBe('worker');
    expect(projection.phase).toBe('InProgress');
  });

  // RFC-MACP-0009 §5 rules 3/3a (`:69-71`): the first accepted TaskAccept
  // designates the active assignee; a second TaskAccept must not reassign it.
  it('first-accept-wins: a second TaskAccept does not overwrite the assignee', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-b' }, 'worker-b'), registry);

    expect(projection.getTask('t1')?.assignee).toBe('worker-a');
    expect(projection.getTask('t1')?.status).toBe('accepted');
  });

  // Old (wrong) behaviour: TaskAccept overwrote `assignee` unconditionally,
  // so whichever TaskAccept arrived last "won" the assignment with no rule
  // behind it (Phase 3, site 8 — a shipped violation of RFC-MACP-0009 §5
  // rule 3a).
  it('does not let a later TaskAccept silently reassign the task', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-b' }, 'worker-b'), registry);

    expect(projection.getTask('t1')?.assignee).not.toBe('worker-b');
  });

  it('tracks task rejection', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(
      makeEnvelope('TaskReject', { taskId: 't1', assignee: 'worker', reason: 'too busy' }, 'worker'),
      registry,
    );
    expect(projection.getTask('t1')?.status).toBe('rejected');
  });

  it('tracks progress updates', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
    projection.applyEnvelope(
      makeEnvelope('TaskUpdate', { taskId: 't1', status: 'working', progress: 0.5, message: 'halfway' }, 'w'),
      registry,
    );

    expect(projection.progressOf('t1')).toBe(0.5);
    expect(projection.getTask('t1')?.status).toBe('in_progress');
    expect(projection.updates).toHaveLength(1);
  });

  it('tracks task completion', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
    projection.applyEnvelope(
      makeEnvelope('TaskComplete', { taskId: 't1', assignee: 'w', summary: 'done' }, 'w'),
      registry,
    );

    expect(projection.isComplete('t1')).toBe(true);
    expect(projection.progressOf('t1')).toBe(1);
    expect(projection.phase).toBe('Completed');
    expect(projection.completions).toHaveLength(1);
  });

  it('tracks task failure', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
    projection.applyEnvelope(
      makeEnvelope('TaskFail', { taskId: 't1', assignee: 'w', errorCode: 'E1', reason: 'crash', retryable: true }, 'w'),
      registry,
    );

    expect(projection.isFailed('t1')).toBe(true);
    expect(projection.isRetryable('t1')).toBe(true);
    expect(projection.phase).toBe('Failed');
  });

  it('non-retryable failure', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
    projection.applyEnvelope(
      makeEnvelope('TaskFail', { taskId: 't1', assignee: 'w', reason: 'permanent' }, 'w'),
      registry,
    );
    expect(projection.isRetryable('t1')).toBe(false);
  });

  it('activeTasks filters correctly', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't2', title: 'B', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
    projection.applyEnvelope(
      makeEnvelope('TaskComplete', { taskId: 't1', assignee: 'w', summary: 'done' }, 'w'),
      registry,
    );

    const active = projection.activeTasks();
    expect(active).toHaveLength(1);
    expect(active[0].taskId).toBe('t2');
  });

  it('progressOf returns 0 for unknown task', () => {
    expect(projection.progressOf('nope')).toBe(0);
  });

  it('latestProgress returns undefined when no updates exist', () => {
    expect(projection.latestProgress()).toBeUndefined();
  });

  it('latestProgress returns progress from most recent update', () => {
    projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
    projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
    projection.applyEnvelope(
      makeEnvelope('TaskUpdate', { taskId: 't1', status: 'working', progress: 0.3, message: 'started' }, 'w'),
      registry,
    );
    expect(projection.latestProgress()).toBe(0.3);

    projection.applyEnvelope(
      makeEnvelope('TaskUpdate', { taskId: 't1', status: 'working', progress: 0.7, message: 'almost done' }, 'w'),
      registry,
    );
    expect(projection.latestProgress()).toBe(0.7);
  });
});
