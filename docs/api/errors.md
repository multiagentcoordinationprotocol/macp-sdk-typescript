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
reconnect) from an auth failure (`UNAUTHENTICATED` → don't reconnect).
`undefined` for locally-raised transport errors.

### `macpErrorCode` property

`macpErrorCode?: string` is the MACP error-codes registry code (e.g.
`'SESSION_NOT_FOUND'`, `'RATE_LIMITED'`) read from the status's
`macp-error-code` trailing metadata (runtime ≥ 0.9.0). Branch on it rather
than `code` when present — since 0.9.0 the gRPC status follows the registry's
gRPC column and several codes share one status. Set on unary RPC failures,
`MacpStream` terminal errors, and watcher stream errors; `undefined` for older
runtimes and for statuses raised without a registry code.
`macpErrorCodeFromMetadata(entries)` is the exported helper that reads it.

Since 0.9.0 the control-plane RPCs set it too — e.g. `SESSION_NOT_FOUND` /
`FORBIDDEN` from `getSession`/`cancelSession`/`suspendSession`/`resumeSession`,
`UNKNOWN_POLICY_VERSION` from `getPolicy`, `INVALID_REQUEST` from a bad
`listSessions` page token, `AGENT_NOT_FOUND` from `getManifest`,
`HISTORY_UNAVAILABLE` from `whatIfReplay`, `RECEIPT_UNAVAILABLE` from
`getDecisionReceipt`, and
`STREAM_LAGGED` (status `RESOURCE_EXHAUSTED`) when a stream or watch
subscriber falls behind — resubscribe with `afterSequence`. Treat an
unrecognised code by falling back to `code`.

## MacpTimeoutError

Subclass of `MacpTransportError`. Thrown by `MacpStream.read(timeoutMs)` when
the timeout elapses before an envelope arrives.

## MacpRetryError

Subclass of `MacpTransportError`. Thrown by `retrySend()` when the retry policy
is exhausted (see `src/retry.ts`).

## MacpAckError

Thrown when the runtime returns a negative acknowledgement (`ack.ok === false`)
— **and also** when `send()` or one of the five registry-mutation RPCs
(`registerExtMode`, `unregisterExtMode`, `promoteMode`, `registerPolicy`,
`unregisterPolicy`) fails with a gRPC `ALREADY_EXISTS`/`FAILED_PRECONDITION`
status the runtime couldn't express as a normal Ack; `err.ack` is then a
synthesized `{ ok: false, error: { code, message } }` (see
[error-handling.md](../guides/error-handling.md#macpackerror)).

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
    err.macpErrorCode;     // 'macp-error-code' metadata, if any (runtime ≥ 0.9.0)
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
  denials: PolicyDenial[]; // structured POLICY_DENIED reasons (runtime ≥ 0.9.0)
}

interface PolicyDenial {
  code: string;           // wire code, unchanged: 'veto', 'quorum_not_met', ...
                          // (DENY_* constants). Open set — treat a code not
                          // in KNOWN_DENY_CODES as 'unspecified'
  message: string;        // no participant ids since 0.9.0; '' if absent
  participants: string[]; // e.g. a veto's objectors
}
```

`parseErrorDetails(details)` decodes `{ reasons, denials }` from any details
source (`Buffer`, `Uint8Array`, or string — e.g. an inline stream error's
`details`) and never throws. See
[error-handling.md › Structured policy denials](../guides/error-handling.md#structured-policy-denials-runtime--090).

### `macpErrorCode` property

`macpErrorCode?: string` is the `macp-error-code` metadata value when the NACK
was synthesized from a gRPC status (runtime ≥ 0.9.0). On `send()` it equals
`failure.code`. The registry-mutation RPCs keep `failure.code:
'FAILED_PRECONDITION'` for compatibility, so check `macpErrorCode` for the
precise cause — `REGISTRY_READ_ONLY` when the policy registry is file-loaded
(`MACP_POLICIES_DIR`). Don't match the message text.

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
| `SESSION_ALREADY_EXISTS` | `send()`'s `SessionStart` collided with an existing session id (mapped from a gRPC `ALREADY_EXISTS`) |
| `DUPLICATE_MESSAGE` | message_id already accepted |
| `INVALID_ENVELOPE` | Validation failed or payload invalid |
| `UNSUPPORTED_PROTOCOL_VERSION` | No mutually supported version — `initialize()` raises `MacpTransportError` (`code: 'INVALID_ARGUMENT'`, `macpErrorCode` set) on runtime ≥ 0.9.0 |
| `MODE_NOT_SUPPORTED` | Mode or mode version not supported |
| `PAYLOAD_TOO_LARGE` | Exceeds size limit (default 1MB) |
| `RATE_LIMITED` | Too many requests |
| `INVALID_SESSION_ID` | Session ID format invalid, or longer than 128 bytes (runtime ≥ 0.9.0; the SDK checks this client-side) |
| `INTERNAL_ERROR` | Internal runtime error |
| `REGISTRY_READ_ONLY` | Register/UnregisterPolicy against a file-loaded registry (runtime ≥ 0.9.0, `FAILED_PRECONDITION`) |
| `INVALID_REQUEST` | Malformed control-plane request — bad `page_size`/`page_token`, missing descriptor (runtime ≥ 0.9.0, `INVALID_ARGUMENT`) |
| `STREAM_LAGGED` | Stream/watch subscriber fell behind; resubscribe with `afterSequence` (runtime ≥ 0.9.0, `RESOURCE_EXHAUSTED`) |
| `AGENT_NOT_FOUND` | `getManifest` for an agent this runtime doesn't host (runtime ≥ 0.9.0, `NOT_FOUND`) |
| `HISTORY_UNAVAILABLE` | `whatIfReplay` on a session whose accepted history the runtime no longer holds (RFC-MACP-0012 §8.1, `FAILED_PRECONDITION`) |
| `RECEIPT_UNAVAILABLE` | `getDecisionReceipt` for a session no receipt can be issued for: not resolved yet, resolved without a `CommitmentPayload`, or any other reason (RFC-MACP-0013 §13, `FAILED_PRECONDITION`) |
