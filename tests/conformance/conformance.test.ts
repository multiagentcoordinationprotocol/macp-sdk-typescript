import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { buildEnvelope } from '../../src/envelope';
import { _resetLoggingForTests, configureLogging, type LogSink } from '../../src/logging';
import { ProtoRegistry } from '../../src/proto-registry';
import { duplicateAcceptedBallots } from './duplicate-ballots';
import {
  MODE_DECISION,
  MODE_PROPOSAL,
  MODE_TASK,
  MODE_HANDOFF,
  MODE_QUORUM,
  MODE_MULTI_ROUND,
  UNSUPPORTED_PROTOCOL_VERSION,
  INVALID_ENVELOPE,
  SESSION_ALREADY_EXISTS,
  SESSION_NOT_FOUND,
  SESSION_NOT_OPEN,
  MODE_NOT_SUPPORTED,
  FORBIDDEN,
  UNAUTHENTICATED,
  DUPLICATE_MESSAGE,
  PAYLOAD_TOO_LARGE,
  RATE_LIMITED,
  INTERNAL_ERROR,
  POLICY_DENIED,
  INVALID_SESSION_ID,
  UNKNOWN_POLICY_VERSION,
  INVALID_POLICY_DEFINITION,
  REGISTRY_READ_ONLY,
  INVALID_REQUEST,
  STREAM_LAGGED,
  AGENT_NOT_FOUND,
} from '../../src/constants';
import { BaseProjection, type ProjectionAnomaly } from '../../src/projections/base';
import { DecisionProjection } from '../../src/projections/decision';
import { ProposalProjection, type ProposalRecord } from '../../src/projections/proposal';
import { TaskProjection } from '../../src/projections/task';
import { HandoffProjection, type HandoffRecord } from '../../src/projections/handoff';
import { QuorumProjection } from '../../src/projections/quorum';

interface FixtureMessage {
  sender: string;
  message_type: string;
  payload_type: string;
  payload: Record<string, unknown>;
  expect: 'accept' | 'reject';
  /**
   * Canonical reject expectation (spec `schema.json`). This in-process harness
   * only replays the accepted prefix, so the runtime behaviour behind the code
   * is asserted by the runtime's own conformance oracle (see the explicit
   * `it.skip` markers below). The harness DOES assert the fixture-side
   * contract: every reject message carries a canonical, non-empty code and a
   * resolvable payload_type — see 'conformance: reject-path fixtures'.
   */
  expected_error_code?: string;
  /**
   * Acceptance clock for this step (spec #192, RFC-MACP-0001 §7.6 item 4).
   * All-or-none across the fixture's messages, and non-decreasing. Distinct
   * from the Envelope's `timestamp_unix_ms`: the projection has no acceptance
   * clock, so the harness only validates it and switches the default Envelope
   * timestamp to 0, exactly as the spec's harness contract says.
   */
  accepted_at_ms?: number;
  /** Envelope field overrides (spec #192). A SessionStart MUST set `session_id`. */
  envelope?: EnvelopeOverrides;
}

interface EnvelopeOverrides {
  session_id?: string;
  macp_version?: string;
  mode?: string;
  timestamp_unix_ms?: number;
}

/** One entry of the spec's `expected_history` (accepted history after SessionStart). */
interface ExpectedHistoryEntry {
  message_type: string;
  sender: string;
  /** Subset match on the decoded payload. */
  payload?: Record<string, unknown>;
  /** A runtime-emitted envelope no fixture message submitted (e.g. RFC-MACP-0010 §5.1 implicit accept). */
  synthetic?: boolean;
}

interface Fixture {
  mode: string;
  initiator: string;
  participants: string[];
  mode_version: string;
  configuration_version: string;
  policy?: Record<string, unknown>;
  policy_version: string;
  ttl_ms: number;
  messages: FixtureMessage[];
  expected_final_state?: string;
  expect_resolution_present?: boolean;
  expected_resolution?: Record<string, unknown>;
  expected_mode_state?: Record<string, unknown>;
  expected_history?: ExpectedHistoryEntry[];
}

