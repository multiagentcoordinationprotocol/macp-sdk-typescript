import { logger } from '../logging';
import type { ProtoRegistry } from '../proto-registry';
import type { Envelope } from '../types';

/**
 * The kind of cardinality anomaly a projection recorded while replaying an
 * accepted transcript. Cross-SDK frozen contract (`macp-sdk-python` adopted
 * the identical field set, snake_case there) — do not add a kind without
 * cross-SDK agreement.
 */
export type ProjectionAnomalyKind = 'duplicate_vote' | 'duplicate_ballot';

/**
 * A recorded observation that a second distinct `Vote` from this sender for
 * this proposal (RFC-MACP-0007 §5.3), or a second distinct ballot across
 * `Approve`/`Reject`/`Abstain` from this sender for this request
 * (RFC-MACP-0011 §5 rule 3), was observed and discarded — the first stands.
 * (RFC-MACP-0011 §5 rule 3 caps *how many* ballots and is silent on *which of
 * two* stands; first-ballot-wins here is parity with RFC-MACP-0007 §5.3 plus
 * runtime-enforced behaviour.)
 *
 * **Deliberately narrow claim — do not overclaim "this transcript violates
 * the spec".** A projection cannot tell a genuinely non-conforming source
 * from a conforming source fed through an unfiltered loader, because
 * acceptance is not a wire property (`Envelope` carries no acceptance
 * marker — see `applyEnvelope`'s "Input contract: accepted-only" docblock).
 * An anomaly records only what was observed and what this projection did
 * about it (discarded the second one, kept the first); it does not, and
 * structurally cannot, assert that a conforming runtime was actually
 * bypassed. Both `macp-sdk-python` and this SDK state it in these terms —
 * agreed cross-SDK wording, not a style preference.
 *
 * Cross-SDK frozen contract, seven fields (camelCase here, snake_case in
 * `macp-sdk-python`). Do not add, rename, or remove a field without
 * cross-SDK agreement.
 *
 * Only `DecisionProjection` and `QuorumProjection` populate this today.
 */
export interface ProjectionAnomaly {
  kind: ProjectionAnomalyKind;
  mode: string;
  messageType: string;
  messageId: string;
  sender: string;
  /** `proposal_id` (Decision) or `request_id` (Quorum) the duplicate targeted. */
  subjectId: string;
  /**
   * Human-readable detail. For a cross-type Quorum duplicate, `messageType`
   * is what distinguishes the discarded ballot's type (Approve/Reject/Abstain)
   * from the kept one — `detail` should name both.
   */
  detail: string;
}

/**
 * The exact `ProjectionAnomaly` member set this alias guards against drift.
 * Expressed as a type rather than a runtime array because there is no
 * runtime field list to compare it against — parity with
 * `commitment-hash.ts`'s `HashedCommitmentField` (issue #47).
 */
type FrozenProjectionAnomalyField = 'kind' | 'mode' | 'messageType' | 'messageId' | 'sender' | 'subjectId' | 'detail';

/** Fails to instantiate — a `tsc` error — for any `T` that is not `never`. */
type AssertNever<T extends never> = T;

/**
 * Compile-time frozen-field-set guard for `ProjectionAnomaly` (same shape as
 * `commitment-hash.ts`'s `_CommitmentFieldSetIsFrozen`, issue #47).
 *
 * `ProjectionAnomaly` is a **cross-SDK frozen contract**, agreed with
 * `macp-sdk-python` (same seven fields, snake_case there). Nothing else in
 * this file enumerates the field set at compile time, so without this alias,
 * a field added to or removed from `ProjectionAnomaly` would compile clean
 * and silently drift the two SDKs apart — no `tsc` error, no runtime error,
 * just a wire shape the two implementations no longer agree on.
 *
 * Both directions are checked. A field ADDED to `ProjectionAnomaly` and not
 * listed in `FrozenProjectionAnomalyField` leaves the first `Exclude`
 * non-empty; a field REMOVED from `ProjectionAnomaly` while still listed
 * above leaves the second non-empty. Either way `AssertNever`'s `T extends
 * never` constraint fails and `npm run check` — and therefore CI — goes red
 * on this line.
 *
 * Intended workflow when this goes red: agree the field change with
 * `macp-sdk-python` first, then update `FrozenProjectionAnomalyField` to
 * match — never widen it alone just to make the error go away.
 *
 * Zero runtime cost: this is a type alias, erased at compile time. It is
 * intentionally never referenced, which is what the disable comment is for.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ProjectionAnomalyFieldSetIsFrozen = AssertNever<
  | Exclude<keyof ProjectionAnomaly, FrozenProjectionAnomalyField>
  | Exclude<FrozenProjectionAnomalyField, keyof ProjectionAnomaly>
>;

/**
 * Abstract base for in-process mode-state tracking — parity with python-sdk's
 * `macp_sdk.base_projection.BaseProjection`. Maintains a shared transcript,
 * phase string, and commitment payload; subclasses override `applyMode`
 * to handle mode-specific envelopes. `SessionStart` and `Commitment` are
 * handled here so custom modes get the common lifecycle for free.
 */
