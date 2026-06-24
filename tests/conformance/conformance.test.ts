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
} from '../../src/constants';
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
}

interface Fixture {
  mode: string;
  initiator: string;
  participants: string[];
  mode_version: string;
  configuration_version: string;
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

const MODE_PROJECTIONS: Record<string, () => ProjectionLike> = {
  [MODE_DECISION]: () => new DecisionProjection() as unknown as ProjectionLike,
  [MODE_PROPOSAL]: () => new ProposalProjection() as unknown as ProjectionLike,
  [MODE_TASK]: () => new TaskProjection() as unknown as ProjectionLike,
  [MODE_HANDOFF]: () => new HandoffProjection() as unknown as ProjectionLike,
  [MODE_QUORUM]: () => new QuorumProjection() as unknown as ProjectionLike,
};

// Map payload_type from fixture format to (mode, messageType) for ProtoRegistry
function resolvePayloadType(payloadType: string): { mode: string; messageType: string } {
  // Core types like "Commitment"
  if (!payloadType.includes('.')) {
    return { mode: '', messageType: payloadType };
  }

  const [modeShort, messageType] = payloadType.split('.');
  const modeMap: Record<string, string> = {
    decision: MODE_DECISION,
    proposal: MODE_PROPOSAL,
    task: MODE_TASK,
    handoff: MODE_HANDOFF,
    quorum: MODE_QUORUM,
    multi_round: MODE_MULTI_ROUND,
  };

  return { mode: modeMap[modeShort] ?? '', messageType };
}

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
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('conformance: projection replay', () => {
  for (const file of fixtureFiles) {
    const fixtureName = path.basename(file, '.json');
    const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));

    // Skip multi_round — no projection class for extension modes. Reject-path
    // fixtures ARE replayed (their accepted prefix) so the projection state is
    // asserted in lockstep with the python harness.
    if (fixture.mode === MODE_MULTI_ROUND) continue;

    const projectionFactory = MODE_PROJECTIONS[fixture.mode];
    if (!projectionFactory) continue;

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
      const expectedVotes = fixture.expected_mode_state?.votes as
        | Record<string, Record<string, { vote: string }>>
        | undefined;
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
