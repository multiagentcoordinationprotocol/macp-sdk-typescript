# Policy API Reference

## PolicyDescriptor

The wire format for registered governance policies:

```typescript
interface PolicyDescriptor {
  policyId: string;            // e.g., "policy.fraud.majority-veto"
  mode: string;                // Target mode or "*" for mode-agnostic
  description: string;
  rules: string;               // JSON-encoded governance rules
  schemaVersion: number;       // Rule schema version: 1 for quorum/proposal/task/handoff;
                                // 1, 2, or 3 (default) for decision, see buildDecisionPolicy below
  registeredAtUnixMs?: number; // Set by runtime
}
```

## Builder Functions

### `buildDecisionPolicy(policyId, description, rules, options?)`

Creates a `PolicyDescriptor` targeting `macp.mode.decision.v1`. The only
builder with a runtime-selectable schema version
([RFC-MACP-0012 (Policy)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0012-policy.md));
the other four modes remain schema version 1.

```typescript
interface DecisionPolicyOptions {
  schemaVersion?: 1 | 2 | 3;   // default: 3 -- see "schemaVersion" below
}
```

> **`schemaVersion` selects the empty-tally semantics the runtime evaluates
> this policy under** (RFC-MACP-0012 §8 item 4 — validated once, at
> admission, never re-validated on replay):
>
> | Version | Empty decisive tally |
> | --- | --- |
> | `1` / `2` | Fail-**open**: a binding algorithm (e.g. `majority`) passes on zero ballots unless `commitment.requireVoteQuorum` is `true` (default `false`). |
> | `3` | Fail-**closed** for every algorithm except `'none'` (RFC-MACP-0012 §4.1's "vacuous participation floor", spec PR #99). |
>
> **The default is `3`** (issue #85, decided jointly with `macp-sdk-python`'s
> identical `schema_version: int = 3` default — see that repo's issue #65):
> RFC-MACP-0012's authoring guidance is that new non-`'none'` policies SHOULD
> declare `schemaVersion: 3`, and the old default of `2` was fail-open on an
> empty tally for exactly the callers who opted into a binding algorithm —
> silently satisfying a vote that received zero ballots, which contradicts
> what asking for a binding algorithm means. v1/v2 semantics are preserved
> permanently for replay (RFC-MACP-0012 §8 item 3) and remain a supported
> choice, not a transitional one — pass `{ schemaVersion: 1 }` or
> `{ schemaVersion: 2 }` explicitly to keep fail-open empty-tally semantics.
> A stored policy always evaluates under its own declared version forever, so
> this default change carries no migration risk for existing registered
> policies. An out-of-range value (anything other than `1`, `2`, or `3`)
> throws `MacpSessionError`. `schemaVersion` is descriptor metadata, not a
> rule — it never changes the serialized `rules` JSON for the same rule
> input.
>
> TypeScript has no keyword arguments, so this is a fourth positional
> `options` object rather than Python's `schema_version=` keyword — the two
> SDKs' call shapes diverge here by necessity, not oversight.

**Parameters:**

```typescript
interface DecisionPolicyRulesInput {
  voting?: {
    algorithm?: 'none' | 'majority' | 'supermajority' | 'unanimous' | 'weighted' | 'plurality';
    threshold?: number;                             // vote-share fraction, 0 < t <= 1, default: 0.5
    quorum?: { type: 'count' | 'percentage'; value: number };  // percentage = integer 0–100, NOT 0–1
    weights?: Record<string, number>;               // participant_id → weight
  };
  objectionHandling?: {
    criticalSeverityVetoes?: boolean;                // default: false
    vetoThreshold?: number;                          // default: 1
    criticalObjectionAction?: 'deny' | 'finalize_decline' | 'hold';  // default: 'deny' (schema v2)
  };
  evaluation?: {
    minimumConfidence?: number;                      // 0-1, default: 0
    requiredBeforeVoting?: boolean;                  // default: false
  };
  commitment?: {
    authority?: 'initiator_only' | 'any_participant' | 'designated_role';  // default: 'initiator_only'
    designatedRoles?: string[];                      // default: []; REQUIRED non-empty when authority is 'designated_role'
    requireVoteQuorum?: boolean;                     // default: false
    allowDeclineOverApproval?: boolean;              // default: false (schema v2, decision-only)
  };
}
```

Schema-version-2 fields: `criticalObjectionAction` selects what happens when a
critical objection would block commitment (`deny` rejects it, `finalize_decline`
resolves the session as a negative outcome, `hold` leaves it open).
`allowDeclineOverApproval: true` lets a reject-majority resolve the session with
a committed negative outcome (`outcome_positive = false`) instead of denying
commitment.

> **`buildDecisionPolicy` enforces the canonical `decision-rules.schema.json`
> constraints client-side**, so a schema-invalid descriptor fails fast instead
> of round-tripping to a runtime `INVALID_POLICY_DEFINITION`:
> - `voting.algorithm` must be one of the six canonical values.
> - `voting.threshold` must be `0 < threshold <= 1`.
> - `algorithm: 'majority'` requires `threshold >= 0.5` — **inclusive**,
>   deliberately, since `policy.std.majority` (RFC-MACP-0012 §2.2) pins
>   `threshold: 0.5` byte-identical on every runtime.
> - `algorithm: 'supermajority'` requires `threshold > 0.5` — **exclusive**;
>   the field's own default of `0.5` is a bare majority wearing the name, so
>   an explicit threshold (e.g. `0.67`) is required.
> - `algorithm: 'weighted'` requires a non-empty `weights` map.
> - **`weights`, if supplied at all, is validated unconditionally — at every
>   algorithm, not only `'weighted'`**: it must be non-empty, and every value
>   must be `> 0`. A weight-0 participant is expressed by **omission** from
>   the map, never by an explicit `0` — an explicit `0` throws. This is the
>   weighted electorate rule: an omitted participant's vote is non-decisive
>   (excluded from the ratio and the decisive tally) but still counts toward
>   `voting.quorum`'s participation floor.

### `buildQuorumPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.quorum.v1` (RFC-MACP-0012 §4.2).

> **`threshold.value` is the approval bar, not a participation quorum.** For
> `type: 'percentage'` it is an **integer 1–100** — the runtime computes the bar
> as `ceil(value / 100 × participants)`. `75` means "≥ 75% must approve"; a
> fractional value like `0.75` rounds to a ~1% bar and is therefore **rejected**
> (`MacpSessionError`). Use `n_of_m` for absolute counts.
>
> **`value` must be a positive integer for every `type`** (`exclusiveMinimum: 0`
> in the canonical `quorum-rules.schema.json`, unconditional — a zero approval
> bar would be trivially satisfied by any ballot set, so `buildQuorumPolicy`
> rejects it client-side). `'weighted'` is **reserved**: it was removed from the
> canonical schema without ever having defined semantics (no weights
> vocabulary, no electorate rule) and is refused by the runtime; passing it
> throws `MacpSessionError` naming the reservation.

```typescript
interface QuorumPolicyRulesInput {
  threshold?: {
    type: 'n_of_m' | 'percentage';                  // default: 'n_of_m'
    value: number;                                    // approval bar; default: 1
  };
  abstention?: {
    countsTowardQuorum?: boolean;                     // default: false
    interpretation?: 'neutral' | 'implicit_reject' | 'ignored';  // default: 'neutral'
  };
  commitment?: CommitmentRules;
}
```

### `buildProposalPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.proposal.v1` (RFC-MACP-0012 §4.3).

```typescript
interface ProposalPolicyRulesInput {
  acceptance?: { criterion?: 'all_parties' | 'counterparty' | 'initiator' };  // default: 'all_parties'
  counterProposal?: { maxRounds?: number };          // default: 0 (unlimited)
  rejection?: { terminalOnAnyReject?: boolean };     // default: false
  commitment?: CommitmentRules;
}
```

### `buildTaskPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.task.v1` (RFC-MACP-0012 §4.4).

```typescript
interface TaskPolicyRulesInput {
  assignment?: { allowReassignmentOnReject?: boolean };  // default: false
  completion?: { requireOutput?: boolean };              // default: false
  commitment?: CommitmentRules;
}
```

### `buildHandoffPolicy(policyId, description, rules)`

Creates a `PolicyDescriptor` targeting `macp.mode.handoff.v1` (RFC-MACP-0012 §4.5).

```typescript
interface HandoffPolicyRulesInput {
  acceptance?: { implicitAcceptTimeoutMs?: number };  // default: 0 (no implicit accept)
  commitment?: CommitmentRules;
}
```

### `CommitmentRules` (shared by all modes)

The exported input type is named `CommitmentRules`:

```typescript
interface CommitmentRules {
  authority?: 'initiator_only' | 'any_participant' | 'designated_role';  // default: 'initiator_only'
  designatedRoles?: string[];         // default: []; REQUIRED non-empty when authority is 'designated_role'
  requireVoteQuorum?: boolean;        // default: false; emitted only by buildDecisionPolicy, dropped elsewhere
  allowDeclineOverApproval?: boolean; // default: false; emitted only by buildDecisionPolicy (schema v2), dropped elsewhere
}
```

> **`authority: 'designated_role'` requires a non-empty `designatedRoles`.**
> An authority rule that names no one is unsatisfiable — no sender could ever
> meet it — so every one of the five `build*Policy` functions throws
> `MacpSessionError` if `designatedRoles` is omitted or `[]` while `authority`
> is `'designated_role'`. Enforced once, in the shared `serializeCommitment`
> helper all five builders funnel `commitment` through, mirroring the
> canonical rule schemas' root-level conditional (`minItems: 1` on
> `designated_roles` when `authority == "designated_role"`, spec issue #116).
> `designatedRoles` is **ignored, not validated**, under the other two
> authorities — supplying it there is still serialized into the descriptor
> but has no effect on who may commit.

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
  // change.observedAtUnixMs: number
}

// Callback-based
await watcher.watch((change) => { ... });

// One-shot
const change = await watcher.nextChange();
```

## Constants

- `DEFAULT_POLICY_VERSION` = `'policy.default'`
