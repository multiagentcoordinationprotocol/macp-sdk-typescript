# Getting Started

## Prerequisites

- **Node.js 20+** (ES2022 target; `package.json` declares `engines.node >= 20`)
- A running MACP Rust runtime (default at `127.0.0.1:50051`)

## Install

```bash
npm install macp-sdk-typescript
```

## Connect to the Runtime

```typescript
import { Auth, MacpClient } from 'macp-sdk-typescript';

const client = new MacpClient({
  address: '127.0.0.1:50051',
  secure: false,                    // default is true (TLS); pass false + allowInsecure only for local dev
  allowInsecure: true,              // required whenever secure is false
  auth: Auth.devAgent('my-agent'),  // default auth for all operations
});

// Handshake — negotiates protocol version and capabilities
const init = await client.initialize();
console.log(init.selectedProtocolVersion); // '1.0'
console.log(init.runtimeInfo?.name);       // runtime name
console.log(init.supportedModes);          // available modes
```

## Run Your First Decision

```typescript
import { DecisionSession } from 'macp-sdk-typescript';

const session = new DecisionSession(client);

// 1. Start a session
await session.start({
  intent: 'choose a deployment strategy',
  participants: ['alice', 'bob'],
  ttlMs: 60_000, // 1 minute
});

// 2. Submit a proposal
await session.propose({
  proposalId: 'p1',
  option: 'canary-deploy',
  rationale: 'gradual rollout with monitoring',
});

// 3. Evaluate (as another agent)
await session.evaluate({
  proposalId: 'p1',
  recommendation: 'approve',
  confidence: 0.92,
  reason: 'risk assessment favorable',
  sender: 'alice',
  auth: Auth.devAgent('alice'),
});

// 4. Vote
await session.vote({
  proposalId: 'p1',
  vote: 'approve',
  reason: 'team consensus',
  sender: 'bob',
  auth: Auth.devAgent('bob'),
});

// 5. Check projection state
console.log(session.projection.voteTotals());    // { p1: 1 }
console.log(session.projection.majorityWinner()); // 'p1'

// 6. Commit the decision
await session.commit({
  action: 'deployment.approved',
  authorityScope: 'release-management',
  reason: 'unanimous approval for canary deploy',
});

// 7. Verify
const meta = await session.metadata();
console.log(meta.metadata.state); // 'SESSION_STATE_RESOLVED'

client.close();
```

## Client Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `address` | `string` | — | gRPC server address (`host:port`) |
| `secure` | `boolean` | `true` | Use TLS credentials (RFC-MACP-0006 §3) |
| `allowInsecure` | `boolean` | `false` | Required when `secure: false`; dev-only escape hatch |
| `auth` | `AuthConfig` | — | Default authentication for all operations |
| `rootCertificates` | `Buffer` | — | TLS root CA certificates |
| `defaultDeadlineMs` | `number` | — | Default RPC deadline in milliseconds |
| `clientName` | `string` | `'macp-sdk-typescript'` | Client name sent during Initialize |
| `clientVersion` | `string` | matches SDK package version | Client version sent during Initialize |
| `protoDir` | `string` | `<pkg>/proto` | Path to protobuf definitions |

## Session Options

All session constructors accept the same base options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sessionId` | `string` | auto-generated UUIDv4 | Session identifier |
| `modeVersion` | `string` | `'1.0.0'` | Semantic version of the mode |
| `configurationVersion` | `string` | `'config.default'` | Configuration profile version |
| `policyVersion` | `string` | `'policy.default'` | Policy profile version |
| `auth` | `AuthConfig` | — | Override default client auth |

## Next Steps

- Learn about the [Architecture](architecture.md) to understand how sessions and projections work
- Explore each [Coordination Mode](../modes/decision.md) in detail
- Set up [Authentication](authentication.md) for production
