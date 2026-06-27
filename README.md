# macp-sdk-typescript

TypeScript SDK for the [Multi-Agent Coordination Protocol (MACP)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol) runtime. Connects TypeScript/Node.js applications to the Rust MACP runtime over gRPC.

## Install

```bash
npm install macp-sdk-typescript
```

The SDK depends on `@multiagentcoordinationprotocol/proto` from GitHub Packages. Create a `.npmrc` in your project root:

```
@multiagentcoordinationprotocol:registry=https://npm.pkg.github.com
```

And configure a GitHub PAT with `read:packages` scope:

```bash
npm config set //npm.pkg.github.com/:_authToken YOUR_GITHUB_PAT
```

## Quick Start

```typescript
import { Auth, MacpClient, DecisionSession } from 'macp-sdk-typescript';

const client = new MacpClient({
  address: '127.0.0.1:50051',
  secure: false,
  allowInsecure: true, // local dev only; production must use TLS
  auth: Auth.devAgent('coordinator'),
});

await client.initialize();

const session = new DecisionSession(client);
await session.start({
  intent: 'pick a deployment strategy',
  participants: ['alice', 'bob'],
  ttlMs: 60_000,
});

await session.propose({ proposalId: 'p1', option: 'canary', rationale: 'low risk' });

await session.vote({
  proposalId: 'p1',
  vote: 'approve',
  sender: 'alice',
  auth: Auth.devAgent('alice'),
});

const winner = session.projection.majorityWinner();
await session.commit({
  action: 'deployment.approved',
  authorityScope: 'release',
  reason: `winner=${winner}`,
});

client.close();
```

## Architecture

The SDK uses a **three-layer** design:

- **Low-level transport** (`MacpClient`): typed wrappers around every `MACPRuntimeService` RPC — `initialize`, `send`, `openStream`, `getSession`, `cancelSession`, `suspendSession`, `resumeSession`, `listSessions`, `getManifest`, `listModes`, `listRoots`, `listExtModes`, `registerExtMode`, `unregisterExtMode`, `promoteMode`, the policy RPCs (`register`/`unregister`/`get`/`listPolicies`), plus streaming watchers (`ModeRegistryWatcher`, `RootsWatcher`, `SignalWatcher`, `PolicyWatcher`, `SessionLifecycleWatcher`).
- **High-level session helpers**: one class per coordination mode (`DecisionSession`, `ProposalSession`, `TaskSession`, `HandoffSession`, `QuorumSession`) — wraps `MacpClient`, builds envelopes, encodes payloads, and maintains a local state projection.
- **Agent framework** (`src/agent/`): event-driven `Participant` with strategy-based handlers, bootstrap runner (`fromBootstrap`), gRPC/HTTP transports, and the optional cancel-callback HTTP server.

See [`docs/guides/architecture.md`](docs/guides/architecture.md) for the full map.

Every session class follows the same pattern:
1. Construct with a `MacpClient` and options
2. Call `start()` to initiate the session
3. Call mode-specific methods (propose, vote, accept, etc.)
4. Call `commit()` to finalize
5. Read `session.projection` for local state

### Session Start Options

All `start()` methods accept `contextId` and `extensions` for session-level metadata:

```typescript
await session.start({
  intent: 'pick a deployment strategy',
  participants: ['alice', 'bob'],
  ttlMs: 60_000,
  contextId: 'ctx-abc',                           // optional opaque context reference
  extensions: { 'x-trace': Buffer.from('tid') },  // optional typed extension buffers
  roots: [{ uri: 'file:///workspace', name: 'repo' }],
});
```

## Coordination Modes

### Decision Mode

Structured decision with proposals, evaluations, objections, and votes.

```typescript
import { DecisionSession } from 'macp-sdk-typescript';

const session = new DecisionSession(client);
await session.start({ intent: '...', participants: ['alice'], ttlMs: 60_000 });
await session.propose({ proposalId: 'p1', option: 'A', rationale: '...' });
await session.evaluate({ proposalId: 'p1', recommendation: 'approve', confidence: 0.9 });
await session.raiseObjection({ proposalId: 'p1', reason: 'risk', severity: 'high' });
await session.vote({ proposalId: 'p1', vote: 'approve' });
await session.commit({ action: 'decided', authorityScope: 'team', reason: '...' });

// Projection queries
session.projection.voteTotals();                 // { p1: 1 }
session.projection.majorityWinner();             // 'p1'
session.projection.hasBlockingObjection('p1');   // true (severity: high)
```

### Proposal Mode

Proposal and counterproposal negotiation.

