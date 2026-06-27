# Testing

## Running Tests

```bash
npm test               # Run all tests once
npm run test:watch     # Watch mode — re-runs on file changes
npm run test:coverage  # Run with v8 coverage report
```

## Test Structure

```
tests/
├── unit/
│   ├── projections/            # Per-mode projection state machines
│   ├── agent/                  # Dispatcher, participant, strategies, transports, runner
│   ├── auth.test.ts            # Auth factory, identity guard, metadata
│   ├── client.test.ts          # TLS guard, sender-identity enforcement, public exports
│   ├── envelope.test.ts        # Envelope builder functions
│   ├── errors.test.ts          # Error class hierarchy
│   ├── policy.test.ts          # Policy builders
│   ├── proto-registry.test.ts  # Protobuf encode/decode roundtrips
│   ├── retry.test.ts           # Retry policy + backoff
│   └── validation.test.ts      # Runtime-adjacent payload validation
└── integration/
    ├── README.md               # Runtime setup + bearer envs
    └── runtime.test.ts         # Full-surface tests against a live runtime
```

## Writing Projection Tests

Projections are pure state machines — they accept envelopes and update internal state. This makes them ideal for unit testing without any I/O:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { DecisionProjection } from '../../../src/projections/decision';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_DECISION } from '../../../src/constants';

// Create a real ProtoRegistry — tests the full protobuf round-trip
const registry = new ProtoRegistry();

// Helper to build envelopes with encoded payloads
function makeEnvelope(
  messageType: string,
  payload: Record<string, unknown>,
  sender = 'agent-a',
) {
  return buildEnvelope({
    mode: MODE_DECISION,
    messageType,
    sessionId: 'test-session',
    sender,
    payload: registry.encodeKnownPayload(MODE_DECISION, messageType, payload),
  });
}

describe('DecisionProjection', () => {
  let projection: DecisionProjection;

  beforeEach(() => {
    projection = new DecisionProjection();
  });

  it('tracks proposals and transitions phase', () => {
    projection.applyEnvelope(
      makeEnvelope('Proposal', { proposalId: 'p1', option: 'A' }),
      registry,
    );
    expect(projection.proposals.size).toBe(1);
    expect(projection.phase).toBe('Evaluation');
  });

  it('computes vote totals correctly', () => {
    projection.applyEnvelope(
      makeEnvelope('Proposal', { proposalId: 'p1', option: 'A' }),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'bob'),
      registry,
    );
    expect(projection.voteTotals()).toEqual({ p1: 2 });
  });
});
```

### Key Testing Pattern

Tests use a **real `ProtoRegistry`** instance that loads actual `.proto` files. This means:
- Payloads are encoded to protobuf wire format then decoded back
- Field name casing (camelCase ↔ snake_case) is exercised
- Missing or extra fields are caught
- Protobuf default values are handled correctly

### What to Test

For each projection:
- **State transitions**: Verify `phase` changes at the right time
- **Record population**: Check that maps/arrays are updated correctly
- **Query helpers**: Test convenience methods with edge cases
- **Commitment handling**: Verify terminal state
- **Mode isolation**: Envelopes for other modes are ignored

## Proto Registry Tests

Test encode/decode roundtrips for every message type across all modes:

```typescript
it('decision/Proposal roundtrip', () => {
  const payload = { proposalId: 'p1', option: 'deploy', rationale: 'ready' };
  const encoded = registry.encodeKnownPayload(MODE_DECISION, 'Proposal', payload);
  const decoded = registry.decodeKnownPayload(MODE_DECISION, 'Proposal', encoded);

  expect(decoded).toHaveProperty('proposalId', 'p1');
  expect(decoded).toHaveProperty('option', 'deploy');
});
```

## Integration Tests

Integration tests drive the full SDK against a live MACP runtime. See
[`tests/integration/README.md`](../../tests/integration/README.md) for the
full harness (runtime setup, env vars, and the optional direct-agent-auth
block gated on `MACP_TEST_BEARER_ALICE` / `MACP_TEST_BEARER_BOB`).

Common flow:

```bash
docker build -t macp-runtime ../macp-runtime/
docker run -d --name macp-runtime-test -p 50051:50051 \
  -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 \
  -e MACP_ALLOW_DEV_SENDER_HEADER=1 -e MACP_MEMORY_ONLY=1 macp-runtime

npm run test:integration
docker rm -f macp-runtime-test
```

### Writing Integration Tests

```typescript
import { describe, it, expect } from 'vitest';
import { Auth, MacpClient, DecisionSession } from '../../src';

const address = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';

describe('MacpClient integration', () => {
  it('initializes successfully', async () => {
    const client = new MacpClient({
      address,
      secure: false,
      allowInsecure: true, // local runtime uses MACP_ALLOW_INSECURE=1
      auth: Auth.devAgent('test-agent'),
    });
    const init = await client.initialize();
    expect(init.selectedProtocolVersion).toBe('1.0');
    client.close();
  });
});
```
