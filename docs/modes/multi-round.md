# Multi-Round Mode

**Mode identifier**: `ext.multi_round.v1` (`mode_version` `1.0.0`)
**Participant model**: declared participants
**Convergence**: `all_equal`

## Purpose

Iterative convergence. Each declared participant contributes a value, and may
change it, until every participant's latest value is the same. Convergence
doesn't resolve the session: the initiator then sends the Commitment.

`ext.multi_round.v1` is an extension mode that ships with the runtime, not a
standards-track mode. Its semantics are in the spec's `multi_round.proto`
(spec #241); the
[runtime modes guide](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md)
documents validation as implemented. This page covers the TypeScript API, which
matches `macp_sdk.multi_round` in macp-sdk-python.

The helper is client sugar only. The runtime decides every outcome, and the
session's governance policy is never evaluated for this mode.

## Session Lifecycle

```
SessionStart → Contribute (repeated, any order) → converged → Commitment (initiator)
```

## API

### MultiRoundSession

```typescript
import { Auth, MultiRoundSession } from 'macp-sdk-typescript';

const session = new MultiRoundSession(client, { auth: Auth.devAgent('coordinator') });
await session.start({ intent: 'pick a rollout option', participants: ['alice', 'bob'], ttlMs: 60_000 });

await session.contribute({ value: 'option_a', sender: 'alice', auth: Auth.devAgent('alice') }); // round 1
await session.contribute({ value: 'option_b', sender: 'bob', auth: Auth.devAgent('bob') }); // round 2
await session.contribute({ value: 'option_a', sender: 'bob', auth: Auth.devAgent('bob') }); // round 3, converged

session.projection.converged; // true
session.projection.convergedValue; // 'option_a'

await session.commit({ authorityScope: 'rollout', reason: 'all participants agree' });
```

#### Methods

| Method | Message Type | Description |
|--------|-------------|-------------|
| `start(input)` | `SessionStart` | `mode_version` defaults to, and must be, `1.0.0` |
| `contribute({ value, sender?, auth? })` | `Contribute` | Contribute or change a value |
| `commit(input)` | `Commitment` | Resolve the session (initiator only) |

Like every mode session, `MultiRoundSession` also exposes `metadata()`,
`cancel(reason)`, `suspend(reason)`, `resume(reason)` and `openStream()`. See
[Decision Mode → Lifecycle helpers](decision.md#lifecycle-helpers).

### Contribute

`Contribute` carries a `ContributePayload { value }`, encoded as canonical
protobuf (`buildContributePayload(value)` builds the object). The runtime's
rules:

- Only a declared participant may contribute. Anyone else gets `FORBIDDEN`,
  including an initiator who isn't in `participants`.
- A sender's first value, or a changed one, advances the round by one.
  Re-sending an unchanged value is accepted but changes nothing.
- An empty value encodes to zero bytes, which the runtime rejects with
  `INVALID_ENVELOPE`.
- After convergence, every further `Contribute` is `INVALID_ENVELOPE`.

### Commit

`commit()` takes `authorityScope` and `reason`, plus optional `action`
(default `MULTI_ROUND_CONVERGED_ACTION`, `'multi_round.converged'`),
`commitmentId`, `outcomePositive`, `supersedes`, `sender` and `auth`.
`modeVersion`, `configurationVersion` and `policyVersion` come from the
session, because the runtime requires them to match.

The runtime refuses a commit from anyone but the initiator (`FORBIDDEN`) and a
commit before convergence (`INVALID_ENVELOPE`). There is no auto-resolve.

`multi_round.converged` matches no outcome suffix, so `outcomePositive` is up
to you; it defaults to `true`. An action ending in a negative suffix
(`rejected`, `failed`, `declined`) must have `outcomePositive: false`, and one
ending in a positive suffix (`selected`, `accepted`, `completed`, `approved`)
must have `true`. The match is case-sensitive, like the runtime.

### Local checks

The session throws `MacpSessionError`, without sending, when the runtime is
certain to refuse:

| Method | Refused when |
|--------|-------------|
| `start` | `modeVersion` isn't `1.0.0` (or `participants` is empty) |
| `contribute` | `value` is empty or not a string; the projection has converged; participants are known and the sender isn't one |
| `commit` | the initiator is known and the sender isn't it; `action`, `authorityScope`, `reason` or a given `commitmentId` is blank; `outcomePositive` contradicts a suffix; `supersedes` has a blank `sessionId` or a non-canonical hash |

A commit before convergence is sent anyway: the projection's convergence is
advisory, and the runtime answers with `INVALID_ENVELOPE`. A session that never
saw the SessionStart (constructed with an existing `sessionId`) knows neither
participants nor initiator, so it skips those checks. So does a send with an
empty sender (bearer auth with no sender hint): the runtime fills the sender in
from the authenticated identity.

## Projection

`MultiRoundProjection` follows the same rules client-side:

| Field | Meaning |
|-------|---------|
| `phase` | `'Pending'` → `'Contributing'` (SessionStart) → `'Converged'` → `'Committed'` |
| `participants` / `initiator` | From the accepted SessionStart, or seeded through the constructor |
| `contributions` | `Map` of each participant's latest value |
| `round` | Count of first or changed contributions |
| `converged` / `convergedValue` | Sticky once every participant's latest value is equal |
| `pendingParticipants()` | Declared participants who haven't contributed |

```typescript
import { MultiRoundProjection } from 'macp-sdk-typescript';

// A replay that never sees the SessionStart can seed what it would carry.
const projection = new MultiRoundProjection({ participants: ['alice', 'bob'], initiator: 'coordinator' });
```

Convergence is evaluated only once participants are known. These change no
state (they stay in `transcript`): a `Contribute` from a non-participant once
participants are known, one the runtime would refuse (a zero-byte payload, or
bytes it can't read as a value), and any `Contribute` after convergence. A
non-empty payload that decodes to `""` (such as `0a00`) is a real
contribution, as it is in the runtime.

The projection reads a `Contribute` value exactly as the runtime's
`parse_contribute_value` does. That's serde's legacy JSON `{"value": <string>}`
(or `["<string>"]`), unless the bytes are also canonical protobuf, and
otherwise prost's protobuf decode. Bytes that only a lenient decoder would
read as a value count as nothing, so a hostile payload projects the value the
runtime stored. `ProtoRegistry.decodeKnownPayload`, which fills agent
handlers' `IncomingMessage.payload`, returns the same value for any bytes the
runtime accepts. It reads leniently only the bytes the runtime refuses.

A SessionStart sent with an empty sender (bearer auth with no sender hint)
doesn't overwrite a known initiator, because the runtime fills the sender in
only on its own copy. Likewise, a `Contribute` sent with an empty sender is
accepted by the runtime, but the session's own projection sees sender `""` and
ignores it. For local tracking, pass `sender` or give the credential a sender
hint.

**Limitation.** The projection applies the JSON/protobuf tie-break the
runtime uses from `semantics_rev` 3. A session the
runtime recorded before that could have read some protobuf values (byte
lengths such as 13, 32 and 123) as JSON, and the projection can't see
`semantics_rev`.
