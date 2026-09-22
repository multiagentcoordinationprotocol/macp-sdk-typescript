import { MODE_TASK } from '../constants';
import { BaseProjection } from './base';
import type { Envelope } from '../types';
import type { ProtoRegistry } from '../proto-registry';

export interface TaskRecord {
  taskId: string;
  title: string;
  instructions: string;
  requestedAssignee?: string;
  assignee?: string;
  deadlineUnixMs?: number;
  status: 'requested' | 'accepted' | 'rejected' | 'in_progress' | 'completed' | 'failed';
  progress: number;
  sender: string;
}

export interface TaskUpdateRecord {
  taskId: string;
  status: string;
  progress: number;
  message?: string;
  sender: string;
}

export interface TaskCompletionRecord {
  taskId: string;
  assignee: string;
  summary?: string;
  sender: string;
}

export interface TaskFailureRecord {
  taskId: string;
  assignee: string;
  errorCode?: string;
  reason?: string;
  retryable: boolean;
  sender: string;
}

export class TaskProjection extends BaseProjection {
  protected readonly mode = MODE_TASK;
  readonly tasks = new Map<string, TaskRecord>();
  readonly updates: TaskUpdateRecord[] = [];
  readonly completions: TaskCompletionRecord[] = [];
  readonly failures: TaskFailureRecord[] = [];
  phase: 'Pending' | 'Requested' | 'InProgress' | 'Completed' | 'Failed' | 'Committed' = 'Pending';

  /**
   * The **session-level** active assignment: who currently holds the session's
   * single assignee slot, and which `task_id` they took it on.
   *
   * RFC-MACP-0009 §5 rule 3 (`:69`): "Only one assignee may become active for
   * the Session in base v1." The constraint is scoped to the *Session*, not to
   * a `task_id` — rule 1 (`:67`) separately caps a v1 session at one
   * `TaskRequest`, so in a conforming transcript the two scopes coincide, but
   * an unfiltered transcript carrying two `TaskRequest`s must not be able to
   * hand out two active assignees. That is why this is one field on the
   * projection rather than a per-`TaskRecord` flag (issue #71).
   *
   * `sender` is the envelope sender, not `TaskAcceptPayload.assignee`, to
   * mirror the reference runtime: `macp-runtime`
   * `crates/macp-modes/src/mode/task.rs:211` sets `state.active_assignee =
   * Some(env.sender)` after rejecting any payload whose `assignee` disagrees
   * with the sender (`:205-207`). `taskId` is retained so a reject can clear
   * the right `TaskRecord.assignee` even on a multi-task transcript.
   */
  private activeAssignment?: { sender: string; taskId: string };