type ProjectionLike = {
  applyEnvelope(envelope: ReturnType<typeof buildEnvelope>, registry: ProtoRegistry): void;
  phase: string;
  commitment?: Record<string, unknown>;
  // Phase 6 (issue #55): optional because this local `ProjectionLike` is
  // structurally distinct from `src/agent/types.ts`'s exported interface of
  // the same name — see that file for the deliberate divergence.
  // `DecisionProjection`, `QuorumProjection`, `TaskProjection`, and
  // `HandoffProjection` populate `anomalies` today (issue #126/#128); every
  // canonical fixture must still replay with zero, since no fixture carries
  // the cardinality violation any of these kinds records.
  anomalies?: readonly ProjectionAnomaly[];
};

/**
 * Replay projection for the `ext.multi_round.v1` extension mode. The mode has
 * no first-class projection class; fixtures assert only transcript length,
 * commitment presence, and resolution scalars — all handled generically by
 * {@link BaseProjection} — so a transcript-only subclass gives the multi_round
 * fixtures real assertions instead of a silent skip.
 */
class MultiRoundReplayProjection extends BaseProjection {
  protected readonly mode = MODE_MULTI_ROUND;

  protected applyMode(): void {
    // Transcript-only: the fixtures carry no expected_mode_state for
    // multi_round, so there is no per-message state to track.
  }
}

const MODE_PROJECTIONS: Record<string, () => ProjectionLike> = {
  [MODE_DECISION]: () => new DecisionProjection() as unknown as ProjectionLike,
  [MODE_PROPOSAL]: () => new ProposalProjection() as unknown as ProjectionLike,
  [MODE_TASK]: () => new TaskProjection() as unknown as ProjectionLike,
  [MODE_HANDOFF]: () => new HandoffProjection() as unknown as ProjectionLike,
  [MODE_QUORUM]: () => new QuorumProjection() as unknown as ProjectionLike,
  [MODE_MULTI_ROUND]: () => new MultiRoundReplayProjection() as unknown as ProjectionLike,
};

// Canonical NACK codes the runtime can emit (src/constants.ts, parity with
// python-sdk). The reject-path guard below fails if a fixture ever carries a
// code outside this set — catching typos and spec drift at sync time.
const CANONICAL_ERROR_CODES = new Set([
  UNSUPPORTED_PROTOCOL_VERSION,
  INVALID_ENVELOPE,
  SESSION_ALREADY_EXISTS,
  SESSION_NOT_FOUND,
  SESSION_NOT_OPEN,
  MODE_NOT_SUPPORTED,
  FORBIDDEN,
  UNAUTHENTICATED,
  DUPLICATE_MESSAGE,
  PAYLOAD_TOO_LARGE,
  RATE_LIMITED,
  INTERNAL_ERROR,
  POLICY_DENIED,
  INVALID_SESSION_ID,
  UNKNOWN_POLICY_VERSION,
  INVALID_POLICY_DEFINITION,
  // Permanent since runtime 0.9.0 / parity contract 1.4.0.
  REGISTRY_READ_ONLY,
  INVALID_REQUEST,
  STREAM_LAGGED,
  AGENT_NOT_FOUND,
]);

const MODE_SHORT_MAP: Record<string, string> = {
  decision: MODE_DECISION,
  proposal: MODE_PROPOSAL,
  task: MODE_TASK,
  handoff: MODE_HANDOFF,
  quorum: MODE_QUORUM,
  multi_round: MODE_MULTI_ROUND,
};

// Canonical fixture `payload_type` values are fully-qualified proto message
// names (spec `schema.json`): `macp.v1.<Name>Payload` for core payloads and
// `macp.modes.<mode>.v1.<Name>Payload` for mode payloads. The legacy shorthand
// (`decision.Proposal`, bare `Commitment`) is intentionally NOT parsed — the
// format-guard test below fails any fixture that regresses to it, mirroring the
// runtime's own format guard.
const CORE_PAYLOAD_RE = /^macp\.v1\.([A-Za-z]+)Payload$/;
const MODE_PAYLOAD_RE = /^macp\.modes\.([a-z_]+)\.v\d+\.([A-Za-z]+)Payload$/;

