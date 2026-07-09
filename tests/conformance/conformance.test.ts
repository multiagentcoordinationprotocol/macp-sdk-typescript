import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../../src/envelope';
import { ProtoRegistry } from '../../src/proto-registry';
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
} from '../../src/constants';
import { BaseProjection } from '../../src/projections/base';
import { DecisionProjection } from '../../src/projections/decision';
import { ProposalProjection } from '../../src/projections/proposal';
import { TaskProjection } from '../../src/projections/task';
import { HandoffProjection } from '../../src/projections/handoff';
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
}

type ProjectionLike = {
  applyEnvelope(envelope: ReturnType<typeof buildEnvelope>, registry: ProtoRegistry): void;
  phase: string;
  commitment?: Record<string, unknown>;
};

// Shape of expected_mode_state.votes (decision mode). Named alias so the `as`
// cast below stays on one line — different prettier 3.x versions wrap an inline
// union differently, and CI installs the latest at build time.
type ExpectedVotes = Record<string, Record<string, { vote: string }>>;

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

// Normalize fixture payload field names from snake_case to camelCase for
// ProtoRegistry, coercing string values destined for `bytes` fields to Buffer.
function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // Skip repeated/list-valued fields — the projections under test don't assert
    // on them; mirrors the python harness's `isinstance(v, list): continue`.
    if (Array.isArray(value)) continue;
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = BYTES_FIELDS.has(camelKey) && typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  }
  return result;
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
      const projection = projectionFactory();
      const acceptedMessages = fixture.messages.filter((m) => m.expect === 'accept');

      for (const msg of acceptedMessages) {
        const { mode, messageType } = resolvePayloadType(msg.payload_type);
        const resolvedMode = mode || fixture.mode;
        const normalizedPayload = normalizePayload(msg.payload);

        const payloadBytes = registry.encodeKnownPayload(resolvedMode, messageType, normalizedPayload);

        const envelope = buildEnvelope({
          mode: fixture.mode,
          messageType: msg.message_type,
          sessionId: 'conformance-session',
          sender: msg.sender,
          payload: payloadBytes,
        });

        projection.applyEnvelope(envelope, registry);
      }

      // Verify transcript length matches accepted message count
      const transcript = (projection as unknown as { transcript: unknown[] }).transcript;
      expect(transcript.length).toBe(acceptedMessages.length);

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
          const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
          expect(commitment[camelKey]).toBe(expectedValue);
        }
      }

      // Verify phase matches expected mode state
      if (fixture.expected_mode_state?.phase) {
        expect(projection.phase).toBe(fixture.expected_mode_state.phase);
      }

      // Verify recorded votes match expected_mode_state.votes (decision mode)
      const expectedVotes = fixture.expected_mode_state?.votes as ExpectedVotes | undefined;
      if (expectedVotes) {
        const votes = (projection as unknown as { votes: Map<string, Map<string, { vote: string }>> }).votes;
        for (const [proposalId, bySender] of Object.entries(expectedVotes)) {
          for (const [sender, record] of Object.entries(bySender)) {
            expect(votes.get(proposalId)?.get(sender)?.vote).toBe(record.vote);
          }
        }
      }
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
