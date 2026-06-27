# Agent Framework

The agent framework provides a high-level `Participant` abstraction for building event-driven agents that participate in MACP coordination sessions. Instead of manually managing gRPC streams and protobuf encoding, you register handlers for message types and let the framework dispatch incoming messages.

## Quick Start

```typescript
import { agent } from 'macp-sdk-typescript';

const participant = agent.fromBootstrap('./bootstrap.json');

participant
  .on('Proposal', async (msg, ctx) => {
    ctx.log('Received proposal', { option: msg.payload.option });
    await ctx.actions.evaluate({
      proposalId: msg.payload.proposalId,
      recommendation: 'approve',
      confidence: 0.9,
      reason: 'Meets criteria',
    });
  })
  .on('Evaluation', async (msg, ctx) => {
    await ctx.actions.vote({
      proposalId: msg.payload.proposalId,
      vote: 'approve',
      reason: 'Evaluation looks good',
    });
  })
  .onTerminal((result) => {
    console.log('Session resolved:', result.state);
  });

await participant.run();
```

## Core Components

### Participant

The central class that wraps a session, projection, transport, and dispatcher. Created via `ParticipantConfig` or the `fromBootstrap()` factory.

```typescript
import { Participant, type ParticipantConfig } from 'macp-sdk-typescript/agent';
import { MacpClient, Auth, MODE_DECISION } from 'macp-sdk-typescript';

const config: ParticipantConfig = {
  participantId: 'agent-1',
  sessionId: 'session-123',
  mode: MODE_DECISION,
  client: new MacpClient({ address: 'localhost:50051', auth: Auth.devAgent('agent-1') }),
  auth: Auth.devAgent('agent-1'),
  policyVersion: 'policy.fraud.majority-veto',
};

const participant = new Participant(config);
```

**Handler registration** uses a fluent API:

- `.on(messageType, handler)` — React to a specific message type (or `'*'` for all)
- `.onPhaseChange(phase, handler)` — React when the projection phase changes (e.g., `'Voting'`, `'Committed'`)
- `.onTerminal(handler)` — Called when the session reaches a terminal state

### Handler Context

Every handler receives `(message, ctx)` where `ctx` provides:

```typescript
interface HandlerContext {
  participant: { participantId, sessionId, mode };
  projection: { phase, transcript };
  actions: SessionActions;   // evaluate, vote, propose, commit, send, etc.
  session: SessionInfo;      // sessionId, mode, participants, policyVersion
  log: (msg, details?) => void;
}
```

### fromBootstrap()

Factory that reads a JSON file containing session assignment details and creates a fully-configured `Participant`:

```typescript
import { agent } from 'macp-sdk-typescript';

// Reads from file path
const p = agent.fromBootstrap('./bootstrap.json');

// Or from MACP_BOOTSTRAP_FILE env var
const p2 = agent.fromBootstrap();
```

**Bootstrap payload format:**
```json
{
  "session_id": "session-123",
  "participant_id": "agent-1",
  "mode": "macp.mode.decision.v1",
  "runtime_address": "localhost:50051",
  "auth_token": "optional-bearer-token",
  "agent_id": "optional-agent-id",
  "mode_version": "1.0.0",
  "policy_version": "policy.default",
  "secure": true,
  "allow_insecure": false,
  "participants": ["agent-1", "agent-2"]
}
```

| Field | Required | Behaviour |
|-------|----------|-----------|
| `session_id` | yes | UUID v4/v7 or base64url 22+ chars (runtime validator). |
| `participant_id` | yes | Authenticated sender this agent will use. |
| `mode` | yes | One of the five standard mode identifiers or an extension mode. |
| `runtime_address` | yes | gRPC endpoint (`host:port`). Alias: `runtime_url`. |
| `auth_token` | no | Bearer token. When present, the runner constructs `Auth.bearer(auth_token, { expectedSender: participant_id })` so the SDK's identity guard rejects forged senders before any RPC. |
| `agent_id` | no | Only used when `auth_token` is absent, to drive `Auth.devAgent(agent_id ?? participant_id)`. |
| `secure` | no | Defaults to `true` (TLS). |
| `allow_insecure` | no | Must be `true` when `secure` is `false`; otherwise `MacpClient` throws. |
| `mode_version`, `configuration_version`, `policy_version` | no | Version strings forwarded to the session helper. |
| `participants` | no | Optional participant roster, passed through to `ParticipantConfig`. |
| `initiator.session_start.context_id` | no | Upstream context identifier (RFC-MACP-0007). Forwarded to the mode-session `start()` as `contextId`. |
| `initiator.session_start.extensions` | no | Map of extension metadata (RFC-MACP-0008). JSON-native values are UTF-8 JSON-encoded by the runner to satisfy the envelope's `Record<string, Buffer>` contract; pre-encoded `Buffer` / `Uint8Array` values pass through unchanged. |