// Map a fully-qualified `payload_type` to (mode, messageType) for ProtoRegistry.
// The package prefix disambiguates decision-vs-proposal `Proposal` payloads —
// exactly why the harness must key on package, not the bare message name.
function resolvePayloadType(payloadType: string): { mode: string; messageType: string } {
  const core = CORE_PAYLOAD_RE.exec(payloadType);
  if (core) return { mode: '', messageType: core[1] };

  const mode = MODE_PAYLOAD_RE.exec(payloadType);
  if (mode) {
    const resolvedMode = MODE_SHORT_MAP[mode[1]];
    if (!resolvedMode) throw new Error(`unknown mode in payload_type: ${payloadType}`);
    return { mode: resolvedMode, messageType: mode[2] };
  }

  throw new Error(`payload_type is not a canonical fully-qualified proto name: ${payloadType}`);
}

// Same pattern as spec `schema.json` — used by the format-guard test so a
// shorthand `payload_type` can never re-enter the vendored fixtures.
const CANONICAL_PAYLOAD_TYPE_RE = /^(macp\.v1\.[A-Za-z]+|macp\.modes\.[a-z_]+\.v\d+\.[A-Za-z]+Payload)$/;

// Proto `bytes` fields (camelCase). Fixtures are JSON, so these arrive as plain
// strings and must be UTF-8 encoded to a Buffer before protobuf encoding —
// mirrors the python harness's descriptor-driven str→bytes coercion.
const BYTES_FIELDS = new Set(['context', 'supportingData', 'details', 'input', 'output', 'partialOutput', 'data']);

const snakeToCamel = (key: string): string => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}

// Normalize a fixture payload for ProtoRegistry: snake_case → camelCase keys,
// recursively. `bytes` fields arrive either as a UTF-8 string or as a JSON
// byte array (serde's `Vec<u8>` encoding, e.g. `"details": []`) and become a
// Buffer; every other array (repeated fields such as `tags`, `participants`)
// is preserved element-wise.
function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const camelKey = snakeToCamel(key);
    if (BYTES_FIELDS.has(camelKey) && typeof value === 'string') {
      result[camelKey] = Buffer.from(value, 'utf8');
    } else if (BYTES_FIELDS.has(camelKey) && Array.isArray(value)) {
      result[camelKey] = Buffer.from(value as number[]);
    } else if (Array.isArray(value)) {
      result[camelKey] = value.map((item) => (isPlainObject(item) ? normalizePayload(item) : item));
    } else if (isPlainObject(value)) {
      result[camelKey] = normalizePayload(value);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

/**
 * Runtime `assert_json_contains` semantics (macp-runtime
 * `tests/conformance_loader.rs`): an expected object is a subset of the
 * actual one (every expected key present and recursively contained), an
 * expected array is a prefix of the actual one, anything else is strict
 * equality. Mirrored exactly so the SDK and runtime read the same fixture
 * the same way.
 */
function expectContains(actual: unknown, expected: unknown, at: string): void {
  if (isPlainObject(expected)) {
    expect(isPlainObject(actual), `${at}: expected an object, got ${JSON.stringify(actual)}`).toBe(true);
    const actualObject = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(key in actualObject, `${at}: missing key '${key}' in ${JSON.stringify(actual)}`).toBe(true);
      expectContains(actualObject[key], value, `${at}.${key}`);
    }
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${at}: expected an array, got ${JSON.stringify(actual)}`).toBe(true);
    const actualArray = actual as unknown[];
    expect(
      actualArray.length,
      `${at}: actual array shorter than expected: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
    ).toBeGreaterThanOrEqual(expected.length);
    expected.forEach((item, idx) => expectContains(actualArray[idx], item, `${at}[${idx}]`));
  } else {
    expect(actual, at).toEqual(expected);
  }
}

// ── expected_mode_state: projection → runtime-shaped views ─────────────
//
// `expected_mode_state` is the runtime's serialized `mode_state`, so each key
// gets an explicit view that renders the projection in the runtime's shape and
// vocabulary (snake_case, `disposition` enums). A key with no view fails the
// fixture: adding a key upstream must be a deliberate harness change, never a
// silent pass.

/** `ProposalRecord.status` → runtime `ProposalDisposition` (Live | Withdrawn). */
const PROPOSAL_DISPOSITION: Record<ProposalRecord['status'], string> = {
  open: 'Live',
  // A terminal Reject ends negotiation (phase TerminalRejected) but does not
  // retire the proposal: the runtime has no Rejected disposition.
  rejected: 'Live',
  withdrawn: 'Withdrawn',
};

