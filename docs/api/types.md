# Types API Reference

All TypeScript interfaces exported by the SDK.

## Core Types

### `Envelope`

The canonical MACP message container.

```typescript
interface Envelope {
  macpVersion: string;      // protocol version ('1.0')
  mode: string;             // mode identifier (empty for Signals)
  messageType: string;      // message type name
  messageId: string;        // unique per session
  sessionId: string;        // session identifier (empty for Signals)
  sender: string;           // authenticated sender identity
  timestampUnixMs: string;  // informational timestamp
  payload: Buffer;          // encoded payload bytes
}
```

### `Ack`

Runtime acknowledgement for sent messages.

```typescript
interface Ack {
  ok?: boolean;              // true if accepted
  duplicate?: boolean;       // true if message was deduplicated
  messageId?: string;        // echoed message_id
  sessionId?: string;        // session context
  acceptedAtUnixMs?: string; // acceptance timestamp
  sessionState?: string;     // current session state
  error?: MacpErrorShape;    // present if not ok
}
```

### `MacpErrorShape`

Structured error from the runtime.

```typescript
interface MacpErrorShape {
  code: string;        // machine-readable error code
  message: string;     // human-readable description
  sessionId?: string;  // optional session context
  messageId?: string;  // optional message context
  details?: Buffer;    // optional mode-specific details
}
```

### `SessionMetadata`

Session state from `GetSession`.

```typescript
interface SessionMetadata {
  sessionId?: string;
  mode?: string;
  state?: SessionState;        // see SessionState below
  startedAtUnixMs?: string;
  expiresAtUnixMs?: string;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
}
```

### `SessionState`

String-union of the session lifecycle states (proto 0.1.3). `SUSPENDED` is a
non-terminal pause (TTL is banked and restored on resume); `CANCELLED` is the
terminal state for an explicit `cancelSession` — distinct from `EXPIRED`
(TTL / deterministic runtime policy).

```typescript
type SessionState =
  | 'SESSION_STATE_UNSPECIFIED'
  | 'SESSION_STATE_OPEN'
  | 'SESSION_STATE_RESOLVED'
  | 'SESSION_STATE_EXPIRED'
  | 'SESSION_STATE_SUSPENDED'
  | 'SESSION_STATE_CANCELLED';
```

## Discovery Types

### `ModeDescriptor`

```typescript
interface ModeDescriptor {
  mode: string;
  modeVersion: string;
  title?: string;
  description?: string;
  determinismClass?: string;
  participantModel?: string;
  messageTypes?: string[];
  terminalMessageTypes?: string[];
  schemaUris?: Record<string, string>;
}
```

### `AgentManifest`

```typescript
interface AgentManifest {
  agentId?: string;
  title?: string;
  description?: string;
  supportedModes?: string[];
  inputContentTypes?: string[];
  outputContentTypes?: string[];
  metadata?: Record<string, string>;
  transportEndpoints?: TransportEndpoint[];
}
```

### `Root`

```typescript
interface Root {
  uri: string;
  name?: string;
}
```

## Core Payload Types

### `SessionStartPayload`

```typescript
interface SessionStartPayload {
  intent: string;
  participants: string[];
  modeVersion: string;
  configurationVersion: string;
  policyVersion?: string;
  ttlMs: number;
  context?: Buffer;
  roots?: Root[];
}
```

### `CommitmentPayload`

```typescript
interface CommitmentPayload {
  commitmentId: string;
  action: string;
  authorityScope: string;
  reason: string;
  modeVersion: string;
  policyVersion?: string;
  configurationVersion: string;
  outcomePositive?: boolean;
  supersedes?: CommitmentRef;  // cross-session supersession (proto 0.1.3)
}
```

### `CommitmentRef`

Reference to a prior accepted commitment, used for cross-session supersession
(RFC-MACP-0001 §7.3). Pass it via `buildCommitmentPayload({ ..., supersedes })`.

```typescript
interface CommitmentRef {
  sessionId: string;
  commitmentHash: string;   // content hash of the superseded CommitmentPayload
}
```

### `SignalPayload`

```typescript
interface SignalPayload {
  signalType: string;
  data?: Buffer;
  confidence?: number;
  correlationSessionId?: string;
}
```

## Mode Payload Types

### Decision Mode

- `DecisionProposalPayload` — `{ proposalId, option, rationale?, supportingData? }`
- `DecisionEvaluationPayload` — `{ proposalId, recommendation, confidence, reason? }`
- `DecisionObjectionPayload` — `{ proposalId, reason, severity? }`
- `DecisionVotePayload` — `{ proposalId, vote, reason? }`

### Proposal Mode

- `ProposalModeProposalPayload` — `{ proposalId, title, summary?, details?, tags? }`
- `CounterProposalPayload` — `{ proposalId, supersedesProposalId, title, summary?, details? }`
- `AcceptPayload` — `{ proposalId, reason? }`
- `RejectPayload` — `{ proposalId, terminal?, reason? }`
- `WithdrawPayload` — `{ proposalId, reason? }`

### Task Mode

- `TaskRequestPayload` — `{ taskId, title, instructions, requestedAssignee?, input?, deadlineUnixMs? }`
- `TaskAcceptPayload` — `{ taskId, assignee, reason? }`
- `TaskRejectPayload` — `{ taskId, assignee, reason? }`
- `TaskUpdatePayload` — `{ taskId, status, progress, message?, partialOutput? }`
- `TaskCompletePayload` — `{ taskId, assignee, output?, summary? }`
- `TaskFailPayload` — `{ taskId, assignee, errorCode?, reason?, retryable? }`

### Handoff Mode

- `HandoffOfferPayload` — `{ handoffId, targetParticipant, scope, reason? }`
- `HandoffContextPayload` — `{ handoffId, contentType, context? }`
- `HandoffAcceptPayload` — `{ handoffId, acceptedBy, reason? }`
- `HandoffDeclinePayload` — `{ handoffId, declinedBy, reason? }`

### Quorum Mode

- `ApprovalRequestPayload` — `{ requestId, action, summary, details?, requiredApprovals }`
- `ApprovePayload` — `{ requestId, reason? }`
- `QuorumRejectPayload` — `{ requestId, reason? }`
- `AbstainPayload` — `{ requestId, reason? }`

## Watcher Types

### `RegistryChanged`

```typescript
interface RegistryChanged {
  registry: string;
  observedAtUnixMs: string;
}
```

### `RootsChanged`

```typescript
interface RootsChanged {
  observedAtUnixMs: string;
}
```