### Example: initiator with context + extensions

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "participant_id": "agent-1",
  "mode": "macp.mode.decision.v1",
  "runtime_address": "localhost:50051",
  "auth_token": "<jwt>",
  "initiator": {
    "session_start": {
      "intent": "decide deployment",
      "participants": ["agent-1", "agent-2"],
      "ttl_ms": 30000,
      "context_id": "ctx-run-42",
      "extensions": {
        "aitp.tct": { "token": "t-abc", "issuer": "iss-1" }
      }
    },
    "kickoff": {
      "message_type": "Proposal",
      "payload": { "proposalId": "p1", "option": "canary" }
    }
  }
}
```

`Participant.run()` emits `SessionStart` with both fields on the wire before dispatching the kickoff. Non-initiator agents receive them via the replay path described in the transport section below.

## Strategies

Strategy objects are composable handler factories for common Decision Mode patterns. They decouple the decision logic from the handler wiring.

See [`docs/api/strategies.md`](../api/strategies.md) for the full reference —
the examples below are a tour, not an exhaustive list.

### Evaluation Strategy

Automatically evaluates proposals:

```typescript
import { agent } from 'macp-sdk-typescript';

const handler = agent.evaluationHandler(
  agent.functionEvaluator(async (proposal, session) => ({
    recommendation: proposal.option === 'deploy' ? 'approve' : 'reject',
    confidence: 0.85,
    reason: 'Automated evaluation',
  })),
);

participant.on('Proposal', handler);
```

### Voting Strategy

Automatically votes after evaluations:

```typescript
// Built-in: vote based on evaluation majority
participant.on('Evaluation', agent.votingHandler(agent.majorityVoter()));

// Custom threshold
participant.on('Evaluation', agent.votingHandler(
  agent.majorityVoter({ positiveThreshold: 0.8 }),
));

// Function form — no class needed
participant.on('Evaluation', agent.votingHandler(
  agent.functionVoter(
    (p) => p.evaluations.length >= 2,
    async () => ({ vote: 'APPROVE', reason: 'quorum of evaluations reached' }),
  ),
));
```

### Commitment Strategy

Automatically commits when conditions are met:

```typescript
participant.on('Vote', agent.commitmentHandler(
  agent.majorityCommitter({
    quorumSize: 3,
    action: 'deploy',
    authorityScope: 'production',
  }),
));

// Function form
participant.on('Vote', agent.commitmentHandler(
  agent.functionCommitter(
    (p) => (p.voteTotals()['APPROVE'] ?? 0) >= 2,
    async (p) => ({ action: 'decided', authorityScope: 'team', reason: `winner=${p.majorityWinner()}` }),
  ),
));
```

## Cancel Callback

Long-running agents can expose a local HTTP endpoint that an orchestrator
POSTs to in order to request shutdown (RFC-MACP-0001 §7.2 Option A). If the
bootstrap JSON includes a `cancel_callback` block, `Runner.fromBootstrap()`
starts the server on `participant.run()` and tears it down when `run()`
exits:

```json
{
  "cancel_callback": { "host": "127.0.0.1", "port": 47321, "path": "/cancel" }
}
```

For the full API — `startCancelCallbackServer`, `CancelCallbackServer`,
`CancelHandler`, and `Participant.attachCancelCallbackServer` — see
[`docs/api/cancel-callback.md`](../api/cancel-callback.md). A runnable demo
lives at [`examples/cancel-callback.ts`](../../examples/cancel-callback.ts).

## Transports

Transports abstract how messages are received. Two built-in options:

### GrpcTransportAdapter (default)

Uses `MacpClient.openStream()` for real-time bidirectional streaming. This is the default when no transport is specified.

On start, the adapter sends a subscribe-only frame (`sendSubscribe(sessionId)`) so the runtime replays every accepted envelope for the session before switching to live broadcast (RFC-MACP-0006-A1). That is what lets a non-initiator `Participant` attach to a session at any point and still see the `SessionStart` + prior `Proposal` / `Vote` / … envelopes — spawn order and connection timing no longer matter.

### HttpTransportAdapter

Polls an HTTP endpoint for events. Useful when gRPC is not available:

```typescript
import { HttpTransportAdapter } from 'macp-sdk-typescript/agent';

const transport = new HttpTransportAdapter({
  baseUrl: 'http://localhost:3000',
  sessionId: 'session-123',
  participantId: 'agent-1',
  pollIntervalMs: 1000,
  authToken: 'optional-token',
});

const participant = new Participant({
  ...config,
  transport,
});
```

## Mode Support

The `Participant` automatically creates the correct session and projection for all 5 standard modes:

| Mode | Actions Available |
|------|-------------------|
| Decision | `evaluate`, `vote`, `raiseObjection`, `propose`, `commit`, `send` |
| Proposal | `propose`, `commit`, `send` |
| Task | `commit`, `send` |
| Handoff | `commit`, `send` |
| Quorum | `commit`, `send` |

For extension modes, a fallback `DecisionProjection` is used and only `send` is available.

## Lifecycle

1. **Create** — `new Participant(config)` or `fromBootstrap()`
2. **Register handlers** — `.on()`, `.onPhaseChange()`, `.onTerminal()`
3. **Run** — `await participant.run()` starts consuming messages
4. **Terminal** — When the projection reaches `Committed`, `Resolved`, or `Cancelled`, the terminal handler fires and `run()` returns
5. **Stop** — Call `await participant.stop()` to stop early
