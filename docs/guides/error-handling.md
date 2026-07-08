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

Thrown when the runtime returns an Ack with `ok: false`. Contains the full Ack object:

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
record (`{ code, message, sessionId, messageId, reasons }`) with the same
shape as the Python SDK's `MacpAckError.failure`. The `reasons` array is
parsed from `ack.error.details` (or the `macp-error-details-bin` gRPC
trailing metadata) when the runtime attaches per-rule rejection reasons —
e.g. policy denials.

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
reconnect; `UNAUTHENTICATED` for an auth failure → do not reconnect;
`FAILED_PRECONDITION` for a passive-subscribe resume below a compacted
base). It is absent for locally-raised transport errors.

## Runtime Error Codes

The MACP runtime uses structured error codes in the Ack:

| Code | Meaning |
|------|---------|
| `UNAUTHENTICATED` | Authentication failed |
| `FORBIDDEN` | Sender not authorized for this session or message type |
| `SESSION_ALREADY_EXISTS` | `SessionStart` for a session id that already exists |
| `SESSION_NOT_FOUND` | Session does not exist |
| `SESSION_NOT_OPEN` | Session already resolved, expired, or suspended |
| `DUPLICATE_MESSAGE` | `message_id` already accepted within session |
| `INVALID_ENVELOPE` | Envelope validation failed or payload structure invalid |
| `UNSUPPORTED_PROTOCOL_VERSION` | No mutually supported protocol version |
| `MODE_NOT_SUPPORTED` | Mode or mode version not supported |
| `PAYLOAD_TOO_LARGE` | Payload exceeds allowed size (default 1MB) |
| `RATE_LIMITED` | Too many requests |
| `INVALID_SESSION_ID` | Session ID format invalid |
| `POLICY_DENIED` | Governance policy denied the message (e.g. commitment without quorum) |
| `UNKNOWN_POLICY_VERSION` | `policy_version` not registered with the runtime |
| `INVALID_POLICY_DEFINITION` | Policy registration rejected (malformed rules) |
| `INTERNAL_ERROR` | Unrecoverable internal runtime error |

Each code is exported as a string constant from `src/constants.ts` (e.g.
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
