# Constants API Reference

## Protocol Version

```typescript
import { MACP_VERSION } from 'macp-sdk-typescript';

MACP_VERSION  // '1.0'
```

## Default Versions

```typescript
import {
  DEFAULT_MODE_VERSION,
  DEFAULT_CONFIGURATION_VERSION,
  DEFAULT_POLICY_VERSION,
} from 'macp-sdk-typescript';

DEFAULT_MODE_VERSION           // '1.0.0'
DEFAULT_CONFIGURATION_VERSION  // 'config.default'
DEFAULT_POLICY_VERSION         // 'policy.default'
```

## Mode Identifiers

```typescript
import {
  MODE_DECISION,
  MODE_PROPOSAL,
  MODE_TASK,
  MODE_HANDOFF,
  MODE_QUORUM,
  MODE_MULTI_ROUND,
} from 'macp-sdk-typescript';

MODE_DECISION    // 'macp.mode.decision.v1'
MODE_PROPOSAL    // 'macp.mode.proposal.v1'
MODE_TASK        // 'macp.mode.task.v1'
MODE_HANDOFF     // 'macp.mode.handoff.v1'
MODE_QUORUM      // 'macp.mode.quorum.v1'
MODE_MULTI_ROUND // 'ext.multi_round.v1'
```

The first five are **standards-track** modes. `MODE_MULTI_ROUND` is a built-in extension mode.

```typescript
import { STANDARD_MODES } from 'macp-sdk-typescript';

STANDARD_MODES  // [MODE_DECISION, MODE_PROPOSAL, MODE_TASK, MODE_HANDOFF, MODE_QUORUM]
```

`STANDARD_MODES` is a readonly tuple of the five first-class modes (parity with
the Python SDK's `STANDARD_MODES`).

## Error Code Constants

Well-known runtime error codes, exported as string constants whose names match
the on-the-wire values (no prefix). Compare against `ack.error?.code` or
`MacpAckError.failure.code`.

```typescript
import { SESSION_NOT_OPEN, POLICY_DENIED } from 'macp-sdk-typescript';
```

| Constant / value |
|------------------|
| `UNSUPPORTED_PROTOCOL_VERSION` |
| `INVALID_ENVELOPE` |
| `SESSION_ALREADY_EXISTS` |
| `SESSION_NOT_FOUND` |
| `SESSION_NOT_OPEN` |
| `MODE_NOT_SUPPORTED` |
| `FORBIDDEN` |
| `UNAUTHENTICATED` |
| `DUPLICATE_MESSAGE` |
| `PAYLOAD_TOO_LARGE` |
| `RATE_LIMITED` |
| `INTERNAL_ERROR` |
| `POLICY_DENIED` |
| `INVALID_SESSION_ID` |
| `UNKNOWN_POLICY_VERSION` |
| `INVALID_POLICY_DEFINITION` |
