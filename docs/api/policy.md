# Policy API Reference

## PolicyDescriptor

The wire format for registered governance policies:

```typescript
interface PolicyDescriptor {
  policy_id: string;           // e.g., "policy.fraud.majority-veto"
  mode: string;                // Target mode or "*" for mode-agnostic
  description: string;
  rules: Buffer | Uint8Array;  // JSON-encoded governance rules
  schema_version: number;      // Rule schema version (currently 1)
  registered_at?: string;      // ISO 8601, set by runtime
}
```

## Builder Functions

### `buildDecisionPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.decision.v1`.

**Parameters:**

```typescript
interface DecisionPolicyRulesInput {
  voting?: {
    algorithm?: 'none' | 'majority' | 'supermajority' | 'unanimous' | 'weighted' | 'plurality';
    threshold?: number;                             // vote-share fraction, 0-1, default: 0
    quorum?: { type: 'count' | 'percentage'; value: number };  // percentage = integer 0–100, NOT 0–1
    weights?: Record<string, number>;               // participant_id → weight
  };
  objectionHandling?: {
    blockSeverityVetoes?: boolean;                   // default: true
    vetoThreshold?: number;                          // default: 1
  };
  evaluation?: {
    minimumConfidence?: number;                      // 0-1, default: 0
    requiredBeforeVoting?: boolean;                  // default: false
  };
  commitment?: {
    authority?: 'initiator_only' | 'any_participant' | 'designated_role';  // default: 'initiator_only'
    designatedRoles?: string[];                      // default: []
    requireVoteQuorum?: boolean;                     // default: false
  };
}
```

### `buildQuorumPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.quorum.v1` (RFC-MACP-0012 §4.2).

> **`threshold.value` is the approval bar, not a participation quorum.** For
> `type: 'percentage'` it is an **integer 0–100** — the runtime computes the bar
> as `ceil(value / 100 × participants)`. `75` means "≥ 75% must approve"; a
> fractional value like `0.75` rounds to a ~1% bar and is therefore **rejected**
> (`MacpSessionError`). Use `n_of_m`/`weighted` for absolute counts.

```typescript
interface QuorumPolicyRulesInput {
  threshold?: {
    type: 'n_of_m' | 'percentage' | 'weighted';     // default: 'n_of_m'
    value: number;                                    // approval bar; default: 0
  };
  abstention?: {
    countsTowardQuorum?: boolean;                     // default: false
    interpretation?: 'neutral' | 'implicit_reject' | 'ignored';  // default: 'neutral'
  };
  commitment?: CommitmentRulesInput;
}
```

### `buildProposalPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.proposal.v1` (RFC-MACP-0012 §4.3).

```typescript
interface ProposalPolicyRulesInput {
  acceptance?: { criterion?: 'all_parties' | 'counterparty' | 'initiator' };  // default: 'all_parties'
  counterProposal?: { maxRounds?: number };          // default: 0 (unlimited)
  rejection?: { terminalOnAnyReject?: boolean };     // default: false
  commitment?: CommitmentRulesInput;
}
```

### `buildTaskPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.task.v1` (RFC-MACP-0012 §4.4).

```typescript
interface TaskPolicyRulesInput {
  assignment?: { allowReassignmentOnReject?: boolean };  // default: false
  completion?: { requireOutput?: boolean };              // default: false
  commitment?: CommitmentRulesInput;
}
```

### `buildHandoffPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.handoff.v1` (RFC-MACP-0012 §4.5).

```typescript
interface HandoffPolicyRulesInput {
  acceptance?: { implicitAcceptTimeoutMs?: number };  // default: 0 (no implicit accept)
  commitment?: CommitmentRulesInput;
}
```

### `CommitmentRulesInput` (shared by quorum, proposal, task, handoff)

```typescript
interface CommitmentRulesInput {
  authority?: 'initiator_only' | 'any_participant' | 'designated_role';
  designatedRoles?: string[];
}
```

## Client Methods

### `client.registerPolicy(descriptor, options?)`

Registers a policy with the runtime. Returns `{ ok: boolean; error?: string }`.

### `client.unregisterPolicy(policyId, options?)`

Removes a registered policy. Returns `{ ok: boolean; error?: string }`.

### `client.getPolicy(policyId, options?)`

Retrieves a policy by ID. Returns the `PolicyDescriptor`.

### `client.listPolicies(mode?, options?)`

Lists registered policies, optionally filtered by mode. Returns `PolicyDescriptor[]`.

## PolicyWatcher

```typescript
import { PolicyWatcher } from 'macp-sdk-typescript';

const watcher = new PolicyWatcher(client, { auth });

// Async generator
for await (const change of watcher.changes(abortSignal?)) {
  // change.descriptors: PolicyDescriptor[]
  // change.observedAtUnixMs: string
}

// Callback-based
await watcher.watch((change) => { ... });

// One-shot
const change = await watcher.nextChange();
```

## Constants

- `DEFAULT_POLICY_VERSION` = `'policy.default'`
