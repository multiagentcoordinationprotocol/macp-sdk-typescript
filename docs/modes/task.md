# Task Mode

**Mode identifier**: `macp.mode.task.v1`
**Participant model**: orchestrated
**Determinism**: structural-only

## Purpose

Bounded task delegation from a coordinator (initiator) to an assignee, with progress tracking through to completion or failure.

> **Canonical references**: [RFC-MACP-0009 (Task Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0009-task-mode.md) is normative for the state machine, authority rules, and validation constraints. See also the [spec mode summaries](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/modes.md#standard-mode-summaries) and [runtime modes guide › Task Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#task-mode) for validation as implemented. This page covers the TypeScript API.

## Session Lifecycle

```
SessionStart → TaskRequest → TaskAccept/TaskReject
                                   │
                              TaskUpdate (0..n)
                                   │
                          TaskComplete / TaskFail
                                   │
                              Commitment
```

## API

### TaskSession

```typescript
import { TaskSession } from 'macp-sdk-typescript';

const session = new TaskSession(client);
await session.start({ intent: '...', participants: ['worker'], ttlMs: 120_000 });
```

#### Methods

| Method | Message Type | Description |
|--------|-------------|-------------|
| `requestTask(input)` | `TaskRequest` | Define the task (coordinator only) |
| `acceptTask(input)` | `TaskAccept` | Accept the assignment |
| `rejectTask(input)` | `TaskReject` | Decline the assignment |
| `updateTask(input)` | `TaskUpdate` | Report progress |
| `completeTask(input)` | `TaskComplete` | Mark task as done |
| `failTask(input)` | `TaskFail` | Mark task as failed |
| `commit(input)` | `Commitment` | Finalize the session |

Like every mode session, `TaskSession` also exposes the shared lifecycle
helpers — `metadata()`, `cancel(reason)`, `suspend(reason)`, `resume(reason)`,
and `openStream()`. `suspend()` (proto 0.1.3+) is a non-terminal pause: the
runtime banks the remaining TTL and rejects messages until `resume()` restores
`SESSION_STATE_OPEN` and the banked TTL. See
[Decision Mode → Lifecycle helpers](decision.md#lifecycle-helpers).

### Request a Task

```typescript
await session.requestTask({
  taskId: 't1',
  title: 'Implement login page',
  instructions: 'Build a login form with email/password, OAuth, and MFA',
  requestedAssignee: 'worker',
  deadlineUnixMs: Date.now() + 3600_000,  // optional, 1 hour
});
```

### Accept / Reject

```typescript
// Worker accepts
await session.acceptTask({
  taskId: 't1',
  assignee: 'worker',
  reason: 'starting now',
  sender: 'worker',
  auth: Auth.devAgent('worker'),
});

// Or worker rejects
await session.rejectTask({
  taskId: 't1',
  assignee: 'worker',
  reason: 'no capacity',
  sender: 'worker',
  auth: Auth.devAgent('worker'),
});
```

### Progress Updates

```typescript
await session.updateTask({
  taskId: 't1',
  status: 'in_progress',
  progress: 0.5,       // 0.0 to 1.0
  message: 'form layout complete, starting validation',
  sender: 'worker',
  auth: Auth.devAgent('worker'),
});
```

### Complete / Fail

```typescript
// Success
await session.completeTask({
  taskId: 't1',
  assignee: 'worker',
  output: Buffer.from(JSON.stringify({ artifact: 'login-page-v1' })),
  summary: 'Login page with email/password and OAuth',
  sender: 'worker',
  auth: Auth.devAgent('worker'),
});

// Failure
await session.failTask({
  taskId: 't1',
  assignee: 'worker',
  errorCode: 'DEPENDENCY_UNAVAILABLE',
  reason: 'OAuth provider API is down',
  retryable: true,
  sender: 'worker',
  auth: Auth.devAgent('worker'),
});
```

**Important**: `TaskComplete` and `TaskFail` do **not** resolve the session. Only `Commitment` does.

## TaskProjection

### State

| Property | Type | Description |
|----------|------|-------------|
| `tasks` | `Map<string, TaskRecord>` | Tasks with status and progress |
| `updates` | `TaskUpdateRecord[]` | All progress updates |
| `completions` | `TaskCompletionRecord[]` | Completion records |
| `failures` | `TaskFailureRecord[]` | Failure records |
| `transcript` | `Envelope[]` | All accepted envelopes |
| `phase` | `'Pending' \| 'Requested' \| 'InProgress' \| 'Completed' \| 'Failed' \| 'Committed'` | Current phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload if resolved |

### TaskRecord Status

| Status | Meaning |
|--------|---------|
| `requested` | Task created, awaiting acceptance |
| `accepted` | Assignee accepted |
| `rejected` | Assignee declined |
| `in_progress` | Work underway (set on first TaskUpdate) |
| `completed` | TaskComplete received |
| `failed` | TaskFail received |

### Query Helpers

```typescript
session.projection.getTask('t1');         // full TaskRecord
session.projection.progressOf('t1');      // 0.0 - 1.0
session.projection.isAccepted('t1');      // true while status is accepted/in_progress
session.projection.isComplete('t1');      // true after TaskComplete
session.projection.isFailed('t1');        // true after TaskFail
session.projection.isRetryable('t1');     // true if failure was retryable
session.projection.activeTasks();         // tasks in requested/accepted/in_progress
session.projection.latestProgress();      // progress of the most recent TaskUpdate
session.projection.isCommitted;           // true once a Commitment is applied
```

## External orchestrator (runtime ≥ 0.5.0)

The initiator (orchestrator) **need not be a member of `participants`**.
RFC-MACP-0009 authorizes `TaskRequest` by the initiator *role*, not by
membership, so a coordinator can start and drive a task session it does not
participate in. The participant pool must still contain **at least one eligible
assignee other than the initiator**. `TaskSession.start()` does not require
initiator membership, so no code change is needed to use this.

> Handoff mode is different: it still requires the initiator to be a participant
> (the delegated model is intrinsic to
> [RFC-MACP-0010 (Handoff Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0010-handoff-mode.md) §2).

## RFC Validation Rules

The runtime enforces the cross-message rules — at most one `TaskRequest` per
session (base v1), accept/reject only from the requested assignee, one active
assignee at a time, updates/completions/failures only from the active assignee,
and initiator-only Commitment (the initiator need not be in `participants`, but
the pool must include at least one non-initiator assignee). The normative rule
set lives in RFC-MACP-0009 §4; the
[runtime modes guide › Task Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#task-mode)
documents validation as implemented.

## Example

See [`examples/task-smoke.ts`](../../examples/task-smoke.ts).
