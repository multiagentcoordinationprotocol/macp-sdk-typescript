# Policy Framework

The MACP governance policy framework (RFC-MACP-0012) allows you to register, resolve, and apply governance rules that control how coordination sessions reach commitment. Policies define voting algorithms, quorum requirements, objection handling, and commitment authority.

## Concepts

- **PolicyDescriptor** — A registered policy definition containing rules encoded as JSON bytes, targeting a specific mode (or `"*"` for mode-agnostic).
- **Default policy** (`policy.default`) — Every runtime ships with this pre-registered. When `policy_version` is empty, the default policy applies, preserving backward compatibility.
- **Evaluation semantics** — The runtime evaluates policy at commitment time. If the policy denies the commitment (e.g., quorum not met), the runtime rejects the `Commitment` envelope with `POLICY_DENIED`.

## Registering a Policy

Use the typed builder helpers to create a `PolicyDescriptor`, then register it with the runtime:

```typescript
import { MacpClient, Auth, buildDecisionPolicy } from 'macp-sdk-typescript';

const client = new MacpClient({
  address: 'localhost:50051',
  auth: Auth.devAgent('policy-admin'),
});

const policy = buildDecisionPolicy(
  'policy.fraud.majority-veto',
  'Fraud review: supermajority with veto power',
  {
    voting: {
      algorithm: 'supermajority',
      threshold: 0.67,
      quorum: { type: 'count', value: 3 },
    },
    objectionHandling: {
      blockSeverityVetoes: true,
      vetoThreshold: 1,
    },
    commitment: {
      authority: 'designated_role',
      designatedRoles: ['fraud-lead'],
      requireVoteQuorum: true,
    },
  },
);

await client.registerPolicy(policy);
```

> **Read-only registry (`MACP_POLICIES_DIR`).** When the runtime is started with
> a policies directory, its registry is read-only: `Initialize` advertises
> `capabilities.policyRegistry.registerPolicy: false`, and `registerPolicy` /
> `unregisterPolicy` fail with `FAILED_PRECONDITION` (inspect via
> `MacpTransportError.code`). Check the capability flag before attempting to
> register:
>
> ```typescript
> const init = await client.initialize();
> const caps = init.capabilities as { policyRegistry?: { registerPolicy?: boolean } };
> if (caps.policyRegistry?.registerPolicy) {
>   await client.registerPolicy(policy);
> }
> ```

## Using a Policy in a Session

Pass the `policyVersion` when starting a session:

```typescript
import { DecisionSession, MODE_DECISION } from 'macp-sdk-typescript';

const session = new DecisionSession(client, {
  sessionId: 'review-123',
  policyVersion: 'policy.fraud.majority-veto',
});

await session.start({
  intent: 'Review transaction for fraud',
  participants: ['analyst-1', 'analyst-2', 'fraud-lead'],
  sender: 'fraud-lead',
});
```

The runtime resolves `policy.fraud.majority-veto` at session start. If the policy is not registered, the runtime rejects with `UNKNOWN_POLICY_VERSION`.

## Builder Functions

Each standard mode has a typed builder:

| Builder | Target Mode |
|---------|-------------|
| `buildDecisionPolicy()` | `macp.mode.decision.v1` |
| `buildQuorumPolicy()` | `macp.mode.quorum.v1` |
| `buildProposalPolicy()` | `macp.mode.proposal.v1` |
| `buildTaskPolicy()` | `macp.mode.task.v1` |
| `buildHandoffPolicy()` | `macp.mode.handoff.v1` |

See [Policy API Reference](../api/policy.md) for the full input types and defaults.

## Querying Policies

```typescript
// List all registered policies
const allPolicies = await client.listPolicies();

// Filter by mode
const decisionPolicies = await client.listPolicies('macp.mode.decision.v1');

// Get a specific policy
const policy = await client.getPolicy('policy.fraud.majority-veto');

// Unregister
await client.unregisterPolicy('policy.fraud.majority-veto');
```

## Watching for Policy Changes

Use `PolicyWatcher` to react to policy registration/unregistration events:

```typescript
import { PolicyWatcher } from 'macp-sdk-typescript';

const watcher = new PolicyWatcher(client, { auth: Auth.devAgent('observer') });

for await (const change of watcher.changes()) {
  console.log('Policy registry changed:', change.descriptors.length, 'policies');
}
```

## Default Policy

When `policy_version` is empty or set to `policy.default`, the runtime applies the default policy:

- **Voting**: `algorithm: "none"` — no threshold enforced
- **Objections**: vetoes disabled
- **Evaluation**: not required before voting
- **Commitment**: initiator-only authority, no quorum required

This matches the runtime's behavior before the policy framework was introduced.
