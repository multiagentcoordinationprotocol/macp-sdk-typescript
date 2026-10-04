# Direct-agent authentication (SDK ≥ 0.2.0)

Agents are expected to authenticate to the MACP runtime **directly** with their own
Bearer identity. The orchestrator / control-plane does not forge envelopes on behalf of
agents. This matches RFC-MACP-0004 §4 ("`sender` MUST be derived from authenticated
identity"). See [`CHANGELOG.md` § 0.2.0](../../CHANGELOG.md) for when this hardening
landed in this SDK.

For the runtime side of identity binding (token validators, sender derivation, dev-mode
fallback), see [Runtime API § Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#authentication)
and [Runtime Deployment § Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#authentication).

This guide shows two agents talking to the same session directly — no orchestrator
forwards envelopes on their behalf — plus the production `fromBootstrap()` path that
wires the same pattern from a JSON file.

## Bootstrap from the orchestrator

In production, an orchestrator (examples-service, scenario compiler, CLI — whatever
produces a run) pre-allocates a session id and hands each agent a bootstrap JSON file
that `agent.fromBootstrap(bootstrapPath?: string): Participant` reads to construct the
client, auth, session, and `Participant` for you. Its real shape (`BootstrapPayload`,
snake_case on the wire) is:

```typescript
interface BootstrapPayload {
  session_id: string;
  participant_id: string;
  mode: string;
  mode_version?: string;
  configuration_version?: string;
  policy_version?: string;
  runtime_address?: string;
  runtime_url?: string; // alternative to runtime_address; fromBootstrap() reads either
  auth_token?: string;
  agent_id?: string; // dev-mode identity override; defaults to participant_id when unset
  secure?: boolean;
  allow_insecure?: boolean; // local dev only; production requires TLS (see Security guide)
  participants?: string[];
  initiator?: {
    session_start: {
      intent: string;
      participants: string[];
      ttl_ms: number;
      max_suspend_ms?: number;
      mode_version?: string;
      configuration_version?: string;
      policy_version?: string;
      context?: Record<string, unknown>;
      context_id?: string;
      extensions?: Record<string, string | Buffer | Uint8Array>;
      roots?: Array<{ uri: string; name?: string }>;
    };
    kickoff?: { message_type: string; payload_type?: string; payload: Record<string, unknown> };
  };
  metadata?: Record<string, unknown>;
  cancel_callback?: { host: string; port: number; path: string };
}
```

Only the `initiator` block is present on the initiator agent's bootstrap file; a
non-initiator's bootstrap omits it. `agent_id` is the only way to give a dev-mode agent an
identity that differs from `participant_id` — without it, `fromBootstrap()` falls back to
`participant_id` for `Auth.devAgent`. A handful of fields are accepted but currently
**not** threaded through by `fromBootstrap()` — don't rely on them yet: `kickoff.
payload_type`, `initiator.session_start.context`, the nested `mode_version`/
`configuration_version`/`policy_version` trio (the top-level ones are what's actually
used), and top-level `metadata`. `MACP_BOOTSTRAP_FILE` is the default path env var if you
don't pass one explicitly. See [Agent Framework](agent-framework.md) for the full
`Participant`/`fromBootstrap()` walkthrough.

The two patterns below are **deliberately hand-rolled, not `fromBootstrap()`-based** —
they build `Auth`, `MacpClient`, and `DecisionSession` directly from environment
variables, which is a useful minimal reference for understanding what `fromBootstrap()`
automates, or for a script that doesn't want the full `Participant` abstraction.

> **This template fails open.** Both patterns below use
> `bearerToken ? Auth.bearer(...) : Auth.devAgent(participantId)` — if the expected bearer
> env var (`MACP_INITIATOR_BEARER`, `MACP_ALICE_BEARER`) is unset or misspelled,
> `bearerToken` is `undefined` and the agent silently falls back to self-asserted
> `Auth.devAgent` identity instead of erroring. That's convenient for local dev (the same
> code runs with or without real credentials) but means a missing env var in production
> degrades verified bearer auth to an unverified identity claim with no warning. See
> [Security § SDK-side production checklist](security.md#sdk-side-production-checklist) —
> "never `Auth.devAgent` in prod" — before deploying this pattern; a production variant
> should throw if `bearerToken` is unset rather than falling back.

## Initiator agent

The initiator owns `SessionStart`. It is the agent whose identity the runtime records as
`session.initiator`, and the only participant authorised to commit (unless policy
delegates otherwise). Full runnable version: [`examples/direct-agent-auth-initiator.ts`](../../examples/direct-agent-auth-initiator.ts).

```typescript
import { Auth, DecisionSession, MacpClient, newSessionId } from 'macp-sdk-typescript';

const sessionId = process.env.MACP_SESSION_ID ?? newSessionId();
const participantId = 'coordinator';
const bearerToken = process.env.MACP_INITIATOR_BEARER;

const auth = bearerToken
  ? Auth.bearer(bearerToken, { expectedSender: participantId })
  : Auth.devAgent(participantId);

const client = new MacpClient({
  address: process.env.MACP_RUNTIME_TARGET ?? process.env.MACP_RUNTIME_ADDRESS ?? '127.0.0.1:50051',
  secure: false,
  allowInsecure: true, // local dev only; production requires TLS
  auth,
});

await client.initialize();

// 1. Unary SessionStart — the runtime binds session.initiator to this agent's identity.
const session = new DecisionSession(client, { sessionId, auth });
await session.start({
  intent: 'pick a deployment plan',
  participants: [participantId, 'alice', 'bob'],
  ttlMs: 60_000,
});

// 2. Emit the kickoff envelope (the first mode-specific message).
await session.propose({
  proposalId: 'p1',
  option: 'deploy-canary',
  rationale: 'validate with 5% traffic first',
});

// … run the event loop on session.openStream().responses() …
```

## Non-initiator agent

Non-initiators never call `session.start()`. They open a stream on a session id they
already know and react to events as the initiator's envelopes arrive. Full runnable
version: [`examples/direct-agent-auth-observer.ts`](../../examples/direct-agent-auth-observer.ts).

```typescript
import { Auth, DecisionSession, MacpClient } from 'macp-sdk-typescript';

const sessionId = process.env.MACP_SESSION_ID!; // must match the initiator
const participantId = 'alice';
const bearerToken = process.env.MACP_ALICE_BEARER;

const auth = bearerToken
  ? Auth.bearer(bearerToken, { expectedSender: participantId })
  : Auth.devAgent(participantId);

const client = new MacpClient({
  address: process.env.MACP_RUNTIME_TARGET ?? process.env.MACP_RUNTIME_ADDRESS ?? '127.0.0.1:50051',
  secure: false,
  allowInsecure: true, // local dev only; production requires TLS
  auth,
});
await client.initialize();

const session = new DecisionSession(client, { sessionId, auth });
const stream = session.openStream();
await stream.sendSubscribe(sessionId); // replay what's already happened, then go live

for await (const envelope of stream.responses()) {
  if (envelope.messageType === 'Proposal') {
    await session.evaluate({ proposalId: 'p1', recommendation: 'APPROVE', confidence: 0.9, reason: 'looks good' });
  } else if (envelope.messageType === 'Commitment') {
    break; // session resolved
  }
}
```

## Why `expectedSender` matters

The runtime already derives the envelope `sender` from the authenticated identity — a
spoofed `sender` fails at the runtime with `UNAUTHENTICATED`. Setting `expectedSender`
on the auth lets the SDK catch the mistake locally and throw `MacpIdentityMismatchError`
**before** the envelope hits the wire — a clearer error, no wasted round trip, no
ambiguity about whose identity the session was bound to:

```typescript
const auth = Auth.bearer('tok-alice', { expectedSender: 'alice' });
const session = new DecisionSession(client, { auth });

await session.vote({ proposalId: 'p1', vote: 'approve', sender: 'mallory' });
// ↑ throws MacpIdentityMismatchError { expectedSender: 'alice', actualSender: 'mallory' }
```

See [Authentication § Per-Operation Auth (Multi-Agent)](authentication.md#per-operation-auth-multi-agent)
for per-operation auth overrides for multi-participant agents.

## Cancellation

Cancellation authority stays with the initiator (RFC-MACP-0001 §7.2) unless a policy's
commitment authority delegates it. Two patterns:

- **Option A (default)** — the initiator agent exposes a local HTTP cancel endpoint; the
  orchestrator POSTs to it, and the agent calls `session.cancel(reason)` over its own
  gRPC channel. `agent.fromBootstrap()` wires this automatically from the bootstrap
  file's `cancel_callback` field; hand-rolled agents can stand up the same endpoint
  directly with `agent.startCancelCallbackServer({ host, port, path, onCancel })` — see
  [`examples/cancel-callback.ts`](../../examples/cancel-callback.ts) for a complete,
  runnable demonstration of the server standalone.
- **Option B (opt-in)** — the scenario's policy designates the orchestrator (or another
  party) as a commitment authority, which can then call `cancelSession` directly without
  going through the initiator at all.

Either way, the SDK's `session.cancel()` call carries the calling agent's own Bearer
identity, so the runtime enforces authority consistently.
