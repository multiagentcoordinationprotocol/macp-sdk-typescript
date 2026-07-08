# Errors API Reference

## Error Hierarchy

```
Error
└── MacpSdkError                    Base class for all SDK errors
    ├── MacpTransportError          gRPC connectivity issues
    │   ├── MacpTimeoutError        RPC deadline exceeded
    │   └── MacpRetryError          Retries exhausted
    ├── MacpAckError                Runtime rejected the message
    ├── MacpSessionError             Session-state mismatch
    └── MacpIdentityMismatchError   Explicit sender conflicts with auth.expectedSender
```

## MacpSdkError

Base class for all SDK errors.

```typescript
import { MacpSdkError } from 'macp-sdk-typescript';

const err = new MacpSdkError('something went wrong');
err.name;    // 'MacpSdkError'
err.message; // 'something went wrong'
err instanceof Error;        // true
err instanceof MacpSdkError; // true
```

## MacpTransportError

Thrown when the gRPC transport fails (connection refused, timeout, etc.).

```typescript
import { MacpTransportError } from 'macp-sdk-typescript';

try {
  await client.initialize();
} catch (err) {
  if (err instanceof MacpTransportError) {
    // gRPC layer error
    console.log(err.message); // e.g., 'Connection refused'
    console.log(err.code);    // e.g., 'UNAVAILABLE'
  }
}
```

### `code` property

`code?: string` carries the gRPC status **name** (e.g. `'RESOURCE_EXHAUSTED'`,
`'FAILED_PRECONDITION'`, `'UNAUTHENTICATED'`) when the underlying failure had
one, mapped via the exported `grpcStatusName()` helper. It lets consumers
distinguish, for example, watch-stream consumer lag (`RESOURCE_EXHAUSTED` →
reconnect) from an auth failure (`UNAUTHENTICATED` → don't reconnect), or a
passive-subscribe resume below a compacted base (`FAILED_PRECONDITION`).
`undefined` for locally-raised transport errors.

## MacpTimeoutError

Subclass of `MacpTransportError`. Thrown by `MacpStream.read(timeoutMs)` when
the timeout elapses before an envelope arrives.

## MacpRetryError

Subclass of `MacpTransportError`. Thrown by `retrySend()` when the retry policy
is exhausted (see `src/retry.ts`).

## MacpAckError

Thrown when the runtime returns a negative acknowledgement (`ack.ok === false`).

```typescript
import { MacpAckError } from 'macp-sdk-typescript';

try {
  await session.vote({ proposalId: 'p1', vote: 'approve' });
} catch (err) {
  if (err instanceof MacpAckError) {
    err.name;              // 'MacpAckError'
    err.message;           // 'SESSION_NOT_OPEN: session already resolved'
    err.ack;               // full Ack object
    err.ack.ok;            // false
    err.ack.error?.code;   // 'SESSION_NOT_OPEN'
    err.ack.error?.message;// 'session already resolved'
    err.ack.sessionState;  // 'SESSION_STATE_RESOLVED'
    err.failure;           // structured AckFailure record (see below)
    err.grpcMetadata;      // optional gRPC trailing metadata
  }
}
```

### `failure` property

`failure: AckFailure` is a structured NACK record (parity with the Python SDK's
`MacpAckError.failure`):

```typescript
interface AckFailure {
  code: string;       // ack.error.code, or 'UNKNOWN'
  message: string;    // ack.error.message, or 'runtime returned nack'
  sessionId: string;
  messageId: string;
  reasons: string[];  // parsed from ack.error.details JSON, falling back to
                      // the 'macp-error-details-bin' gRPC trailing metadata
}
```

### Suppressing MacpAckError

Pass `raiseOnNack: false` to handle nacks manually:

```typescript
const ack = await client.send(envelope, { raiseOnNack: false });
if (!ack.ok) {
  // handle rejection without exception
}
```

## MacpSessionError

Thrown for client-side session/mode state violations — for example,
`registerExtMode()` raises it when the descriptor is missing `'Commitment'` in
`terminalMessageTypes` (runtime 0.5.0 guardrail).

## MacpIdentityMismatchError

Thrown when a caller-supplied `sender` disagrees with `auth.expectedSender`.
Raised client-side before the envelope hits the wire ([RFC-MACP-0004 (Security)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md) §4).

```typescript
import { Auth, MacpIdentityMismatchError } from 'macp-sdk-typescript';

const session = new DecisionSession(client, {
  auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
});

try {
  await session.propose({ proposalId: 'p1', option: 'x', sender: 'mallory' });
} catch (err) {
  if (err instanceof MacpIdentityMismatchError) {
    err.expectedSender; // 'alice'
    err.actualSender;   // 'mallory'
  }
}
```

The guard is silent when `expectedSender` is undefined (dev agents, legacy
bearer) — pre-0.2 code continues to work unchanged.

## Runtime Error Codes

| Code | Description |
|------|-------------|
| `UNAUTHENTICATED` | Authentication failed |
| `FORBIDDEN` | Not authorized for this session or message type |
| `SESSION_NOT_FOUND` | Session does not exist |
| `SESSION_NOT_OPEN` | Session already resolved or expired |
| `DUPLICATE_MESSAGE` | message_id already accepted |
| `INVALID_ENVELOPE` | Validation failed or payload invalid |
| `UNSUPPORTED_PROTOCOL_VERSION` | No mutually supported version |
| `MODE_NOT_SUPPORTED` | Mode or mode version not supported |
| `PAYLOAD_TOO_LARGE` | Exceeds size limit (default 1MB) |
| `RATE_LIMITED` | Too many requests |
| `INVALID_SESSION_ID` | Session ID format invalid |
| `INTERNAL_ERROR` | Internal runtime error |