```typescript
import { ProposalSession } from 'macp-sdk-typescript';

const session = new ProposalSession(client);
await session.start({ intent: '...', participants: ['bob'], ttlMs: 60_000 });
await session.propose({ proposalId: 'p1', title: 'Plan A', summary: '...' });
await session.counterPropose({ proposalId: 'p2', supersedesProposalId: 'p1', title: 'Plan B' });
await session.accept({ proposalId: 'p2', reason: 'better' });
await session.commit({ action: 'proposal.accepted', authorityScope: 'team', reason: '...' });

// Projection queries
session.projection.activeProposals();            // proposals with status 'open'
session.projection.isAccepted('p2');             // true
session.projection.isTerminallyRejected('p1');   // false
```

### Task Mode

Bounded task delegation.

```typescript
import { TaskSession } from 'macp-sdk-typescript';

const session = new TaskSession(client);
await session.start({ intent: '...', participants: ['worker'], ttlMs: 120_000 });
await session.requestTask({ taskId: 't1', title: 'Build feature', instructions: '...' });
await session.acceptTask({ taskId: 't1', assignee: 'worker' });
await session.updateTask({ taskId: 't1', status: 'working', progress: 0.5, message: 'halfway' });
await session.completeTask({ taskId: 't1', assignee: 'worker', summary: 'done' });
await session.commit({ action: 'task.completed', authorityScope: 'lead', reason: '...' });

// Projection queries
session.projection.progressOf('t1');   // 1.0
session.projection.isComplete('t1');   // true
session.projection.activeTasks();      // []
```

### Handoff Mode

Responsibility transfer between participants.

```typescript
import { HandoffSession } from 'macp-sdk-typescript';

const session = new HandoffSession(client);
await session.start({ intent: '...', participants: ['bob'], ttlMs: 60_000 });
await session.offer({ handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' });
await session.addContext({ handoffId: 'h1', contentType: 'application/json', context: buf });
await session.acceptHandoff({ handoffId: 'h1', acceptedBy: 'bob' });
await session.commit({ action: 'handoff.accepted', authorityScope: 'team', reason: '...' });

// Projection queries
session.projection.isAccepted('h1');      // true
session.projection.pendingHandoffs();     // []
```

### Quorum Mode

Threshold-based approval voting.

```typescript
import { QuorumSession } from 'macp-sdk-typescript';

const session = new QuorumSession(client);
await session.start({ intent: '...', participants: ['alice', 'bob', 'carol'], ttlMs: 60_000 });
await session.requestApproval({ requestId: 'r1', action: 'deploy', summary: '...', requiredApprovals: 2 });
await session.approve({ requestId: 'r1', reason: 'ok' });
await session.commit({ action: 'quorum.approved', authorityScope: 'ops', reason: '...' });

// Projection queries
session.projection.hasQuorum('r1');              // true/false
session.projection.approvalCount('r1');          // number
session.projection.remainingVotesNeeded('r1');   // number
session.projection.votedSenders('r1');           // string[]
```

## Agent Framework

The `agent` module provides event-driven abstractions for building MACP participants.

### Participant

`Participant` wraps a session, projection, and transport into a single event-driven handler:

```typescript
import { agent } from 'macp-sdk-typescript';

const participant = new agent.Participant({
  participantId: 'evaluator',
  sessionId: 'sid-123',
  mode: 'macp.mode.decision.v1',
  client,
  transport: new agent.GrpcTransportAdapter(client, 'sid-123', auth),
});

participant
  .on('Proposal', async (msg, ctx) => {
    await ctx.actions.evaluate({
      proposalId: msg.payload.proposalId,
      recommendation: 'APPROVE',
      confidence: 0.95,
    });
  })
  .onTerminal(async (result) => {
    console.log('session ended:', result.reason);
  });

await participant.run();
```

### Bootstrap Runner

`fromBootstrap()` creates a fully-wired `Participant` from a JSON bootstrap file (typically provided by the runtime orchestrator):

```typescript
import { agent } from 'macp-sdk-typescript';

// Reads from path argument or MACP_BOOTSTRAP_FILE env var
const participant = agent.fromBootstrap('./bootstrap.json');
participant.on('Proposal', handler);
await participant.run();
```

Bootstrap files can include an `initiator` section for participants that start the session:

```json
{
  "session_id": "sid-123",
  "participant_id": "coordinator",
  "mode": "macp.mode.decision.v1",
  "runtime_address": "localhost:50051",
  "initiator": {
    "session_start": {
      "intent": "pick deployment strategy",
      "participants": ["coordinator", "evaluator"],
      "ttl_ms": 60000,
      "roots": [{ "uri": "file:///workspace" }]
    },
    "kickoff": {
      "message_type": "Proposal",
      "payload": { "proposalId": "p1", "option": "canary" }
    }
  }
}
```

### Strategies

Composable handler factories for Decision Mode — register them directly on a
`Participant`:

```typescript
participant
  .on('Proposal', agent.evaluationHandler(agent.functionEvaluator(async (p) => ({
    recommendation: 'APPROVE', confidence: 0.9, reason: 'looks good',
  }))))
  .on('Evaluation', agent.votingHandler(agent.majorityVoter({ positiveThreshold: 0.6 })))
  .on('Vote', agent.commitmentHandler(agent.majorityCommitter({ quorumSize: 2 })));
```

