# Building Orchestrators

The SDK provides typed action builders and state projections. **Policy logic** — voting
rules, decision strategies, AI heuristics — belongs in the **orchestrator layer** above
the SDK. (Note: the runtime also exposes a *governance* policy engine that evaluates
declarative rules at commitment time — see
[Runtime Policy](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md).
Use it to enforce hard constraints like quorum thresholds or veto rights; keep dynamic
strategy logic in your orchestrator.)

## Architecture reminder

```
Runtime API (Rust)  — enforces protocol, transitions, replay
       ↑
Language SDK         — typed models, action builders, projections   ← you use this
       ↑
Orchestrator         — your decision logic, policies, strategies    ← you build this
       ↑
Application          — your product/service
```

## Pattern: Policy-driven decision orchestrator

```typescript
import { Auth, DecisionSession, MacpClient } from 'macp-sdk-typescript';

async function runDecision(
  client: MacpClient,
  intent: string,
  participants: string[],
  proposals: Array<{ proposalId: string; option: string; rationale: string }>,
): Promise<{ status: 'resolved' | 'cancelled'; winner?: string }> {
  const auth = Auth.devAgent('orchestrator');
  const session = new DecisionSession(client, { auth });
  // The orchestrator is the implicit sender of propose()/commit() below (via the
  // session's own `auth`), and Decision mode's default governance policy requires
  // every mode-action's sender to be a declared participant — so 'orchestrator' must
  // be in the session's participant list even if the caller's own `participants` (the
  // voting agents) didn't include it. Omitting it fails `propose()` with `FORBIDDEN`.
  const sessionParticipants = participants.includes('orchestrator')
    ? participants
    : ['orchestrator', ...participants];
  await session.start({ intent, participants: sessionParticipants, ttlMs: 120_000 });

  // Submit proposals
  for (const { proposalId, option, rationale } of proposals) {
    await session.propose({ proposalId, option, rationale });
  }

  // Collect votes (in a real system, agents vote asynchronously, each with its own
  // credential — this orchestrator submits on their behalf, so it must override `auth`
  // per call: `Auth.devAgent(x)` always binds `expectedSender: x` (src/auth.ts), and the
  // session's own `auth` is the orchestrator's identity, not the voter's).
  for (const participant of participants) {
    if (participant === 'orchestrator') continue; // the orchestrator doesn't vote on its own proposals
    // Your policy logic: ask each agent to vote
    const vote = await askAgentForVote(participant, session.sessionId);
    await session.vote({
      proposalId: vote.proposalId,
      vote: vote.choice,
      sender: participant,
      auth: Auth.devAgent(participant),
    });
  }

  // Apply your policy: majority wins
  const proj = session.projection;
  const winner = proj.majorityWinner();

  if (winner && !proj.hasBlockingObjection(winner)) {
    await session.commit({
      action: 'approved',
      authorityScope: 'my-domain',
      reason: `Majority selected ${winner}`,
    });
    return { status: 'resolved', winner };
  } else {
    await session.cancel('No majority or blocking objection');
    return { status: 'cancelled' };
  }
}
```

## Pattern: Multi-stage pipeline

Combine multiple modes in sequence — Decision to pick a plan, Quorum to approve it, Task
to delegate the work:

```typescript
import { DecisionSession, QuorumSession, TaskSession, type AuthConfig, type MacpClient } from 'macp-sdk-typescript';

async function deploymentPipeline(client: MacpClient, coordinatorAuth: AuthConfig): Promise<void> {
  // Stage 1: Decision — majorityWinner() resolves to a proposalId, not a deployable
  // artifact; look up what that proposal actually proposed before using it downstream.
  const decision = new DecisionSession(client, { auth: coordinatorAuth });
  await decision.start({ intent: 'pick version', participants: ['a', 'b', 'c'], ttlMs: 60_000 });
  // ... proposals, votes, commit ...
  const winningProposalId = decision.projection.majorityWinner();

  // Stage 2: Quorum approval
  const quorum = new QuorumSession(client, { auth: coordinatorAuth });
  await quorum.start({
    intent: `approve deploy of ${winningProposalId}`,
    participants: ['r1', 'r2', 'r3'],
    ttlMs: 60_000,
  });
  await quorum.requestApproval({
    requestId: 'req-1',
    action: 'deploy',
    summary: `Deploy proposal ${winningProposalId}`,
    requiredApprovals: 2,
  });
  // ... collect approvals ...

  // Stage 3: Task delegation
  const task = new TaskSession(client, { auth: coordinatorAuth });
  await task.start({
    intent: `deploy proposal ${winningProposalId}`,
    participants: ['coordinator', 'deploy-agent'],
    ttlMs: 300_000,
  });
  await task.requestTask({
    taskId: 't1',
    title: `Deploy proposal ${winningProposalId}`,
    instructions: '...',
    requestedAssignee: 'deploy-agent',
  });
  // ... wait for completion ...
}
```

## Pattern: Supervisor and observer