/** `HandoffRecord.status` → runtime `HandoffDisposition` (Offered | Accepted | Declined). */
const HANDOFF_DISPOSITION: Record<HandoffRecord['status'], string> = {
  offered: 'Offered',
  context_sent: 'Offered',
  accepted: 'Accepted',
  declined: 'Declined',
};

type ModeStateView = (projection: unknown) => unknown;

const MODE_STATE_VIEWS: Record<string, Record<string, ModeStateView>> = {
  [MODE_DECISION]: {
    phase: (p) => (p as DecisionProjection).phase,
    proposals: (p) =>
      Object.fromEntries(
        [...(p as DecisionProjection).proposals].map(([id, r]) => [
          id,
          { proposal_id: r.proposalId, option: r.option, sender: r.sender },
        ]),
      ),
    objections: (p) =>
      (p as DecisionProjection).objections.map((o) => ({
        proposal_id: o.proposalId,
        reason: o.reason,
        severity: o.severity,
        sender: o.sender,
      })),
    votes: (p) =>
      Object.fromEntries(
        [...(p as DecisionProjection).votes].map(([proposalId, bySender]) => [
          proposalId,
          Object.fromEntries([...bySender].map(([sender, v]) => [sender, { vote: v.vote, sender: v.sender }])),
        ]),
      ),
  },
  [MODE_PROPOSAL]: {
    phase: (p) => (p as ProposalProjection).phase,
    proposals: (p) =>
      Object.fromEntries(
        [...(p as ProposalProjection).proposals].map(([id, r]) => [
          id,
          {
            proposal_id: r.proposalId,
            title: r.title,
            proposer: r.sender,
            disposition: PROPOSAL_DISPOSITION[r.status],
          },
        ]),
      ),
    // Runtime `accepts` is the live acceptance set: sender → the proposal its
    // latest Accept targets (RFC-MACP-0008 §5 rule 5). The projection keeps
    // that in a private map (its public `accepts` is the append-only history).
    accepts: (p) =>
      Object.fromEntries(
        [...(p as unknown as { latestAcceptBySender: Map<string, { proposalId: string }> }).latestAcceptBySender].map(
          ([sender, a]) => [sender, a.proposalId],
        ),
      ),
  },
  [MODE_HANDOFF]: {
    phase: (p) => (p as HandoffProjection).phase,
    offers: (p) =>
      Object.fromEntries(
        [...(p as HandoffProjection).handoffs].map(([id, h]) => [
          id,
          {
            handoff_id: h.handoffId,
            target_participant: h.targetParticipant,
            disposition: HANDOFF_DISPOSITION[h.status],
            implicit: h.implicit ?? false,
          },
        ]),
      ),
  },
  [MODE_TASK]: { phase: (p) => (p as TaskProjection).phase },
  [MODE_QUORUM]: { phase: (p) => (p as QuorumProjection).phase },
  [MODE_MULTI_ROUND]: {},
};

/** One envelope to apply: a fixture message, or a synthetic `expected_history` entry. */
interface ReplayStep {
  sender: string;
  messageType: string;
  /** Fully-qualified payload type; synthetic entries derive it from the fixture mode. */
  payloadType?: string;
  payload: Record<string, unknown>;
  envelope?: EnvelopeOverrides;
  /** The `expected_history` entry this step must satisfy, if the fixture has one. */
  history?: ExpectedHistoryEntry;
}

/**
 * Validates the spec #192 per-message fields and returns whether the fixture
 * runs on the acceptance clock. Fails loudly on a contract violation instead of
 * replaying something the runtime harness would refuse.
 */
function validateMessageClock(fixture: Fixture, fixtureName: string): boolean {
  const withClock = fixture.messages.filter((m) => m.accepted_at_ms !== undefined);
  for (const msg of fixture.messages) {
    if (msg.message_type === 'SessionStart') {
      expect(
        msg.envelope?.session_id,
        `${fixtureName}: a SessionStart message must set envelope.session_id (spec #192)`,
      ).toBeTruthy();
    }
  }
  if (withClock.length === 0) return false;
  expect(
    withClock.length,
    `${fixtureName}: accepted_at_ms is all-or-none — ${withClock.length} of ${fixture.messages.length} messages carry it`,
  ).toBe(fixture.messages.length);
  for (let i = 1; i < fixture.messages.length; i++) {
    expect(
      fixture.messages[i].accepted_at_ms!,
      `${fixtureName}: accepted_at_ms must be non-decreasing (message ${i})`,
    ).toBeGreaterThanOrEqual(fixture.messages[i - 1].accepted_at_ms!);
  }
  return true;
}