  /** Handle a Task-mode envelope. See `BaseProjection.applyEnvelope` for the accepted-only input contract and redelivery/rollback semantics shared by all built-in modes. */
  protected applyMode(envelope: Envelope, protoRegistry: ProtoRegistry): void {
    const payload = protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload);
    switch (envelope.messageType) {
      case 'TaskRequest': {
        const record = payload as {
          taskId: string;
          title: string;
          instructions: string;
          requestedAssignee?: string;
          deadlineUnixMs?: number;
        };
        this.tasks.set(record.taskId, {
          taskId: record.taskId,
          title: record.title,
          instructions: record.instructions,
          requestedAssignee: record.requestedAssignee,
          deadlineUnixMs: record.deadlineUnixMs,
          status: 'requested',
          progress: 0,
          sender: envelope.sender,
        });
        this.phase = 'Requested';
        break;
      }
      case 'TaskAccept': {
        const record = payload as { taskId: string; assignee: string };
        const task = this.tasks.get(record.taskId);
        // RFC-MACP-0009 §5 rules 3/3a (`:69-70`): "Only one assignee may
        // become active for the Session in base v1. The first accepted
        // `TaskAccept` from any eligible participant designates that
        // participant as the active assignee. Subsequent `TaskAccept`
        // messages for the same session MUST be rejected if an active
        // assignee is already designated." A conforming runtime rejects the
        // second `TaskAccept` before it reaches accepted history
        // (`macp-runtime` `crates/macp-modes/src/mode/task.rs:184-186`); this
        // guard makes the projection first-accept-wins too, so a rogue second
        // one (e.g. an unfiltered transcript) cannot silently reassign.
        //
        // The guard is keyed on the SESSION slot (`activeAssignment`), not on
        // `task.assignee`, because rule 3's scope is the Session (issue #71).
        // Two `TaskRequest`s in one transcript therefore share one assignee
        // slot, matching the runtime, whose `TaskState` holds a single
        // `active_assignee` (`task.rs:70`) alongside a single `task`.
        //
        // Rule 3c's policy-gated reassignment (`allow_reassignment_on_reject`,
        // RFC-MACP-0012 `:135`) is reachable here via the `TaskReject` case
        // below, which frees the slot — see its comment for why that needs no
        // policy input.
        //
        // An anomaly would be recorded when this guard discards a second
        // `TaskAccept`, but `ProjectionAnomalyKind` (`base.ts:8-9`) is
        // deliberately frozen pending cross-SDK agreement with
        // macp-sdk-python.
        if (task && this.activeAssignment === undefined) {
          task.assignee = record.assignee;
          task.status = 'accepted';
          this.activeAssignment = { sender: envelope.sender, taskId: record.taskId };
          this.phase = 'InProgress';
        }
        break;
      }
      case 'TaskReject': {
        const record = payload as { taskId: string };
        const task = this.tasks.get(record.taskId);
        if (task) task.status = 'rejected';
        // RFC-MACP-0009 §5 rule 3c (`:72`): "When policy sets
        // `allow_reassignment_on_reject: true` and the active assignee sends
        // `TaskReject`, the session returns to the pre-assignment state. Other
        // eligible participants MAY then send `TaskAccept` for the same
        // `task_id`." Mirrors `macp-runtime`
        // `crates/macp-modes/src/mode/task.rs:257-260`, which clears
        // `active_assignee` only when the ACTIVE assignee is the rejecter —
        // a reject from anyone else never frees the slot (`task.rs:241-244`
        // rejects it as `InvalidPayload`).
        //
        // Deliberately NOT gated on the session policy, and it does not need
        // to be. The runtime gates the reassignment twice — it denies the
        // active assignee's `TaskReject` (`task.rs:223-239`) and the follow-up
        // `TaskAccept` (`task.rs:187-204`) with `PolicyDenied` when
        // `allow_reassignment_on_reject` is false — and a projection is a view
        // of history the runtime ALREADY ACCEPTED (see this method's
        // accepted-only input contract). A reassignment the runtime denied
        // never reaches the transcript, so tracking the reject unconditionally
        // cannot diverge from the runtime on any real transcript, and it needs
        // no new API surface (threading a `PolicyDefinition` into the
        // constructor would). Issue #70, option 2.
        if (this.activeAssignment?.sender === envelope.sender) {
          const held = this.tasks.get(this.activeAssignment.taskId);
          if (held) held.assignee = undefined;
          this.activeAssignment = undefined;
        }
        break;
      }
      case 'TaskUpdate': {
        const record = payload as { taskId: string; status: string; progress: number; message?: string };
        this.updates.push({ ...record, sender: envelope.sender });
        const task = this.tasks.get(record.taskId);
        if (task) {
          task.progress = record.progress;
          task.status = 'in_progress';
        }
        break;
      }
      case 'TaskComplete': {
        const record = payload as { taskId: string; assignee: string; summary?: string };
        this.completions.push({ ...record, sender: envelope.sender });
        const task = this.tasks.get(record.taskId);
        if (task) {
          task.status = 'completed';
          task.progress = 1;
        }
        this.phase = 'Completed';
        break;
      }
      case 'TaskFail': {
        const record = payload as {
          taskId: string;
          assignee: string;
          errorCode?: string;
          reason?: string;
          retryable?: boolean;
        };
        this.failures.push({ ...record, retryable: record.retryable ?? false, sender: envelope.sender });
        const task = this.tasks.get(record.taskId);
        if (task) task.status = 'failed';
        this.phase = 'Failed';
        break;
      }
      default:
        break;
    }
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  isComplete(taskId: string): boolean {
    return this.tasks.get(taskId)?.status === 'completed';
  }

  isFailed(taskId: string): boolean {
    return this.tasks.get(taskId)?.status === 'failed';
  }

  isRetryable(taskId: string): boolean {
    return this.failures.some((f) => f.taskId === taskId && f.retryable);
  }

  progressOf(taskId: string): number {
    return this.tasks.get(taskId)?.progress ?? 0;
  }

  activeTasks(): TaskRecord[] {
    const active = new Set<TaskRecord['status']>(['requested', 'accepted', 'in_progress']);
    return [...this.tasks.values()].filter((t) => active.has(t.status));
  }

  isAccepted(taskId: string): boolean {
    const status = this.tasks.get(taskId)?.status;
    return status === 'accepted' || status === 'in_progress';
  }

  latestProgress(): number | undefined {
    return this.updates[this.updates.length - 1]?.progress;
  }
}