Each layer has a prebuilt and a function-wrapper form: `functionEvaluator`,
`functionVoter`, `functionCommitter` (zero-ceremony wrappers) next to
`majorityVoter` / `majorityCommitter` (batteries-included defaults). Full
reference: [`docs/api/strategies.md`](docs/api/strategies.md).

### Cancel Callback

Long-running agents can expose an HTTP endpoint that an orchestrator POSTs to
in order to request a clean shutdown (RFC-MACP-0001 §7.2 Option A). Bootstrap
JSON with a `cancel_callback: { host, port, path }` block auto-wires the
server via `fromBootstrap()`; for the manual path use
`startCancelCallbackServer(...)` + `Participant.attachCancelCallbackServer(...)`.
See [`docs/api/cancel-callback.md`](docs/api/cancel-callback.md) and
[`examples/cancel-callback.ts`](examples/cancel-callback.ts).

## Authentication

```typescript
// Development (uses x-macp-agent-id header)
const auth = Auth.devAgent('my-agent');

// Production (Bearer token with authenticated identity — RFC-MACP-0004 §4).
// The SDK refuses to emit an envelope whose `sender` differs from
// `expectedSender`, so bugs surface locally instead of as runtime NACKs.
const auth = Auth.bearer('token-value', { expectedSender: 'alice' });

// Legacy form — bearer with only a sender hint, no identity guard:
const loose = Auth.bearer('token-value', 'alice');
```

Pass `auth` to the client constructor for default auth, or per-method for multi-agent scenarios:

```typescript
await session.vote({
  proposalId: 'p1',
  vote: 'approve',
  sender: 'alice',
  auth: Auth.devAgent('alice'),
});
```

## TLS

TLS is on by default (RFC-MACP-0006 §3). To connect to an insecure runtime
during local development, you must opt out explicitly:

```typescript
const client = new MacpClient({
  address: '127.0.0.1:50051',
  secure: false,
  allowInsecure: true, // must be paired with secure: false
  auth,
});
```

Omit `allowInsecure` in production — the constructor throws when `secure: false` is passed without it.

## Streaming

### Session Streaming

```typescript
const stream = client.openStream({ auth });
await stream.send(envelope);

for await (const envelope of stream.responses()) {
  console.log(envelope.messageType, envelope.sender);
}

stream.close();
```

To attach to a session that is already in flight and receive accepted history before live broadcast (RFC-MACP-0006 §3.2 passive subscribe):

```typescript
const stream = client.openStream({ auth });
await stream.sendSubscribe(sessionId);            // full replay then live
// or, after a reconnect:
await stream.sendSubscribe(sessionId, lastSeq);    // resume from cursor
```

The agent framework's `GrpcTransportAdapter` calls this for you on start, so non-initiator agents see `SessionStart` regardless of join order.

### Registry & Root Watchers

```typescript
import { ModeRegistryWatcher, RootsWatcher } from 'macp-sdk-typescript';

const watcher = new ModeRegistryWatcher(client, { auth });

// Async iterator with abort support
const controller = new AbortController();
for await (const change of watcher.changes(controller.signal)) {
  console.log('registry changed at', change.observedAtUnixMs);
}

// Or one-shot
const next = await watcher.nextChange();
```

## Error Handling

```typescript
import { MacpAckError, MacpTransportError } from 'macp-sdk-typescript';

try {
  await session.vote({ proposalId: 'p1', vote: 'approve' });
} catch (err) {
  if (err instanceof MacpAckError) {
    console.log(err.ack.error?.code); // 'SESSION_NOT_OPEN', etc.
  } else if (err instanceof MacpTransportError) {
    console.log('gRPC connectivity issue');
  }
}
```

## Development

```bash
npm run build              # Compile TypeScript
npm run check              # Type-check only
npm run lint               # ESLint
npm run format             # Prettier
npm test                   # Run unit + conformance tests
npm run test:watch         # Watch mode
npm run test:coverage      # With coverage
npm run test:integration   # Integration tests (requires Docker runtime)
```

### Integration Tests

Run the full SDK against a live MACP runtime:

```bash
# Build and start the runtime
docker build -t macp-runtime ../macp-runtime/
docker run -d --name macp-runtime-test -p 50051:50051 \
  -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 \
  -e MACP_ALLOW_DEV_SENDER_HEADER=1 -e MACP_MEMORY_ONLY=1 macp-runtime

# Run tests
npm run test:integration

# Clean up
docker rm -f macp-runtime-test
```

## Runtime Boundary

This SDK is a **client** for the MACP Rust runtime. The runtime handles session state, message ordering, deduplication, TTL enforcement, and mode-specific validation. The SDK provides typed helpers for building and sending envelopes, and local projections for tracking state client-side.

## License

Apache-2.0