export abstract class BaseProjection {
  /**
   * The session's accepted history as a conforming runtime holds it: one
   * envelope per unique `message_id`, in application order. Redelivered
   * envelopes (same `message_id` — expected under MACP's at-least-once
   * delivery, RFC-MACP-0001 §8, and normatively idempotent per RFC-MACP-0006
   * §3.2 Redelivery) and envelopes for other modes are not appended; a
   * redelivery is logged at debug level and has no effect on projection
   * state.
   */
  readonly transcript: Envelope[] = [];
  phase: string = '';
  commitment?: Record<string, unknown>;

  /**
   * `message_id`s already applied to this projection, used to make
   * `applyEnvelope` idempotent under redelivery (RFC-MACP-0006 §3.2:
   * "A consumer that accumulates state per envelope ... MUST be idempotent
   * with respect to `message_id`", `:136`). Deliberately unbounded: this
   * class already retains every full envelope (payload bytes included) in
   * `transcript`, so a set of id strings is strictly dominated by that; the
   * runtime keeps an unbounded per-message dedup set itself
   * (`macp-runtime/crates/macp-modes/src/step.rs:48/:89`, field declared at
   * `crates/macp-core/src/session.rs:69`), and sessions are TTL-bounded by
   * protocol.
   */
  private readonly seenMessageIds = new Set<string>();

  /**
   * Cardinality anomalies recorded while replaying this projection's
   * accepted transcript (e.g. a duplicate vote or ballot from the same
   * sender). See `ProjectionAnomaly`. Empty unless a subclass calls
   * `recordAnomaly`. NOTE: as of this SDK's built-in modes, nothing calls
   * `recordAnomaly` — `DecisionProjection` and `QuorumProjection` do not
   * extend `BaseProjection` (see the class docblock) and inline their own
   * two lines instead. This field and `recordAnomaly` exist for ext-mode
   * `BaseProjection` subclasses outside this repo.
   */
  readonly anomalies: ProjectionAnomaly[] = [];

  protected abstract readonly mode: string;

  /**
   * True once at least one `ProjectionAnomaly` has been recorded — i.e. this
   * projection observed and discarded a duplicate vote or ballot from the
   * same sender (see `anomalies` above). This getter is exactly
   * `anomalies.length > 0`; it never asserts "this transcript violates the
   * spec" (see `ProjectionAnomaly`'s docblock, and `applyEnvelope`'s "Input
   * contract: accepted-only" section above, for why a projection cannot make
   * that claim).
   */
  get hasAnomalies(): boolean {
    return this.anomalies.length > 0;
  }

  get isCommitted(): boolean {
    return this.commitment !== undefined;
  }

  get isPositiveOutcome(): boolean | undefined {
    if (!this.commitment) return undefined;
    const val =
      (this.commitment as Record<string, unknown>).outcomePositive ??
      (this.commitment as Record<string, unknown>).outcome_positive;
    return val !== undefined ? Boolean(val) : true;
  }

