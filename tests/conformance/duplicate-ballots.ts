/**
 * Cross-fixture duplicate-vote/-ballot detector (RFC-MACP-0007 §5 rule 3 /
 * RFC-MACP-0011 §5 rule 3, issue #55 Phase 6).
 *
 * A conforming runtime never produces a second *accepted* `Vote` from the
 * same sender for the same `proposal_id` (Decision), nor a second *accepted*
 * ballot — `Approve`/`Reject`/`Abstain`, collapsed across the three types —
 * from the same sender for the same `request_id` (Quorum). A canonical
 * fixture that contained one would document a runtime bug, not a valid
 * transcript this SDK's projections should have to reconstruct. This module
 * scans a fixture's messages for exactly that shape.
 *
 * **Deliberately NOT exported from `tests/conformance/conformance.test.ts`.**
 * That file registers three module-scope `describe` blocks over the real
 * fixture set; importing anything from it into a unit test file would
 * re-register the entire conformance suite inside that unit file. This module
 * has no `describe`/`it` of its own — it is imported by both
 * `conformance.test.ts` (over the real fixtures) and
 * `tests/unit/conformance-guard.test.ts` (over synthetic input).
 */

/**
 * Minimal shape this module needs from a fixture message. Deliberately not
 * imported from `conformance.test.ts`'s own `FixtureMessage` — same reason as
 * above (importing from that file would re-register its suites) — but kept
 * structurally identical so a real `Fixture.messages` array satisfies it
 * without any adaptation.
 */
export interface DuplicateBallotCandidateMessage {
  sender: string;
  message_type: string;
  payload_type: string;
  payload: Record<string, unknown>;
  expect: 'accept' | 'reject';
}

/** One duplicate found: the sender, the subject (`proposal_id`/`request_id`), and the DISCARDED message's type. */
export interface DuplicateAcceptedBallot {
  sender: string;
  id: string;
  messageType: string;
}

const BALLOT_MESSAGE_TYPES = new Set(['Approve', 'Reject', 'Abstain']);

// Gate the ballot arm on the MESSAGE's own `payload_type` prefix, never on
// `message_type` name alone.
//
// `message_type` is NOT a unique discriminator across modes: `Reject` is
// defined identically-named in at least Proposal (`macp.modes.proposal.v1.
// RejectPayload`) and Quorum (`macp.modes.quorum.v1.RejectPayload`), and both
// are live in the canonical corpus today — `proposal_negative_outcome.json`
// carries an accepted Proposal `Reject` (no `request_id`), so keying the
// ballot arm on `message_type` alone would let that Proposal `Reject` enter
// the ballot bucket and collide with an unrelated Quorum ballot from the same
// sender under a shared `(sender, undefined)` key — a wrong tally with no
// error, the exact failure class issue #55 is about, reproduced inside the
// guard meant to catch it.
//
// There are genuinely TWO different keys that solve this, at two different
// layers, and they are not the same key:
//   - **Wire-level**: `(mode, message_type)`. On the wire this is the only
//     available discriminator — `payload_type`/`media_type`/`content_type`
//     appear nowhere in `envelope.proto` or `macp-envelope.schema.json`, and
//     RFC-MACP-0001's media types identify the envelope *encoding*, not the
//     payload. A runtime or projection working from a live `Envelope` has no
//     other option.
//   - **Fixture-level**: `payload_type`. The canonical fixture schema
//     (`schemas/conformance/schema.json`, mirrored at
//     `tests/conformance/schema.json`) REQUIRES `payload_type` on every
//     message and constrains it to
//     `^(macp\.v1\.[A-Za-z]+|macp\.modes\.[a-z_]+\.v\d+\.[A-Za-z]+Payload)$`.
//     That alternation formally encodes the mixed mode-scoping rule this
//     predicate depends on — core payloads (`Signal`, `SessionStart`,
//     `SessionCancel`, `SessionSuspend`, `SessionResume`, `Commitment`) are
//     `macp.v1.*` and mode-independent; mode-defined payloads
//     (`Vote`/`Approve`/`Reject`/`Abstain`/...) are `macp.modes.<mode>.*` and
//     mode-scoped — but it is encoded ONLY in that JSON Schema pattern, in no
//     RFC prose. A spec clarification making the mode-scoping rule explicit
//     in prose is queued upstream; until it lands, this comment is the
//     citable source for that rule, not an RFC section.
//
// This predicate operates on fixture messages (not live envelopes), so it
// deliberately uses the STRONGER fixture-level key, `payload_type`, rather
// than reconstructing `(mode, message_type)` — it is unambiguous by
// construction, schema-enforced on every fixture, and sidesteps the `Reject`
// collision entirely rather than working around it after the fact.
const DECISION_PAYLOAD_PREFIX = 'macp.modes.decision.v1.';
const QUORUM_PAYLOAD_PREFIX = 'macp.modes.quorum.v1.';

/**
 * Find every (sender, subject) pair that received more than one *accepted*
 * `Vote` (Decision — keyed on sender + `proposal_id`) or ballot (Quorum
 * `Approve`/`Reject`/`Abstain` — keyed on sender + `request_id`, collapsed
 * ACROSS the three types: RFC-MACP-0011 §5 rule 3's cap is "at most one
 * ballot across Approve, Reject, or Abstain", so a later ballot of a
 * *different* type from the same sender for the same request is still a
 * duplicate, not a distinct record).
 *
 * Scoped to `expect === 'accept'` deliberately, with the reason stated where
 * it matters: a *rejected* duplicate is exactly the missing upstream fixture
 * this SDK has requested from the spec repo (a fixture with
 * `"expect": "reject"` / `"expected_error_code": "INVALID_ENVELOPE"` for a
 * duplicate Vote/ballot) — this guard must welcome that fixture landing, not
 * treat it as a violation.
 */
export function duplicateAcceptedBallots(
  messages: readonly DuplicateBallotCandidateMessage[],
): DuplicateAcceptedBallot[] {
  const seen = new Set<string>();
  const duplicates: DuplicateAcceptedBallot[] = [];

  for (const msg of messages) {
    // Only accepted history is ever held by a conforming runtime — see the
    // module docblock. A rejected message never reaches this predicate's
    // notion of "duplicate".
    if (msg.expect !== 'accept') continue;

    let bucket: 'vote' | 'ballot';
    let id: unknown;
    if (msg.message_type === 'Vote' && msg.payload_type.startsWith(DECISION_PAYLOAD_PREFIX)) {
      bucket = 'vote';
      id = msg.payload.proposal_id;
    } else if (BALLOT_MESSAGE_TYPES.has(msg.message_type) && msg.payload_type.startsWith(QUORUM_PAYLOAD_PREFIX)) {
      bucket = 'ballot';
      id = msg.payload.request_id;
    } else {
      continue;
    }

    const idString = typeof id === 'string' ? id : String(id);
    const key = `${bucket}:${msg.sender}:${idString}`;
    if (seen.has(key)) {
      duplicates.push({ sender: msg.sender, id: idString, messageType: msg.message_type });
      continue;
    }
    seen.add(key);
  }

  return duplicates;
}
