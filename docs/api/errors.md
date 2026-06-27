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
    console.log(err.message); // e.g., '14 UNAVAILABLE: Connection refused'
  }
}
```

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
  }
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

## MacpIdentityMismatchError

Thrown when a caller-supplied `sender` disagrees with `auth.expectedSender`.
Raised client-side before the envelope hits the wire (RFC-MACP-0004 §4).

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
