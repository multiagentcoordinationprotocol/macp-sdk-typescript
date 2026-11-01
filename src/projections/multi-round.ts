import { MODE_MULTI_ROUND } from '../constants';
import { logger } from '../logging';
import { parseContributeValue } from '../multi-round-contribute';
import { BaseProjection } from './base';
import type { Envelope } from '../types';
import type { ProtoRegistry } from '../proto-registry';

export interface MultiRoundProjectionOptions {
  /** Seed the declared participants, for a projection that never sees the SessionStart. */
  participants?: string[];
  /** Seed the session initiator, likewise. */
  initiator?: string;
}

/**
 * Client-side state of an `ext.multi_round.v1` session, mirroring what
 * macp-runtime's mode keeps (spec #241, `multi_round.proto`'s semantics
 * block). Parity with python-sdk `macp_sdk.projections.MultiRoundProjection`.
 *
 * Advisory only: the runtime decides convergence. The projection follows the
 * same rules:
 * - a sender's first `Contribute`, or one whose value differs from the
 *   sender's previous one, advances `round` by one;
 * - re-sending an unchanged value changes nothing;
 * - the session converges (`all_equal`) once every declared participant has
 *   contributed and all of their latest values are equal;
 * - convergence is sticky, so a later `Contribute` is a no-op.
 *
 * Like the other projections, it expects accepted envelopes only (see
 * `BaseProjection.applyEnvelope`). A hand-fed transcript can still carry what
 * the runtime would never have stored, so these are no-ops (they stay in
 * `transcript` but change no state):
 * - a `Contribute` from a sender who isn't a declared participant, once the
 *   participants are known;
 * - a `Contribute` the runtime would refuse: a zero-byte payload, or bytes
 *   that neither its JSON nor its protobuf reading accepts;
 * - any `Contribute` after convergence.
 *
 * Convergence is evaluated only once the participants are known, either from
 * the accepted SessionStart or from the constructor options. A later
 * SessionStart overwrites both seeded values.
 *
 * A `Contribute` value is read exactly as macp-runtime's
 * `parse_contribute_value` reads it at `semantics_rev` 3: legacy JSON
 * (serde's `{"value": <string>}`) unless the bytes are also canonical
 * protobuf, otherwise protobuf. Bytes that are a value only to a lenient
 * decoder count as nothing, so hostile payloads project what the runtime
 * stored. One limitation: a session the runtime recorded before
 * `semantics_rev` 3 read some legacy-JSON-looking protobuf values (byte
 * lengths such as 13, 32 and 123) as JSON, and the projection can't see
 * `semantics_rev`.
 */
export class MultiRoundProjection extends BaseProjection {
  protected readonly mode = MODE_MULTI_ROUND;
  participants: string[];
  initiator: string | undefined;
  /** Each participant's latest contributed value, in first-contribution order. */
  readonly contributions = new Map<string, string>();
  round = 0;
  converged = false;
  /** The common value once converged; `undefined` before. */
  convergedValue: string | undefined = undefined;
  phase: 'Pending' | 'Contributing' | 'Converged' | 'Committed' = 'Pending';

  constructor(options: MultiRoundProjectionOptions = {}) {
    super();
    this.participants = [...(options.participants ?? [])];
    this.initiator = options.initiator;
  }

  /** Declared participants who haven't contributed yet. */
  pendingParticipants(): string[] {
    return this.participants.filter((p) => !this.contributions.has(p));
  }

  /** Handle a multi_round envelope. See `BaseProjection.applyEnvelope` for the accepted-only contract and redelivery/rollback semantics. */
  protected applyMode(envelope: Envelope, protoRegistry: ProtoRegistry): void {
    switch (envelope.messageType) {
      case 'SessionStart': {
        const payload = protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload) as {
          participants?: string[];
        };
        this.participants = [...(payload.participants ?? [])];
        // An empty sender (bearer auth with no sender hint) is filled in only on
        // the runtime's copy, so it doesn't overwrite a known initiator.
        this.initiator = envelope.sender || this.initiator;
        if (!this.converged) this.setPhase('Contributing');
        break;
      }
      case 'Contribute':
        this.applyContribute(envelope);
        break;
      default:
        break;
    }
  }

  private applyContribute(envelope: Envelope): void {
    if (this.converged) return ignored(envelope, 'session already converged');
    if (this.participants.length > 0 && !this.participants.includes(envelope.sender)) {
      return ignored(envelope, 'sender is not a declared participant');
    }
    // The runtime's own reading of the bytes, not ProtoRegistry's more lenient one.
    const value = parseContributeValue(envelope.payload);
    // '' is a real value here: the runtime refuses only a zero-byte payload, and
    // stores '' from one such as `0a00` or `{"value":""}`.
    if (value === undefined) return ignored(envelope, 'payload has no value the runtime would store');

    if (this.contributions.get(envelope.sender) !== value) {
      this.round += 1;
      this.contributions.set(envelope.sender, value);
    }
    this.checkConvergence();
  }

  private checkConvergence(): void {
    if (this.converged || this.participants.length === 0) return;
    const values = this.participants.map((p) => this.contributions.get(p));
    if (values.some((v) => v === undefined) || values.some((v) => v !== values[0])) return;
    this.converged = true;
    this.convergedValue = values[0];
    this.setPhase('Converged');
  }
}

function ignored(envelope: Envelope, why: string): void {
  logger.debug('multi_round Contribute ignored', { messageId: envelope.messageId, sender: envelope.sender, why });
}