  /**
   * Apply one envelope to this projection's in-process state.
   *
   * ## Input contract: accepted-only
   *
   * `applyEnvelope` assumes every envelope it is given was **accepted** by a
   * conforming MACP runtime — i.e. it is part of the session's authoritative
   * accepted history, never a submission the runtime rejected. This is a
   * **caller-maintained invariant**, not something this method can check:
   * `Envelope` (`src/types.ts`) carries no acceptance marker on the wire, so a
   * projection has no field to inspect to tell an accepted envelope from a
   * rejected one. Canonical source, verbatim: `schemas/conformance/README.md`
   * "Notes:" — "SDKs replay only `accept` messages through their projections
   * (reject-path fixtures replay their accepted *prefix*)." The rule this
   * supports is spelled out in RFC-MACP-0007 §5 rule 3 (this repo's shorthand:
   * "§5.3" — the RFC has no literal `### 5.3` heading) — "the first accepted
   * `Vote` stands" — and RFC-MACP-0011 §5 rule 3 — at most one ballot per
   * participant. Both describe what a conforming runtime enforces on ACCEPTED
   * history; a projection reconstructing that history is only correct when fed
   * the same set the runtime held.
   *
   * This SDK's own send paths uphold the invariant already: each of the five
   * built-in mode sessions has its own private `sendAndTrack` that calls
   * `this.projection.applyEnvelope(...)` only `if (ack.ok)`. `BaseSession`'s
   * own `sendAndTrack` (`src/base-session.ts`) — the equivalent path for
   * custom modes built on the ext-mode extension point — does the same. The
   * conformance harness upholds it too: its `acceptedMessages` filter in
   * `tests/conformance/conformance.test.ts` keeps only messages with
   * `expect === 'accept'` before replay.
   *
   * **Failure mode if the contract is violated:** wiring this method to raw
   * captured or hand-built traffic — including envelopes a runtime rejected —
   * replays a timeline that no conforming runtime ever held, fabricating
   * projection state. Concretely: a session whose only `Commitment` was
   * rejected can still end up with `isCommitted === true` and
   * `phase === 'Committed'` if that rejected envelope is replayed anyway. See
   * `tests/unit/projections/accepted-only-contract.test.ts` for an executable
   * demonstration, both with the corruption present and with it avoided.
   *
   * @param envelope - MUST be an envelope the runtime accepted; the caller is
   * responsible for filtering out rejected submissions before calling this
   * method. Envelopes for a different `mode` are ignored (the `if
   * (envelope.mode !== this.mode) return;` guard below, in this method's own
   * body), but that check is unrelated to this contract and does not
   * substitute for it.
   */
  applyEnvelope(envelope: Envelope, protoRegistry: ProtoRegistry): void {
    if (envelope.mode !== this.mode) return;

    // RFC-MACP-0006 §3.2 Redelivery (`:94`, `:134`-`:136`): a runtime MAY echo
    // back accepted envelopes, a redelivery MUST NOT advance sequence position
    // or count a second time against cardinality, and a consumer that
    // accumulates state per envelope MUST be idempotent w.r.t. `message_id`.
    // The `if (envelope.messageId)` guard is mandatory: an empty/absent id
    // must apply WITHOUT dedup, or a feed of empty-id envelopes collapses to
    // one. This is architecturally expected (RFC-MACP-0001:306 at-least-once
    // delivery), not an anomaly — hence `debug`, never `warn`.
    if (envelope.messageId) {
      if (this.seenMessageIds.has(envelope.messageId)) {
        logger.debug('projection redelivery ignored', {
          messageId: envelope.messageId,
          mode: envelope.mode,
          messageType: envelope.messageType,
        });
        return;
      }
      this.seenMessageIds.add(envelope.messageId);
    }

    this.transcript.push(envelope);

    if (envelope.messageType === 'Commitment') {
      this.commitment = protoRegistry.decodeKnownPayload(
        envelope.mode,
        envelope.messageType,
        envelope.payload,
      ) as Record<string, unknown>;
      this.phase = 'Committed';
      return;
    }

    this.applyMode(envelope, protoRegistry);
  }

  /** Handle a mode-specific (non-Commitment) envelope. */
  protected abstract applyMode(envelope: Envelope, protoRegistry: ProtoRegistry): void;

  /**
   * Record a cardinality anomaly: push it onto `anomalies` and emit it via
   * `logger.warn('projection anomaly', anomaly)`. The `anomalies` array is
   * the canonical, cross-SDK-agreed semantic; the log call is explicitly
   * NON-contractual observability and may differ per SDK. `logger.warn` is
   * visible by default (this SDK's default log level is `warn`,
   * `src/logging.ts`) — observing and discarding a duplicate is deliberately
   * not silent. To quiet it without losing the `anomalies` array, configure a
   * higher level: `configureLogging({ level: 'error' })` or the
   * `MACP_LOG_LEVEL` environment variable.
   */
  protected recordAnomaly(anomaly: ProjectionAnomaly): void {
    this.anomalies.push(anomaly);
    logger.warn('projection anomaly', anomaly);
  }
}
