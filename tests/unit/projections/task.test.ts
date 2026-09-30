import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskProjection } from '../../../src/projections/task';
import type {
  TaskCompleteRecord,
  TaskCompletionRecord,
  TaskFailRecord,
  TaskFailureRecord,
} from '../../../src/projections/task';
import type {
  TaskCompleteRecord as IndexTaskCompleteRecord,
  TaskCompletionRecord as IndexTaskCompletionRecord,
  TaskFailRecord as IndexTaskFailRecord,
  TaskFailureRecord as IndexTaskFailureRecord,
} from '../../../src/index';
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

  // Issue #71 — RFC-MACP-0009 §5 rule 3 (`:69`): "Only one assignee may become
  // active for the Session in base v1." The guard is per-SESSION, not
  // per-`task_id`, so two TaskRequests in one transcript share one slot.
  describe('rule 3 is session-scoped, not task-scoped (issue #71)', () => {
    it('a second TaskAccept for a DIFFERENT task_id cannot take the session assignee slot', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't2', title: 'B', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't2', assignee: 'worker-b' }, 'worker-b'),
        registry,
      );

      expect(projection.getTask('t1')?.assignee).toBe('worker-a');
      expect(projection.getTask('t2')?.assignee).toBeUndefined();
      expect(projection.getTask('t2')?.status).toBe('requested');
    });

    it('a discarded TaskAccept does not advance phase to InProgress on its own', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 'unknown-task', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      expect(projection.phase).toBe('Requested');
      expect(projection.tasks.size).toBe(1);
    });

    // Issue #111 — TaskComplete/TaskFail must not advance phase for a
    // task_id this projection never saw a TaskRequest for, mirroring the
    // TaskAccept guard directly above.
    it('a TaskComplete for an unknown task_id does not advance phase to Completed', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskComplete', { taskId: 'unknown-task', assignee: 'worker-a', summary: 'done' }, 'worker-a'),
        registry,
      );
      expect(projection.phase).toBe('Requested');
      expect(projection.tasks.size).toBe(1);
    });

    it('a TaskFail for an unknown task_id does not advance phase to Failed', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskFail', { taskId: 'unknown-task', assignee: 'worker-a', reason: 'x' }, 'worker-a'),
        registry,
      );
      expect(projection.phase).toBe('Requested');
      expect(projection.tasks.size).toBe(1);
    });
  });

  // Issue #126/#128: `duplicate_task_accept` anomaly recording for a
  // discarded `TaskAccept`, now that the guard split (see `task.ts`'s
  // `TaskAccept` case) distinguishes "unrequested task_id" (still a silent
  // no-op) from "a separately-requested task_id losing the session's one
  // assignee slot" (now an anomaly).
  describe('duplicate_task_accept anomaly (issue #126/#128)', () => {
    it('AC1: a second TaskAccept for the SAME task_id records exactly one anomaly naming that task_id', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-b' }, 'worker-b'),
        registry,
      );

      expect(projection.anomalies).toHaveLength(1);
      expect(projection.anomalies[0]).toMatchObject({
        kind: 'duplicate_task_accept',
        sender: 'worker-b',
        subjectId: 't1',
      });
      expect(projection.anomalies[0]?.detail).toContain('worker-a');
      expect(projection.anomalies[0]?.detail).toContain('t1');
    });

    it('AC2: a TaskAccept for a task_id with no TaskRequest on file records zero anomalies', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 'unknown-task', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );

      expect(projection.anomalies).toHaveLength(0);
      expect(projection.hasAnomalies).toBe(false);
    });

    it('AC3: a TaskAccept for a DIFFERENT, separately-requested task_id competing for an already-held slot records one anomaly naming the LOSING task_id, with detail naming the holder sender and task_id', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't2', title: 'B', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't2', assignee: 'worker-b' }, 'worker-b'),
        registry,
      );

      expect(projection.anomalies).toHaveLength(1);
      const anomaly = projection.anomalies[0];
      expect(anomaly).toMatchObject({
        kind: 'duplicate_task_accept',
        sender: 'worker-b',
        // Names the LOSING task (t2, whose accept was just discarded) --
        // not t1, which already holds the slot.
        subjectId: 't2',
      });
      // detail names the holder via both activeAssignment.sender and .taskId.
      expect(anomaly?.detail).toContain('worker-a');
      expect(anomaly?.detail).toContain('t1');
    });
  });

  // Issue #70 — RFC-MACP-0009 §5 rule 3c (`:72`), mirroring `macp-runtime`
  // `crates/macp-modes/src/mode/task.rs:257-260`.
  describe('TaskReject frees the session assignee slot when the rejecter held it (issue #70)', () => {
    it('clears the assignee so a later TaskAccept can reassign', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskReject', { taskId: 't1', assignee: 'worker-a', reason: 'blocked' }, 'worker-a'),
        registry,
      );

      expect(projection.getTask('t1')?.assignee).toBeUndefined();
      expect(projection.getTask('t1')?.status).toBe('rejected');

      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-b' }, 'worker-b'),
        registry,
      );

      expect(projection.getTask('t1')?.assignee).toBe('worker-b');
      expect(projection.getTask('t1')?.status).toBe('accepted');
      expect(projection.phase).toBe('InProgress');
    });

    it('a TaskReject from someone who is NOT the active assignee leaves the assignment intact', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskReject', { taskId: 't1', assignee: 'worker-c', reason: 'not mine' }, 'worker-c'),
        registry,
      );

      expect(projection.getTask('t1')?.assignee).toBe('worker-a');

      // The slot is still held, so a competing accept is still discarded.
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-b' }, 'worker-b'),
        registry,
      );
      expect(projection.getTask('t1')?.assignee).toBe('worker-a');
    });

    it('a reject that frees the slot clears the assignee on the task the slot was taken on', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'A', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't2', title: 'B', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      // Non-conforming shape: the slot holder rejects citing the other task.
      projection.applyEnvelope(
        makeEnvelope('TaskReject', { taskId: 't2', assignee: 'worker-a', reason: 'wrong task' }, 'worker-a'),
        registry,
      );

      expect(projection.getTask('t1')?.assignee).toBeUndefined();
      expect(projection.getTask('t2')?.status).toBe('rejected');
    });

    it('a TaskReject with no active assignee at all is a no-op for assignment', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskReject', { taskId: 't1', assignee: 'worker-a', reason: 'too busy' }, 'worker-a'),
        registry,
      );
      expect(projection.getTask('t1')?.assignee).toBeUndefined();

      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-b' }, 'worker-b'),
        registry,
      );
      expect(projection.getTask('t1')?.assignee).toBe('worker-b');
    });

    it('a TaskReject for an unknown task_id from the slot holder still frees the slot', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'worker-a' }, 'worker-a'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskReject', { taskId: 'nope', assignee: 'worker-a', reason: 'x' }, 'worker-a'),
        registry,
      );
      expect(projection.getTask('t1')?.assignee).toBeUndefined();
      expect(projection.getTask('t1')?.status).toBe('accepted');
    });
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

    expect(projection.isCompleted('t1')).toBe(true);
    expect(projection.progressOf('t1')).toBe(1);
    expect(projection.phase).toBe('Completed');
    expect(projection.completions).toHaveLength(1);
  });

  describe('deprecated isComplete alias', () => {
    it('returns true after the same TaskRequest/TaskAccept/TaskComplete sequence as isCompleted', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskComplete', { taskId: 't1', assignee: 'w', summary: 'done' }, 'w'),
        registry,
      );

      expect(projection.isComplete('t1')).toBe(true);
    });

    it('returns false on a fresh projection with no tasks at all', () => {
      expect(projection.isComplete('t1')).toBe(false);
    });

    it('returns false for an unknown taskId even when a different task is completed', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskComplete', { taskId: 't1', assignee: 'w', summary: 'done' }, 'w'),
        registry,
      );

      expect(projection.isComplete('unknown')).toBe(false);
    });

    it('cannot diverge from isCompleted at any point in the task lifecycle', () => {
      expect(projection.isComplete('t1')).toBe(projection.isCompleted('t1'));
      expect(projection.isComplete('t1')).toBe(false);

      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
      expect(projection.isComplete('t1')).toBe(projection.isCompleted('t1'));
      expect(projection.isComplete('t1')).toBe(false);

      projection.applyEnvelope(
        makeEnvelope('TaskComplete', { taskId: 't1', assignee: 'w', summary: 'done' }, 'w'),
        registry,
      );
      expect(projection.isComplete('t1')).toBe(projection.isCompleted('t1'));
      expect(projection.isComplete('t1')).toBe(true);
    });

    it('delegates to isCompleted rather than duplicating its logic', () => {
      const spy = vi.spyOn(projection, 'isCompleted');
      projection.isComplete('t1');
      expect(spy).toHaveBeenCalledWith('t1');
    });
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

  // Type-only renames (TaskCompletionRecord -> TaskCompleteRecord, TaskFailureRecord ->
  // TaskFailRecord) have no runtime behavior. No CI gate type-checks this file
  // (tsconfig.json's `include` is src/**/*.ts only, and vitest.config.ts configures no
  // `typecheck` block), so the type annotations below document consumer intent but are
  // NOT themselves a compile-time proof. The two things that actually prove the aliases
  // are well-formed and exported are `npm run check` (type-checks src/projections/task.ts,
  // where both aliases are declared) and, after `npm run build`, a real consumer-style
  // resolution of all four names through the package's declared `exports["."].types`
  // entry point (`dist/index.d.ts`) and its `export *` chain into
  // `dist/projections/task.d.ts` — declaration emit here is per-module, not bundled, so
  // the names don't appear as a flat string in `dist/index.d.ts` itself.
  describe('deprecated record type aliases', () => {
    it('types the projection arrays under their new names', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskComplete', { taskId: 't1', assignee: 'w', summary: 'done' }, 'w'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskFail', { taskId: 'never-requested', assignee: 'w', reason: 'n/a' }, 'w'),
        registry,
      );

      const c: TaskCompleteRecord[] = projection.completions;
      const f: TaskFailRecord[] = projection.failures;
      expect(c).toHaveLength(1);
      expect(c[0]?.taskId).toBe('t1');
      expect(f).toHaveLength(1);
      expect(f[0]?.taskId).toBe('never-requested');
    });

    it('keeps the deprecated aliases assignable both directions', () => {
      projection.applyEnvelope(makeEnvelope('TaskRequest', { taskId: 't1', title: 'X', instructions: 'do' }), registry);
      projection.applyEnvelope(makeEnvelope('TaskAccept', { taskId: 't1', assignee: 'w' }, 'w'), registry);
      projection.applyEnvelope(
        makeEnvelope('TaskComplete', { taskId: 't1', assignee: 'w', summary: 'done' }, 'w'),
        registry,
      );
      projection.applyEnvelope(
        makeEnvelope('TaskFail', { taskId: 't1', assignee: 'w', reason: 'boom', retryable: true }, 'w'),
        registry,
      );
      const completionRecord = projection.completions[0]!;
      const failureRecord = projection.failures[0]!;

      const viaOldCompletion: TaskCompletionRecord = completionRecord;
      const viaNewCompletion: TaskCompleteRecord = viaOldCompletion;
      expect(viaNewCompletion).toBe(completionRecord);

      const viaOldFailure: TaskFailureRecord = failureRecord;
      const viaNewFailure: TaskFailRecord = viaOldFailure;
      expect(viaNewFailure).toBe(failureRecord);
    });

    it('reaches the public barrel through the export * wildcard chain', () => {
      const completion: IndexTaskCompletionRecord = { taskId: 't1', assignee: 'w', sender: 'w' };
      const complete: IndexTaskCompleteRecord = completion;
      const failure: IndexTaskFailureRecord = { taskId: 't1', assignee: 'w', retryable: false, sender: 'w' };
      const fail: IndexTaskFailRecord = failure;

      expect(complete).toEqual(completion);
      expect(fail).toEqual(failure);
    });
  });
});
