# Error Handling

## Error Class Hierarchy

```
Error
└── MacpSdkError           Base class for all SDK errors
    ├── MacpTransportError  gRPC connectivity issues
    └── MacpAckError        Runtime rejected the message (nack)
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
    console.log('gRPC error:', err.message);
  }
}
```

## Runtime Error Codes

The MACP runtime uses structured error codes in the Ack:

| Code | Meaning |
|------|---------|
| `UNAUTHENTICATED` | Authentication failed |
| `FORBIDDEN` | Sender not authorized for this session or message type |
| `SESSION_NOT_FOUND` | Session does not exist |
| `SESSION_NOT_OPEN` | Session already resolved or expired |
| `DUPLICATE_MESSAGE` | `message_id` already accepted within session |
| `INVALID_ENVELOPE` | Envelope validation failed or payload structure invalid |
| `UNSUPPORTED_PROTOCOL_VERSION` | No mutually supported protocol version |
| `MODE_NOT_SUPPORTED` | Mode or mode version not supported |
| `PAYLOAD_TOO_LARGE` | Payload exceeds allowed size (default 1MB) |
| `RATE_LIMITED` | Too many requests |
| `INVALID_SESSION_ID` | Session ID format invalid |
| `INTERNAL_ERROR` | Unrecoverable internal runtime error |

## Duplicate Handling

The runtime deduplicates messages by `message_id`. If a duplicate is detected, the Ack returns `ok: true` with `duplicate: true` — it is **not** an error:

```typescript
const ack = await client.send(envelope);
if (ack.duplicate) {
  console.log('message was already accepted (idempotent)');
}
```

## Patterns

### Retry on Transient Errors

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
