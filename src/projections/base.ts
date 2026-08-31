import { logger } from '../logging';
import type { ProtoRegistry } from '../proto-registry';
import type { Envelope } from '../types';

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

  protected abstract readonly mode: string;

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
}
