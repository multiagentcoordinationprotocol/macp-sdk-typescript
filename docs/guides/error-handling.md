# Error Handling

## Error Class Hierarchy

```
Error
└── MacpSdkError                     Base class for all SDK errors
    ├── MacpTransportError           gRPC connectivity issues (optional .code = gRPC status name)
    │   ├── MacpTimeoutError         stream.read(timeoutMs) elapsed
    │   └── MacpRetryError           retrySend() exhausted its retry budget
    ├── MacpAckError                 Runtime rejected the message (nack)
    ├── MacpSessionError             Client-side payload/session validation failed (invalid session id, vote value, confidence, …)
    └── MacpIdentityMismatchError    Explicit sender conflicts with auth.expectedSender
```

## MacpAckError

Thrown when the runtime returns an Ack with `ok: false` — **and also** when
`send()` or one of the five registry-mutation RPCs (`registerExtMode`,
`unregisterExtMode`, `promoteMode`, `registerPolicy`, `unregisterPolicy`)
fails with a gRPC `ALREADY_EXISTS`/`FAILED_PRECONDITION` status the runtime
couldn't express as a normal Ack. `send()` maps a gRPC `ALREADY_EXISTS` to
`failure.code: 'SESSION_ALREADY_EXISTS'` and `FAILED_PRECONDITION` to
`'POLICY_DENIED'`; the five registry methods map `FAILED_PRECONDITION` to
`'FAILED_PRECONDITION'` (e.g. a read-only registry started with
`MACP_POLICIES_DIR`). In both cases `err.ack` is a synthesized
`{ ok: false, error: { code, message } }`, so existing `err.ack.error?.code`
handling works unchanged. Every other gRPC status on these calls (and every
status on every other RPC) is still `MacpTransportError`, not `MacpAckError`.

**Runtime ≥ 0.9.0.** The runtime's gRPC statuses now follow the MACP
error-codes registry (`POLICY_DENIED`/`FORBIDDEN` → `PERMISSION_DENIED`,
`SESSION_NOT_FOUND` → `NOT_FOUND`, `INVALID_ENVELOPE` → `INVALID_ARGUMENT`,
`SESSION_NOT_OPEN` → `FAILED_PRECONDITION`, `RATE_LIMITED` →
`RESOURCE_EXHAUSTED`, …) and every such status carries the exact registry code
in a `macp-error-code` metadata key. Because several codes share one status,
`send()` uses that key as `failure.code` whenever it is present, whatever the
status; the status-name mapping above is only the fallback for older runtimes.

Contains the full Ack object:

```typescript
import { MacpAckError } from 'macp-sdk-typescript';

try {
  await session.vote({ proposalId: 'p1', vote: 'approve' });
} catch (err) {
  if (err instanceof MacpAckError) {
    console.log(err.ack.error?.code);    // e.g., 'SESSION_NOT_OPEN'
    console.log(err.ack.error?.message); // human-readable description
    console.log(err.ack.sessionId);      // session context
    console.log(err.ack.sessionState);   // current session state
  }
}
```

For structured logging or persistence, `err.failure` exposes an `AckFailure`
record (`{ code, message, sessionId, messageId, reasons, denials }`) with the
same shape as the Python SDK's `MacpAckError.failure`. `reasons` and `denials`
are parsed from `ack.error.details` (or the `macp-error-details-bin` gRPC
trailing metadata) when the runtime attaches per-rule rejection reasons —
e.g. policy denials.

### Structured policy denials (runtime ≥ 0.9.0)

A `POLICY_DENIED` now carries `denials` beside the legacy `reasons` strings:

```json
{"reasons": ["critical objection veto"],
 "denials": [{"code": "veto", "message": "critical objection veto", "participants": ["agent://x"]}]}
```

`reasons` messages no longer embed participant ids (a veto used to end in
`", from: a, b"`) — read them from `denials[].participants` instead. Branch on
`denials[].code`: `veto`, `veto_hold`, `quorum_not_met`, `threshold_not_met`,
`confidence_below_minimum`, `evaluation_required`, `no_votes`,
`decline_over_approval`, `decline_not_backed`, `criterion_not_met`,
`output_required`, `reassignment_not_allowed`, `unsupported_schema_version`,
`invalid_rules`, `unspecified`. The set is open (custom evaluators may add
codes), so treat an unrecognised code as `unspecified`. Older runtimes send
`reasons` only, leaving `denials` empty.

```typescript
if (err instanceof MacpAckError && err.failure.code === 'POLICY_DENIED') {
  for (const d of err.failure.denials) {
    if (d.code === 'veto') console.log('vetoed by', d.participants);
  }
}
```

`parseErrorDetails(details)` decodes the same JSON from any source — e.g. an
inline stream error's `details` — and never throws.

### Suppressing Auto-Throw

By default, `client.send()` throws on nack. Disable this to handle rejections manually:

```typescript
const ack = await client.send(envelope, { raiseOnNack: false });
if (!ack.ok) {
  console.log('rejected:', ack.error?.code);
}
```

## MacpTransportError

Thrown on gRPC connectivity failures:

```typescript
import { MacpTransportError } from 'macp-sdk-typescript';

try {
  await client.initialize();
} catch (err) {
  if (err instanceof MacpTransportError) {
    console.log('gRPC error:', err.message, err.code);
  }
}
```

When the underlying failure carried a gRPC status, `err.code` holds the
status name (e.g. `RESOURCE_EXHAUSTED` for watch-stream consumer lag →
reconnect; `UNAUTHENTICATED` for an auth failure → do not reconnect). It is
absent for locally-raised transport errors.