/**
 * The envelopes to apply, in acceptance order. Without `expected_history` that
 * is the accepted messages. With it, the history is authoritative: each
 * non-synthetic entry must line up with the next accepted message (same type
 * and sender), each synthetic entry is applied from its own payload, and no
 * accepted message may be left over.
 */
function replaySteps(fixture: Fixture, fixtureName: string): ReplayStep[] {
  const accepted = fixture.messages.filter((m) => m.expect === 'accept');
  const fromMessage = (m: FixtureMessage, history?: ExpectedHistoryEntry): ReplayStep => ({
    sender: m.sender,
    messageType: m.message_type,
    payloadType: m.payload_type,
    payload: m.payload,
    envelope: m.envelope,
    history,
  });
  if (!fixture.expected_history) return accepted.map((m) => fromMessage(m));

  const steps: ReplayStep[] = [];
  let next = 0;
  fixture.expected_history.forEach((entry, idx) => {
    if (entry.synthetic) {
      steps.push({
        sender: entry.sender,
        messageType: entry.message_type,
        payload: entry.payload ?? {},
        history: entry,
      });
      return;
    }
    const msg = accepted[next++];
    expect(msg, `${fixtureName}: expected_history[${idx}] has no matching accepted message`).toBeDefined();
    expect(
      `${msg.message_type} from ${msg.sender}`,
      `${fixtureName}: expected_history[${idx}] does not match the next accepted message`,
    ).toBe(`${entry.message_type} from ${entry.sender}`);
    steps.push(fromMessage(msg, entry));
  });
  expect(next, `${fixtureName}: accepted messages missing from expected_history`).toBe(accepted.length);
  return steps;
}

/**
 * Replays one fixture through its projection and asserts everything the
 * fixture states about the result. Throws (via `expect`) on any mismatch, so
 * the mutation self-tests below can prove each comparison is live.
 */
function replayAndCheck(fixture: Fixture, fixtureName: string): ProjectionLike {
  const projectionFactory = MODE_PROJECTIONS[fixture.mode];
  expect(projectionFactory, `no projection registered for mode '${fixture.mode}'`).toBeDefined();
  const projection = projectionFactory();
  const onAcceptanceClock = validateMessageClock(fixture, fixtureName);
  const steps = replaySteps(fixture, fixtureName);

  for (const step of steps) {
    const { mode, messageType } = step.payloadType
      ? resolvePayloadType(step.payloadType)
      : { mode: fixture.mode, messageType: step.messageType };
    const resolvedMode = mode || step.envelope?.mode || fixture.mode;
    const payloadBytes = registry.encodeKnownPayload(resolvedMode, messageType, normalizePayload(step.payload));

    const envelope = buildEnvelope({
      mode: step.envelope?.mode ?? fixture.mode,
      messageType: step.messageType,
      sessionId: step.envelope?.session_id ?? 'conformance-session',
      sender: step.sender,
      payload: payloadBytes,
      macpVersion: step.envelope?.macp_version,
      timestampUnixMs: step.envelope?.timestamp_unix_ms ?? (onAcceptanceClock ? 0 : undefined),
    });

    if (step.history?.payload) {
      const decoded = registry.decodeKnownPayload(resolvedMode, messageType, payloadBytes);
      expectContains(decoded, normalizePayload(step.history.payload), `${fixtureName}: expected_history payload`);
    }

    projection.applyEnvelope(envelope, registry);
  }

  // Every applied step lands in the transcript, synthetic ones included.
  const transcript = (projection as unknown as { transcript: unknown[] }).transcript;
  expect(transcript.length).toBe(steps.length);

  // Commitment presence is driven solely by the terminal state:
  // RESOLVED ⇒ committed. Identical rule to the python harness.
  if (fixture.expected_final_state === 'Resolved') {
    expect(projection.commitment).toBeDefined();
  } else {
    expect(projection.commitment).toBeUndefined();
  }

  // Verify every scalar field of expected_resolution (incl. outcome_positive)
  if (fixture.expected_resolution && projection.commitment) {
    const commitment = projection.commitment as Record<string, unknown>;
    for (const [key, expectedValue] of Object.entries(fixture.expected_resolution)) {
      expect(commitment[snakeToCamel(key)]).toBe(expectedValue);
    }
  }

  // Every expected_mode_state key is compared, or the fixture fails.
  const expectedState = fixture.expected_mode_state ?? {};
  const views = MODE_STATE_VIEWS[fixture.mode] ?? {};
  let compared = 0;
  for (const [key, expectedValue] of Object.entries(expectedState)) {
    const view = views[key];
    expect(
      view,
      `${fixtureName}: expected_mode_state.${key} has no comparator for mode '${fixture.mode}' — add one to MODE_STATE_VIEWS`,
    ).toBeDefined();
    expectContains(view(projection), expectedValue, `${fixtureName}: expected_mode_state.${key}`);
    compared++;
  }
  expect(compared).toBe(Object.keys(expectedState).length);

  return projection;
}

