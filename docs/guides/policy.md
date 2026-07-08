# Policy Framework

The MACP governance policy framework ([RFC-MACP-0012 (Policy)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0012-policy.md)) allows you to register, resolve, and apply governance rules that control how coordination sessions reach commitment. Policies define voting algorithms, quorum requirements, objection handling, and commitment authority.

This page covers the TypeScript builder API and policy lifecycle from the client side. The rule schemas themselves and their evaluation semantics are canonical elsewhere: see the spec's [Rule Schemas by Mode](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/policy.md#rule-schemas-by-mode) and [Policy Evaluation](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/policy.md#policy-evaluation), and the runtime's [rule examples by mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#rule-examples-by-mode) and [how evaluation works](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#how-evaluation-works).

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
      criticalSeverityVetoes: true,
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
import { DecisionSession, newSessionId } from 'macp-sdk-typescript';

const session = new DecisionSession(client, {
  sessionId: newSessionId(), // session ids must be UUID v4/v7 or base64url (22+ chars)
  policyVersion: 'policy.fraud.majority-veto',
});

await session.start({
  intent: 'Review transaction for fraud',
  participants: ['analyst-1', 'analyst-2', 'fraud-lead'],
  ttlMs: 60_000,
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

See [Policy API Reference](../api/policy.md) for the full input types and defaults. The builders emit rules JSON matching the spec's [Rule Schemas by Mode](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/policy.md#rule-schemas-by-mode); how the runtime interprets each rule (including [commitment authority](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#commitment-authority)) is documented in the runtime policy guide.

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

When `policy_version` is empty or set to `policy.default`, the runtime applies the default policy — no voting threshold, vetoes disabled, initiator-only commitment authority. This matches the runtime's behavior before the policy framework was introduced. The full default rule set is specified in the spec's [Default Policy](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/policy.md#default-policy) section.