On runtime ≥ 0.9.0 a runtime-raised MACP error also sets `err.macpErrorCode`
(from the `macp-error-code` metadata key, e.g. `SESSION_NOT_FOUND`). Prefer it
over `err.code` whenever it is present: several registry codes share one gRPC
status (`INVALID_ENVELOPE` and `INVALID_SESSION_ID` are both
`INVALID_ARGUMENT`), and pre-0.9.0 runtimes reported most of them as
`FAILED_PRECONDITION`. The control-plane RPCs (`getSession`, `cancelSession`,
`getPolicy`, `listSessions`, `getManifest`, watches, …) carry it too since
0.9.0 — e.g. `STREAM_LAGGED` on a lagging watch (resubscribe with
`afterSequence`), `INVALID_REQUEST` on a bad page token. Fall back to
`err.code` when the value is a code you don't recognise.

## MacpSdkError

The base class every other SDK error extends — catch it to handle any
client-side SDK fault generically. One direct raiser worth knowing: a
missing or empty `bearerToken` (e.g. `Auth.bearer('')`, or an
`AuthConfig` built without one) throws `MacpSdkError` directly, from
`validateAuth`/`metadataFromAuth` — reached from every authenticated RPC,
not just `AuthConfig` construction.

```typescript
import { MacpSdkError } from 'macp-sdk-typescript';

try {
  await client.send(envelope, { auth: { bearerToken: '' } });
} catch (err) {
  if (err instanceof MacpSdkError) {
    console.log('SDK configuration fault:', err.message);
  }
}
```

## Runtime Error Codes

The MACP runtime uses structured error codes in the Ack. The ones you will hit
most often:

| Code | Meaning |
|------|---------|
| `UNAUTHENTICATED` | Authentication failed |
| `FORBIDDEN` | Sender not authorized for this session or message type |
| `SESSION_NOT_FOUND` | Session does not exist |
| `SESSION_NOT_OPEN` | Session already resolved, expired, or suspended |
| `SESSION_ALREADY_EXISTS` | `send()`'s `SessionStart` collided with an existing session id (mapped from a gRPC `ALREADY_EXISTS`) |
| `INVALID_ENVELOPE` | Envelope validation failed or payload structure invalid |
| `POLICY_DENIED` | Governance policy denied the message (e.g. commitment without quorum) |
| `RATE_LIMITED` | Too many requests |
| `INTERNAL_ERROR` | Unrecoverable internal runtime error |
| `REGISTRY_READ_ONLY` | Policy register/unregister against a file-loaded registry — read `MacpAckError.macpErrorCode` (runtime ≥ 0.9.0) |
| `INVALID_REQUEST` | Malformed control-plane request (runtime ≥ 0.9.0) |
| `STREAM_LAGGED` | Stream/watch subscriber fell behind — resubscribe with `afterSequence` (runtime ≥ 0.9.0) |
| `AGENT_NOT_FOUND` | `getManifest` for an agent this runtime doesn't host (runtime ≥ 0.9.0) |

The canonical, complete code list lives in the spec's
[Common Error Codes](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/security.md#common-error-codes);
the runtime's
[common errors](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#common-errors)
and
[SDK guide › error handling](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/sdk-guide.md#error-handling)
cover when each is returned and how to react.

Every code is exported as a string constant from `src/constants.ts` (e.g.
`import { SESSION_NOT_OPEN } from 'macp-sdk-typescript'`), so comparisons
don't need string literals.

## Duplicate Handling

The runtime deduplicates messages by `message_id`. If a duplicate is detected, the Ack returns `ok: true` with `duplicate: true` — it is **not** an error:

```typescript
const ack = await client.send(envelope);
if (ack.duplicate) {
  console.log('message was already accepted (idempotent)');
}
```

## Patterns

### Built-in Retry: `retrySend()`

The SDK ships a retry helper (`src/retry.ts`) so you rarely need to hand-roll
backoff. `retrySend()` retries on any `MacpTransportError` and on NACKs whose
code is in `retryableCodes` (default: `RATE_LIMITED`, `INTERNAL_ERROR`), with
exponential backoff. Non-retryable NACKs are rethrown immediately; when the
budget is exhausted it throws `MacpRetryError` with the last error as `cause`:

```typescript
import { retrySend, DEFAULT_RETRY_POLICY } from 'macp-sdk-typescript';

const ack = await retrySend(client, envelope, {
  policy: { maxRetries: 5, backoffBase: 0.2, backoffMax: 5.0 }, // partial override of DEFAULT_RETRY_POLICY
});
```

### Retry on Transient Errors (manual)

If you need custom semantics, the equivalent hand-rolled loop looks like this:

```typescript
async function sendWithRetry(
  client: MacpClient,
  envelope: Envelope,
  maxRetries = 3,
): Promise<Ack> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.send(envelope);
    } catch (err) {
      if (err instanceof MacpTransportError && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (err instanceof MacpAckError && err.ack.error?.code === 'RATE_LIMITED') {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}
```

### Graceful Session Handling

```typescript
try {
  await session.commit({
    action: 'deployment.approved',
    authorityScope: 'ops',
    reason: 'approved',
  });
} catch (err) {
  if (err instanceof MacpAckError) {
    switch (err.ack.error?.code) {
      case 'SESSION_NOT_OPEN':
        console.log('session already resolved or expired');
        break;
      case 'FORBIDDEN':
        console.log('not authorized to commit');
        break;
      default:
        throw err;
    }
  }
}
```