const FIXTURE_DIR = path.resolve(__dirname);
const registry = new ProtoRegistry();

const fixtureFiles = fs
  .readdirSync(FIXTURE_DIR)
  // `schema.json` is the canonical JSON-Schema definition, synced alongside the
  // fixtures by `make sync-fixtures` — it is not a fixture, so exclude it.
  .filter((f) => f.endsWith('.json') && f !== 'schema.json')
  .sort();

describe('conformance: projection replay', () => {
  // Phase 6 (issue #55): the array (`anomalies`) and the log
  // (`logger.warn('projection anomaly', ...)`) are independent channels —
  // both must be silent across every canonical fixture replay. An injected
  // sink lets each fixture's `it()` assert zero 'projection anomaly' warn
  // calls without touching global logging state between tests.
  let sink: LogSink & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sink = vi.fn();
    // Pin the level: configureLogging({ sink }) alone leaves the level to
    // MACP_LOG_LEVEL, and under `error`/`silent` emit() short-circuits so the
    // sink is never called -- the zero-warn assertion below would then pass
    // against an empty array for the wrong reason, silently collapsing the
    // two independent channels into one. afterEach's _resetLoggingForTests()
    // restores the env-derived level.
    configureLogging({ level: 'warn', sink });
  });

  afterEach(() => {
    _resetLoggingForTests();
  });

  for (const file of fixtureFiles) {
    const fixtureName = path.basename(file, '.json');
    const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));

    const projectionFactory = MODE_PROJECTIONS[fixture.mode];
    if (!projectionFactory) {
      // A newly synced fixture for an unmapped mode must fail loudly instead
      // of silently contributing zero assertions.
      it(`${fixtureName}: has a registered replay projection`, () => {
        expect.fail(`no projection registered for mode '${fixture.mode}' — add it to MODE_PROJECTIONS`);
      });
      continue;
    }

    it(`${fixtureName}: replays accepted messages through projection`, () => {
      const projection = replayAndCheck(fixture, fixtureName);

      // Phase 6 (issue #55): every canonical fixture must replay with ZERO
      // anomalies. `DecisionProjection`, `QuorumProjection`, `TaskProjection`,
      // and `HandoffProjection` populate `anomalies` today (issue #126/#128);
      // the other two (Proposal, and the `ext.multi_round.v1` extension mode)
      // are always `[]`/`undefined` here. A non-empty array means either a
      // fixture regressed to carrying a duplicate accepted Vote/ballot (see
      // the sibling 'conformance: no duplicate accepted vote or ballot'
      // describe below, which should have already caught it) or a projection
      // is over-flagging a conforming transcript.
      const anomalies = projection.anomalies ?? [];
      expect(
        anomalies,
        `${fixtureName}: expected zero projection anomalies, found ${JSON.stringify(anomalies)}`,
      ).toEqual([]);

      // Phase 6 (issue #55): the log channel is independent of the
      // `anomalies` array above and must be silent too — no
      // `logger.warn('projection anomaly', ...)` for a conforming replay.
      const anomalyWarnCalls = sink.mock.calls.filter(
        ([level, args]) => level === 'warn' && args[0] === 'projection anomaly',
      );
      expect(
        anomalyWarnCalls,
        `${fixtureName}: expected zero 'projection anomaly' warn logs, found ${JSON.stringify(anomalyWarnCalls)}`,
      ).toEqual([]);
    });
  }
});