Use `listSessions()` + `SessionLifecycleWatcher` to build a supervisor that tracks every
session in the registry — no need to pre-register session ids or poll `getSession()`.
Both calls return **all** sessions to any authenticated identity, not a per-tenant/agent
view (see [Session Discovery § Authorisation](session-discovery.md#authorisation)) —
if you need isolation between agent groups, enforce it in front of these RPCs, not by
relying on scoping that doesn't exist:

```typescript
import { Auth, MacpClient, SessionLifecycleWatcher, isSessionCreated, isTerminalSessionLifecycleEvent } from 'macp-sdk-typescript';

const supervisor = new MacpClient({
  address: 'runtime:50051',
  auth: Auth.bearer('tok-supervisor', { expectedSender: 'supervisor' }),
});
await supervisor.initialize();

// Snapshot on startup
for (const meta of await supervisor.listSessions()) {
  console.log('seen', meta.sessionId, meta.mode, meta.state);
}

// React to live events
for await (const event of new SessionLifecycleWatcher(supervisor).changes()) {
  if (isSessionCreated(event) && event.session?.state === 'SESSION_STATE_OPEN') {
    spawnMonitor(event.session.sessionId);
  } else if (isTerminalSessionLifecycleEvent(event) && event.session) {
    reconcile(event.session.sessionId, event.eventType);
  }
}
```

The runtime emits one `CREATED` event per session **currently in the registry** at
subscribe time — not just `OPEN` ones, since a terminal session lingers for up to
`MACP_SESSION_RETENTION_SECS` after it started (see [Session Discovery § Startup
snapshot semantics](session-discovery.md#startup-snapshot-semantics)) — so the watcher
is safe to (re)start at any point, but a `CREATED` event alone doesn't mean "spawn a
monitor": check `event.session.state` too, or an already-terminal session that hasn't
aged out yet gets monitored as if it were live. `event.session` itself can also be
`undefined` on a live (post-sync) event if the session was evicted before the event
reached you — guard it rather than assuming it's always present. See [Session
Discovery](session-discovery.md) for the full `listSessions`/`SessionLifecycleWatcher`
walkthrough this pattern builds on.

## Pattern: Event-driven orchestrator

Use streaming to react to accepted envelopes in real time:

```typescript
const stream = client.openStream({ auth: coordinatorAuth });

for await (const envelope of stream.responses()) {
  if (envelope.messageType === 'Vote') {
    // Check if we have enough votes to commit
    session.projection.applyEnvelope(envelope, client.protoRegistry);
    const winner = session.projection.majorityWinner();
    if (winner) {
      await session.commit({ action: 'approved', authorityScope: 'my-domain', reason: `Majority selected ${winner}` });
      break;
    }
  } else if (envelope.messageType === 'Commitment') {
    break;
  }
}
```

> **This feeds `session.projection` from two directions at once.** `session.vote(...)` /
> `session.commit(...)` / any other `*Session` action already applies its own envelope
> locally, on `ack.ok`, to `session.projection` (each mode session's own private
> `sendAndTrack`, e.g. `DecisionSession.sendAndTrack` — see
> [Architecture § Projections](architecture.md#projections)). The
> loop above *also* feeds that same object every envelope the stream delivers, including
> ones this process just sent through the session — a double apply on the same
> projection instance.
>
> **This is safe.** `BaseProjection.applyEnvelope` is idempotent on `messageId`
> (RFC-MACP-0006 §3.2) — applying the same envelope twice is a no-op, so the double apply
> above never corrupts `votes`, `transcript`, or any other derived state. See
> [Projections § Design intent: shared projection instance](../api/projections.md#design-intent-shared-projection-instance) for
> why this topology is reachable at all: `Participant` and the mode session it wraps
> deliberately share one projection instance, so the local apply-on-ACK and a later
> replay-apply can land on the same instance for the same envelope — by design, not by
> accident. For a genuine duplicate — a second, distinct `Vote`/ballot with its own
> `messageId` from a sender who already voted — check `session.projection.anomalies` /
> `hasAnomalies` rather than assuming the stream fed it twice.
>
> *If you also use `macp-sdk-python`:* that SDK's `Participant` never constructs a
> `BaseSession`, so its stream-fed projection and a hand-built session's projection are
> never the same instance there — this SDK's shared-instance topology is a deliberate,
> SDK-specific choice, not a cross-SDK guarantee. Don't assume the topology transfers if
> you work across both.

## What NOT to put in the SDK

These belong in your orchestrator, not in the SDK:

- **Voting rules**: "2/3 majority required" → orchestrator policy
- **AI decision heuristics**: "use an LLM to evaluate proposals" → orchestrator logic
- **Timeout strategies**: "wait 30s for votes, then commit with what we have" → orchestrator timing
- **Escalation logic**: "if no quorum in 5min, escalate to a manager" → orchestrator workflow
- **Notification logic**: "email stakeholders when committed" → orchestrator side-effects

The SDK's projections give you the **facts** (vote counts, proposal states, ballot
tallies). Your orchestrator decides **what to do** with those facts.

## Related

- [`examples/agent-policy-aware.ts`](../../examples/agent-policy-aware.ts) — a runnable
  `Participant` built from `functionEvaluator`/`functionVoter`/`functionCommitter`
  strategies that read the session's `policyVersion`, the closest concrete analogue to
  the "Policy-driven decision orchestrator" pattern above.
- [Agent Framework](agent-framework.md) for the `Participant`/`Strategies` abstractions
  these patterns are built from, when you want the SDK to drive the event loop for you
  instead of hand-rolling one.
