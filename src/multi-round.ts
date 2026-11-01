import type { AuthConfig } from './auth';
import type { MacpClient } from './client';
import { MODE_MULTI_ROUND, MULTI_ROUND_CONVERGED_ACTION, MULTI_ROUND_MODE_VERSION } from './constants';
import { buildContributePayload, buildEnvelope, inferOutcomePositive } from './envelope';
import { BaseSession, type BaseSessionOptions } from './base-session';
import { MacpSessionError } from './errors';
import { MultiRoundProjection } from './projections/multi-round';
import type { Ack, CommitmentRef, Root } from './types';

// The runtime's outcome-suffix rule (RFC-MACP-0001 §7.3), case-sensitive like
// macp-runtime's `validate_outcome_positive`. `multi_round.converged` matches
// neither list, so `outcomePositive` is unconstrained for it.
const NEGATIVE_SUFFIXES = ['rejected', 'failed', 'declined'];
const POSITIVE_SUFFIXES = ['selected', 'accepted', 'completed', 'approved'];

/**
 * Session helper for the `ext.multi_round.v1` iterative-convergence mode, a
 * runtime-shipped extension (spec #241). Parity with python-sdk
 * `macp_sdk.multi_round.MultiRoundSession`.
 *
 * Participants `contribute()` values until every declared participant's latest
 * value is equal. Convergence doesn't resolve the session: the initiator then
 * `commit()`s. This is client sugar only. The runtime decides, and the
 * session's governance policy is never evaluated for this mode.
 *
 * Methods throw {@link MacpSessionError} before sending what the runtime is
 * certain to refuse, judged from the projection: a contribution after
 * convergence or from a non-participant, and a commit from anyone but the
 * initiator. A commit before convergence is sent anyway, because the
 * projection's convergence is advisory and the runtime answers it with
 * INVALID_ENVELOPE.
 */
export class MultiRoundSession extends BaseSession<MultiRoundProjection> {
  protected readonly mode = MODE_MULTI_ROUND;

  constructor(client: MacpClient, options: BaseSessionOptions = {}) {
    super(client, { ...options, modeVersion: options.modeVersion ?? MULTI_ROUND_MODE_VERSION });
  }

  protected createProjection(): MultiRoundProjection {
    return new MultiRoundProjection();
  }

  /** Send SessionStart. The runtime accepts only `mode_version` `1.0.0` for this mode. */
  override start(input: {
    intent: string;
    participants: string[];
    ttlMs: number;
    maxSuspendMs?: number;
    contextId?: string;
    extensions?: Record<string, Buffer>;
    roots?: Root[];
    sender?: string;
    auth?: AuthConfig;
  }): Promise<Ack> {
    if (this.modeVersion !== MULTI_ROUND_MODE_VERSION) {
      return Promise.reject(
        new MacpSessionError(
          `${MODE_MULTI_ROUND} accepts only mode_version ${MULTI_ROUND_MODE_VERSION}, not ${JSON.stringify(this.modeVersion)}`,
        ),
      );
    }
    return super.start(input);
  }

  /** Contribute a value. A sender's first value, or a changed one, advances the round. */
  async contribute(input: { value: string; sender?: string; auth?: AuthConfig }): Promise<Ack> {
    if (typeof input.value !== 'string' || input.value === '') {
      // An empty value encodes to zero bytes, which the runtime rejects.
      throw new MacpSessionError('contribute: value must be a non-empty string');
    }
    if (this.projection.converged) {
      throw new MacpSessionError('contribute: the session has converged; the runtime rejects further contributions');
    }
    const sender = this.senderFor(input.sender, input.auth);
    const { participants } = this.projection;
    if (participants.length > 0 && !participants.includes(sender)) {
      throw new MacpSessionError(`contribute: ${JSON.stringify(sender)} is not a declared participant`);
    }
    const envelope = buildEnvelope({
      mode: this.mode,
      messageType: 'Contribute',
      sessionId: this.sessionId,
      sender,
      payload: this.client.protoRegistry.encodeKnownPayload(
        this.mode,
        'Contribute',
        buildContributePayload(input.value) as unknown as Record<string, unknown>,
      ),
    });
    return this.sendAndTrack(envelope, input.auth);
  }

  /**
   * Send the Commitment that resolves the session. Only the initiator may
   * commit. `action` defaults to `multi_round.converged`. `modeVersion`,
   * `configurationVersion` and `policyVersion` come from the session.
   */
  override async commit(input: {
    action?: string;
    authorityScope: string;
    reason: string;
    commitmentId?: string;
    outcomePositive?: boolean;
    supersedes?: CommitmentRef;
    sender?: string;
    auth?: AuthConfig;
  }): Promise<Ack> {
    const action = input.action ?? MULTI_ROUND_CONVERGED_ACTION;
    const blank = (value: unknown) => typeof value !== 'string' || value.trim() === '';
    for (const [name, value] of [
      ['action', action],
      ['authorityScope', input.authorityScope],
      ['reason', input.reason],
    ] as const) {
      if (blank(value)) throw new MacpSessionError(`commit: ${name} must be non-empty`);
    }
    if (input.commitmentId !== undefined && blank(input.commitmentId)) {
      throw new MacpSessionError('commit: commitmentId must be non-empty when given');
    }
    const outcomePositive = input.outcomePositive ?? inferOutcomePositive(action);
    if (NEGATIVE_SUFFIXES.some((s) => action.endsWith(s)) && outcomePositive) {
      throw new MacpSessionError(
        `commit: action ${JSON.stringify(action)} has a negative suffix but outcomePositive is true`,
      );
    }
    if (POSITIVE_SUFFIXES.some((s) => action.endsWith(s)) && !outcomePositive) {
      throw new MacpSessionError(
        `commit: action ${JSON.stringify(action)} has a positive suffix but outcomePositive is false`,
      );
    }
    if (input.supersedes !== undefined && input.supersedes !== null && blank(input.supersedes.sessionId)) {
      throw new MacpSessionError('commit: supersedes.sessionId must be non-empty');
    }
    const sender = this.senderFor(input.sender, input.auth);
    const { initiator } = this.projection;
    if (initiator !== undefined && sender !== initiator) {
      throw new MacpSessionError(`commit: only the initiator ${JSON.stringify(initiator)} may commit`);
    }
    // BaseSession.commit builds the payload (and validates the supersedes hash).
    return super.commit({ ...input, action, outcomePositive, sender });
  }
}