// Phase 6 (issue #55): no canonical fixture may carry a duplicate *accepted*
// Vote (Decision) or ballot (Quorum, collapsed across Approve/Reject/Abstain)
// from the same sender for the same subject — a conforming runtime never
// produces one. If this ever fails, the fix belongs upstream in the spec
// repo's `schemas/conformance/` directory: `tests/conformance/*.json` here
// are vendored copies gated bidirectionally by `make verify-fixtures`, so a
// local edit to quiet this guard would just fail that gate as DRIFT instead.
// Non-vacuity: each comparison the replay makes must be able to fail. Every
// case mutates one canonical fixture in a way the runtime would read
// differently and asserts the replay now rejects it — so a view that
// silently stops comparing (or a history step that stops applying) reddens
// here instead of passing every fixture forever.
describe('conformance: harness self-tests (mutations must fail)', () => {
  const load = (name: string): Fixture =>
    JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as Fixture;
  // Just the expected_mode_state paths the mutations below touch.
  interface MutableModeState {
    offers: Record<string, { disposition: string }>;
    proposals: Record<string, Record<string, string>>;
    accepts: Record<string, string>;
    objections: Array<Record<string, string>>;
    votes: Record<string, Record<string, { vote: string }>>;
    evaluations?: unknown;
  }
  const modeState = (f: Fixture) => f.expected_mode_state as unknown as MutableModeState;

  const mutations: Array<[string, string, (f: Fixture) => void]> = [
    [
      'dropping the synthetic implicit accept',
      'handoff_implicit_accept',
      (f) => {
        f.expected_history = f.expected_history!.filter((e) => !e.synthetic);
      },
    ],
    [
      'a history payload the accepted message does not carry',
      'handoff_implicit_accept',
      (f) => {
        f.expected_history![0].payload = { handoff_id: 'h-other' };
      },
    ],
    [
      'a history entry naming the wrong sender',
      'handoff_implicit_accept',
      (f) => {
        f.expected_history![0].sender = 'agent://someone-else';
      },
    ],
    [
      'accepted_at_ms on only some messages',
      'handoff_implicit_accept',
      (f) => {
        delete f.messages[f.messages.length - 1].accepted_at_ms;
      },
    ],
    [
      'a decreasing accepted_at_ms',
      'handoff_implicit_accept',
      (f) => {
        f.messages[f.messages.length - 1].accepted_at_ms = 0;
        f.messages[0].accepted_at_ms = 5000;
      },
    ],
    [
      'a SessionStart without envelope.session_id',
      'session_start_reject_paths',
      (f) => {
        delete f.messages.find((m) => m.message_type === 'SessionStart')!.envelope!.session_id;
      },
    ],
    [
      'an offer disposition',
      'handoff_reject_paths',
      (f) => {
        modeState(f).offers.h1.disposition = 'Accepted';
      },
    ],
    [
      'a proposal disposition',
      'proposal_reject_paths',
      (f) => {
        modeState(f).proposals.p2.disposition = 'Live';
      },
    ],
    [
      'a proposal proposer',
      'proposal_happy_path',
      (f) => {
        modeState(f).proposals.p1.proposer = 'agent://buyer';
      },
    ],
    [
      'an accepts entry',
      'proposal_happy_path',
      (f) => {
        modeState(f).accepts['agent://buyer'] = 'p2';
      },
    ],
    [
      'an objection severity',
      'decision_happy_path',
      (f) => {
        modeState(f).objections[0].severity = 'low';
      },
    ],
    [
      'an extra objection',
      'decision_happy_path',
      (f) => {
        modeState(f).objections.push({ proposal_id: 'p1', severity: 'critical', sender: 'agent://c' });
      },
    ],
    [
      'a decision proposal sender',
      'decision_happy_path',
      (f) => {
        modeState(f).proposals.p1.sender = 'agent://a';
      },
    ],
    [
      'a vote value',
      'decision_happy_path',
      (f) => {
        modeState(f).votes.p1['agent://a'].vote = 'REJECT';
      },
    ],
    [
      'a key with no comparator',
      'decision_happy_path',
      (f) => {
        modeState(f).evaluations = {};
      },
    ],
  ];

  it.each(mutations)('rejects %s (%s)', (_label, name, mutate) => {
    const pristine = load(name);
    expect(() => replayAndCheck(pristine, name)).not.toThrow();
    const mutated = load(name);
    mutate(mutated);
    expect(() => replayAndCheck(mutated, name)).toThrow();
  });
});

