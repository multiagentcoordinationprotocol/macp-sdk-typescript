# Testing

## Running Tests

```bash
npm test               # Run unit + conformance suites once
npm run test:watch     # Watch mode — re-runs on file changes
npm run test:coverage  # Run with v8 coverage report + threshold gate
```

Integration tests are **not** part of `npm test` — they run separately against
a live runtime (see [Integration Tests](#integration-tests) below).

## Test Structure

```
tests/
├── unit/
│   ├── projections/            # Per-mode projection state machines (5 files)
│   ├── sessions/               # Per-mode session helpers (5 files) + session-id-validation.test.ts
│   ├── agent/                  # Dispatcher, participant, strategies, transports, runner, cancel-callback
│   ├── helpers/
│   │   └── grpc-stub.ts        # stubUnary() — shared gRPC stubbing helper (not a test file)
│   ├── auth.test.ts            # Auth factory, identity guard, metadata
│   ├── base-session.test.ts    # BaseSession extension point + BaseProjection outcome table
│   ├── client.test.ts          # TLS guard, sender-identity enforcement, public exports
│   ├── commitment-hash-frozen-fields.test.ts  # Runs real tsc over mutated CommitmentPayload copies
│   ├── client-stream.test.ts   # MacpStream data path (openStream, responses, read, close)
│   ├── client-unary.test.ts    # Full unary RPC surface + metadata/deadline dispatch matrix
│   ├── envelope.test.ts        # Envelope builder functions
│   ├── errors.test.ts          # Error class hierarchy
│   ├── fixture-drift-gate.test.ts  # Drives the real `make verify-fixtures`/`sync-fixtures` recipes
│   ├── logging.test.ts         # Structured logger + configureLogging()
│   ├── policy.test.ts          # Policy builders
│   ├── proto-registry.test.ts  # Protobuf encode/decode roundtrips
│   ├── retry.test.ts           # Retry policy + backoff
│   ├── validation.test.ts      # Runtime-adjacent payload validation
│   └── watchers.test.ts        # Registry/roots/signal/policy/session-lifecycle watchers
├── conformance/
│   ├── conformance.test.ts     # Fixture-driven projection replay harness
│   ├── schema.json             # Fixture schema (shared with the spec repo)
│   └── *_happy_path.json / *_reject_paths.json / …   # Per-mode fixtures + ext.multi_round.v1
├── vectors/
│   ├── cmt-hash.test.ts        # Spec-vector runner replaying RFC-MACP-0013's canonical vectors
│   └── cmt-hash/               # Vendored vectors + SOURCE.md (provenance, gated by verify-fixtures)
├── commitment-hash.test.ts     # RFC-MACP-0013 commitment hash: determinism, JCS, D3
└── integration/
    ├── README.md               # Runtime setup + bearer envs
    └── runtime.test.ts         # Full-surface tests against a live runtime
```

## Coverage Gates

`vitest.config.ts` enforces v8 coverage thresholds over `src/**` (pure
type/barrel files are excluded so they don't skew the function percentage):

| Metric | Floor | Measured (2026-08 suite) |
|--------|-------|--------------------------|
| Lines | 92 | 94.60 |
| Branches | 81 | 83.87 |
| Functions | 90 | 92.28 |
| Statements | 91 | 93.13 |

The convention: **floors are the current measured value minus 2 percentage
points**, and they are raised when new tests land. CI gates on these via
`npm run test:coverage` — if coverage drops below a floor, the run fails.
The `json`/`json-summary` reporters feed the sticky PR coverage comment in CI.

### The v3 → v4 measurement break

These numbers are lower than the floors this table carried before 2026-08
(94 / 88 / 90 / 94) even though no test was removed. Vitest 4 rewrote the v8
coverage provider to remap through a rolldown AST instead of `v8-to-istanbul`,
and dropped the `ignoreEmptyLines` option along with it. The new mapping counts
branches the old one missed — optional chaining, default parameters, logical
short-circuits — so the same suite measures stricter.

The practical consequence: **v3-era and v4-era percentages are not comparable.**
A number from a pre-2026-08 run, a PR coverage comment, or an old PROGRESS.md
entry is on a different ruler. Do not read the drop as a regression, and do not
try to recover the old figures by widening `exclude`.

## Client Transport Tests

`tests/unit/client-unary.test.ts` and `tests/unit/client-stream.test.ts`
exercise `MacpClient` and `MacpStream` without any network, sharing the
`stubUnary` helper from `tests/unit/helpers/grpc-stub.ts`.

### stubUnary

`stubUnary(client, rpcName, response, options?)` replaces one unary RPC on
the **private gRPC client behind a real `MacpClient`** and records every call.
`MacpClient.unary()` dispatches on four argument shapes depending on whether
auth metadata and a deadline are present — `(req, cb)`, `(req, metadata, cb)`,
`(req, {deadline}, cb)`, `(req, metadata, {deadline}, cb)`. The callback is
always the **last function-typed argument**, so one helper covers all four;
everything between the request and the callback is recorded in
`calls[i].extras` for assertions. Pass `{ fail: true }` with an
`Error`-like `{ code, details, message }` response to make the RPC fail.

```typescript
import { stubUnary } from '../helpers/grpc-stub';

const calls = stubUnary(client, 'GetSession', {
  metadata: { sessionId: 's-1', state: 'SESSION_STATE_OPEN' },
});

await client.getSession('s-1');

expect(calls).toHaveLength(1);
expect(calls[0].request).toEqual({ sessionId: 's-1' });
// calls[0].extras holds the metadata / {deadline} positional args, if any
```

`client-unary.test.ts` covers the full unary surface (initialize, send,
discovery/registry RPCs, policy RPCs, sendSignal/sendProgress, watch-stream
factories) plus the metadata/deadline dispatch matrix itself.

### Stream data path

`client-stream.test.ts` pins down `MacpStream` semantics:

- **Envelope unwrap** — both the oneof format (`chunk.response.envelope`) and
  the legacy format (`chunk.envelope`) are delivered.
- **Inline errors** — an application-level `chunk.response.error` invokes
  `onInlineError` callbacks while the stream stays open.
- **`read()` timeouts** — `read(timeoutMs)` throws `MacpTimeoutError` when no
  envelope arrives in time.
- **`STREAM_END` semantics** — end-of-stream is sticky: `read()` returns
  `null` and returns `null` again on the next call (the sentinel is
  re-pushed), and `responses()` observes the same end.

## Session and Base-Session Tests

`tests/unit/sessions/` has one file per mode (decision, proposal, task,
handoff, quorum). Each covers, with `client.send` mocked:

- **Projection roundtrip** — each helper method applies its envelope to the
  projection on `ack.ok === true` and does not when `send` throws `MacpAckError`.
- **cancel/suspend/resume delegation** — `session.cancel()/suspend()/resume()`
  delegate to `client.cancelSession/suspendSession/resumeSession` with the
  session's id.
- **Resolved NACK not applied** — when `send` *resolves* with
  `{ ok: false, ... }` (e.g. `raiseOnNack: false` flows), the ack is returned
  to the caller but nothing is applied to the projection.

`tests/unit/base-session.test.ts` covers the `BaseSession` extension point
(the recommended base class for custom/extension modes): input validation,
`commit()` feeding the projection, and a branch table for
`BaseProjection.isPositiveOutcome` (undefined without a commitment; defaults
applied per commitment shape).

## Participant Tests

`tests/unit/agent/participant.test.ts` exercises the agent framework's run
loop end to end (with a fake transport):

- **Action delegation** — `ctx.actions.evaluate/vote/propose/commit/send`
  delegate to the mode session with the participant's id as `sender`.
- **Run-loop terminal path** — reaching a terminal phase fires the
  `onTerminal` handler and exits `run()`.
- **Cancel-callback wiring** — a `cancelCallback` config starts the HTTP
  server on `run()` and tears it down on `stop()`.
- **Kickoff defaults** — an initiator `kickoff` Proposal defaults
  `proposalId` to `<sessionId>-kickoff` and `option` to `"decide"`, and
  accepts the snake_case `proposal_id` spelling.

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

## Conformance Tests

`tests/conformance/conformance.test.ts` replays the shared spec fixtures
(`*_happy_path.json`, `*_reject_paths.json`, …) through the projections:
each fixture's **accepted** message prefix is encoded via a real
`ProtoRegistry`, applied to the mode's projection, and the resulting phase,
resolution, and mode state are asserted against the fixture's expectations.

The harness's `acceptedMessages` filter in
`tests/conformance/conformance.test.ts` — `fixture.messages.filter((m) =>
m.expect === 'accept')` — is not an incidental implementation detail — it is
this harness upholding
`applyEnvelope`'s accepted-only input contract (see [Projections API ›
Input contract](../api/projections.md#input-contract)). `applyEnvelope`
cannot verify that contract itself (`Envelope` carries no acceptance marker),
so every caller, including this harness, is responsible for filtering before
replay. `tests/unit/projections/accepted-only-contract.test.ts` demonstrates
what happens when a caller skips that filtering step.

The fixture-sync contract — what a conformant SDK must replay and how fixtures
and protos are kept in lockstep with the spec — is canonical in the spec's
[SDK Parity › Sync Mechanisms](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/sdk-parity.md#sync-mechanisms)
and
[SDK Parity › Conformance Test Suite](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/sdk-parity.md#conformance-test-suite).

Harness behaviours worth knowing:

- **`ext.multi_round.v1` fixtures replay too.** The extension mode has no
  mode-specific projection, so its fixtures run through a transcript-only
  `BaseProjection` subclass — they are no longer silently skipped.
- **Unmapped modes fail loudly.** A newly synced fixture whose `mode` has no
  projection mapping fails the suite instead of being skipped, so fixture
  drift is caught at sync time.
- **Reject-path fixture contract.** A dedicated test asserts that every
  `expect: "reject"` message carries a canonical, non-empty
  `expected_error_code` (one of the NACK codes in `src/constants.ts`) and a
  resolvable `payload_type`.
- **Runtime NACK codes are out of scope here.** This in-process harness only
  replays the accepted prefix; whether the runtime actually returns each
  `expected_error_code` is asserted by the **macp-runtime conformance
  oracle** (see the
  [runtime testing guide](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/testing.md)).
  The suite carries explicit `it.skip` markers documenting that
  split rather than pretending to cover it.

### Fixture Drift Gate

`make verify-fixtures` diffs this SDK's vendored fixtures against the spec repo's
canonical copies and fails if either has drifted; `make sync-fixtures` refreshes
the vendored copies from a local spec checkout. Both targets cover **two** fixture
sets in one invocation:

- `tests/conformance/*.json` against `$(SPEC_CONFORMANCE_DIR)/*.json` (flat).
- `tests/vectors/cmt-hash/*.json` against `$(SPEC_CONFORMANCE_DIR)/cmt-hash/*.json`
  (the RFC-MACP-0013 commitment-hash vectors — see
  [`tests/vectors/cmt-hash/SOURCE.md`](../../tests/vectors/cmt-hash/SOURCE.md) for
  that directory's provenance).

`verify-fixtures` reports every problem across both sets before exiting — a
canonical file that differs from (or is missing from) the vendored copy prints
`DRIFT:`, and a vendored file with no canonical source prints `EXTRA:`. CI runs
this gate on every PR via `.github/workflows/conformance-fixtures.yml`, so a
spec-side fixture or vector change that isn't synced here fails the build.

`sync-fixtures` copies but never deletes: if a canonical file is renamed or
removed upstream, the sync leaves the orphaned vendored file in place and
`verify-fixtures` keeps reporting it as `EXTRA:` until it's removed by hand.

```bash
make verify-fixtures                                    # uses the default sibling-checkout path
make verify-fixtures SPEC_CONFORMANCE_DIR=/path/to/schemas/conformance
make sync-fixtures SPEC_CONFORMANCE_DIR=/path/to/schemas/conformance
```

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

Integration tests drive the full SDK against a live MACP runtime in Docker.
They are **local-only** — excluded from `npm test` (and from CI) via the
vitest config split, and run with their own config
(`vitest.integration.config.ts`). See
[`tests/integration/README.md`](../../tests/integration/README.md) for the
full harness (runtime setup, env vars, and the optional direct-agent-auth
block gated on `MACP_TEST_BEARER_ALICE` / `MACP_TEST_BEARER_BOB`).

Common flow:

```bash
docker build -t macp-runtime ../macp-runtime/
docker run -d --name macp-runtime-test -p 50051:50051 \
  -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 \
  -e MACP_MEMORY_ONLY=1 macp-runtime

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
