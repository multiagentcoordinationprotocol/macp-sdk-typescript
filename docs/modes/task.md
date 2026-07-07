# Task Mode

**Mode identifier**: `macp.mode.task.v1`
**Participant model**: orchestrated
**Determinism**: structural-only

## Purpose

Bounded task delegation from a coordinator (initiator) to an assignee, with progress tracking through to completion or failure.

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
| `request(input)` | `TaskRequest` | Define the task (coordinator only) |
| `acceptTask(input)` | `TaskAccept` | Accept the assignment |
| `rejectTask(input)` | `TaskReject` | Decline the assignment |
| `update(input)` | `TaskUpdate` | Report progress |
| `complete(input)` | `TaskComplete` | Mark task as done |
| `fail(input)` | `TaskFail` | Mark task as failed |
| `commit(input)` | `Commitment` | Finalize the session |

### Request a Task

```typescript
await session.request({
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
await session.update({
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
await session.complete({
  taskId: 't1',
  assignee: 'worker',
  output: Buffer.from(JSON.stringify({ artifact: 'login-page-v1' })),
  summary: 'Login page with email/password and OAuth',
  sender: 'worker',
  auth: Auth.devAgent('worker'),
});

// Failure
await session.fail({
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
| `phase` | `'Requesting' \| 'InProgress' \| 'Completed' \| 'Failed' \| 'Committed'` | Current phase |

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
session.projection.isComplete('t1');      // true after TaskComplete
session.projection.isFailed('t1');        // true after TaskFail
session.projection.isRetryable('t1');     // true if failure was retryable
session.projection.activeTasks();         // tasks in requested/accepted/in_progress
```

## External orchestrator (runtime ≥ 0.5.0)

The initiator (orchestrator) **need not be a member of `participants`**.
RFC-MACP-0009 authorizes `TaskRequest` by the initiator *role*, not by
membership, so a coordinator can start and drive a task session it does not
participate in. The participant pool must still contain **at least one eligible
assignee other than the initiator**. `TaskSession.start()` does not require
initiator membership, so no code change is needed to use this.

> Handoff mode is different: it still requires the initiator to be a participant
> (the delegated model is intrinsic to RFC-MACP-0010 §2).

## RFC Validation Rules

1. At most one `TaskRequest` per session (base v1)
2. `TaskAccept`/`TaskReject` must come from the requested assignee
3. Only one assignee may be active at a time
4. `TaskUpdate`/`TaskComplete`/`TaskFail` must come from the active assignee
5. Only the initiator can emit `Commitment`
6. The initiator need not be in `participants`; the pool must include ≥1 non-initiator assignee

## Example

See [`examples/task-smoke.ts`](../../examples/task-smoke.ts).