// RFC-MACP-0009 §5 rule 2a (runtime ≥ 0.9.0): in task_reject_paths, w1's
// TaskReject lands before anyone accepted, so it is a personal decline — w1 is
// out, the task stays open, and w2 takes it. Same assertions as
// macp-sdk-python's conformance replay (issue #177).
describe('conformance: task rule 2a personal decline', () => {
  it('task_reject_paths: w1 declines, w2 holds the task', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'task_reject_paths.json'), 'utf8')) as Fixture;
    const projection = replayAndCheck(fixture, 'task_reject_paths') as unknown as TaskProjection;
    expect(projection.declinedParticipants()).toEqual(['agent://w1']);
    expect(projection.rejections[0].whileAssigned).toBe(false);
    expect((projection as unknown as { activeAssignment: unknown }).activeAssignment).toEqual({
      sender: 'agent://w2',
      taskId: 't1',
    });
    expect(projection.canAccept('agent://w1')).toBe(false);
    expect(projection.getTask('t1')?.status).toBe('in_progress');
    expect(projection.updates.map((u) => u.sender)).toEqual(['agent://w2']);
  });
});

describe('conformance: no duplicate accepted vote or ballot', () => {
  for (const file of fixtureFiles) {
    const fixtureName = path.basename(file, '.json');
    const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));

    it(`${fixtureName}: no accepted message duplicates a Vote or ballot`, () => {
      const duplicates = duplicateAcceptedBallots(fixture.messages);
      const description = duplicates
        .map((d) => `sender=${d.sender} id=${d.id} messageType=${d.messageType}`)
        .join(', ');
      expect(
        duplicates,
        `${fixtureName} has duplicate accepted Vote/ballot(s): ${description} — fixtures are canonical; ` +
          'fix upstream in the spec repo, never locally',
      ).toEqual([]);
    });
  }
});

// Format guard: every vendored fixture must use canonical fully-qualified
// `payload_type` names. Fails loudly if a hand-edited or drifted fixture
// reintroduces the legacy shorthand (`decision.Proposal`, bare `Commitment`),
// mirroring the runtime's own format-guard test so the harness parser and the
// fixtures can never diverge.
describe('conformance: fixture format guard', () => {
  for (const file of fixtureFiles) {
    const fixtureName = path.basename(file, '.json');
    const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));

    it(`${fixtureName}: every payload_type is canonical fully-qualified`, () => {
      for (const msg of fixture.messages) {
        expect(msg.payload_type).toMatch(CANONICAL_PAYLOAD_TYPE_RE);
      }
    });
  }
});

// Reject-path contract: this in-process harness replays only the accepted
// prefix, so it cannot observe the runtime NACK itself — but it CAN pin the
// fixture-side contract so reject expectations never rot: every rejected
// message must carry a canonical error code and a payload_type the registry
// can still resolve. The runtime-behaviour half is an explicit, visible skip
// (not a silent one) pointing at the runtime's conformance oracle.
describe('conformance: reject-path fixtures', () => {
  for (const file of fixtureFiles) {
    const fixtureName = path.basename(file, '.json');
    const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
    const rejected = fixture.messages.filter((m) => m.expect === 'reject');
    if (rejected.length === 0) continue;

    it(`${fixtureName}: every reject message carries a canonical expected_error_code and a resolvable payload_type`, () => {
      for (const msg of rejected) {
        expect(
          msg.expected_error_code,
          `${msg.message_type} from ${msg.sender} is missing expected_error_code`,
        ).toBeTruthy();
        expect(
          CANONICAL_ERROR_CODES.has(msg.expected_error_code!),
          `'${msg.expected_error_code}' is not a canonical NACK code`,
        ).toBe(true);
        // The payload must still parse through the registry mapping — a
        // reject fixture whose payload_type rots would otherwise go unnoticed.
        expect(() => resolvePayloadType(msg.payload_type)).not.toThrow();
      }
    });

    it.skip(`${fixtureName}: runtime NACK codes are asserted by the runtime conformance oracle only (macp-runtime)`, () => {
      // Intentionally skipped: replaying a reject against the in-process
      // projection cannot produce the runtime's NACK. The macp-runtime repo's
      // conformance suite drives these same fixtures against the real server
      // and asserts each expected_error_code there.
    });
  }
});
