import type { AuthConfig } from '../auth';
import type { MacpClient, MacpStream } from '../client';
import type { Envelope } from '../types';
import type { IncomingMessage } from './types';

export interface TransportAdapter {
  start(): AsyncIterable<IncomingMessage>;
  stop(): Promise<void>;
}

function normalizeEnvelope(
  envelope: Envelope,
  decodePayload: (mode: string, messageType: string, payload: Buffer) => Record<string, unknown> | undefined,
  seq: number,
): IncomingMessage {
  const payload = decodePayload(envelope.mode, envelope.messageType, envelope.payload) ?? {};
  return {
    messageType: envelope.messageType,
    sender: envelope.sender,
    payload,
    proposalId: (payload as Record<string, string>).proposalId ?? (payload as Record<string, string>).proposal_id,
    raw: envelope,
    seq,
  };
}

export class GrpcTransportAdapter implements TransportAdapter {
  private stream: MacpStream | null = null;
  private seq = 0;
  private delivered = 0;

  /**
   * `message_id`s already counted into `delivered`, so the resume cursor
   * advances once per distinct accepted envelope rather than once per raw
   * delivery (RFC-MACP-0006 §3.2 Redelivery). Deliberately unbounded, for the
   * same reason `BaseProjection` leaves its own copy of this set unbounded
   * (`src/projections/base.ts:118-129`): this set is strictly dominated by
   * memory this SDK already commits to per session — a `Participant` using
   * this adapter also holds a `BaseProjection` with an identical
   * `message_id` set *plus* a full `transcript` of every envelope, payload
   * bytes included. The runtime keeps an unbounded per-session dedup set of
   * its own regardless of what any client does
   * (`macp-runtime/crates/macp-modes/src/step.rs:48/:89`, field declared at
   * `macp-runtime/crates/macp-core/src/session.rs:69`), and sessions are
   * TTL-bounded by protocol.
   */
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly client: MacpClient,
    private readonly sessionId: string,
    private readonly auth?: AuthConfig,
  ) {}

  /**
   * The server passive-subscribe ordinal of the last delivered envelope (the
   * 1-based count of *distinct* accepted envelopes delivered on this stream,
   * RFC-MACP-0006 §3.2). `0` before anything is delivered. `start()` passes
   * this value as `afterSequence` to `MacpStream.sendSubscribe` itself, so a
   * caller that `stop()`s and calls `start()` again (the only reachable
   * "reconnect" in this SDK — there is no built-in retry loop) resumes
   * rather than replays the whole session. Ordinals are stable across
   * compaction/restart. Counts distinct `message_id`s, never raw delivery
   * events: RFC-MACP-0006 §3.2 Redelivery requires that "a redelivery MUST
   * NOT advance the client's sequence position; only a distinct accepted
   * envelope does," and a client that counts raw deliveries "arrives at a
   * position ahead of the true one, and its next resume silently skips
   * history." Distinct from `IncomingMessage.seq`, which is a client-local
   * 0-based delivery index that advances on every delivery, redeliveries
   * included.
   */
  get lastSequence(): number {
    return this.delivered;
  }

  async *start(): AsyncIterable<IncomingMessage> {
    // A prior stream from an earlier start() (without an intervening stop())
    // must not keep feeding this adapter's counter — two live generators
    // would both advance `delivered` from two differently-positioned
    // replays. `MacpStream.close()` is `this.call.end()` (`src/client.ts:223-227`),
    // a write-side half-close — it does not itself force the server to stop
    // pushing. It is enough here because macp-runtime's StreamSession loop
    // reads the resulting end-of-request-stream as `StreamAction::ClientDone`,
    // whose arm drains any already-buffered envelopes once and then breaks,
    // ending that stream's response side too
    // (macp-runtime/src/server.rs:654-666). Close it before opening the new
    // one so re-entrant start() and stop()-then-start() behave identically.
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
    this.stream = this.client.openStream({ auth: this.auth });

    // RFC-MACP-0006 §3.2: subscribe to the session, resuming from this
    // adapter's own cursor. `this.delivered` is 0 before anything has been
    // delivered, by construction, and `afterSequence = 0` is normatively
    // "replay from the session's first accepted envelope" — so the first
    // subscribe and every later one (e.g. after stop()+start()) are the same
    // expression. There is no separate first-subscribe/reconnect branch to
    // keep in sync with the counter.
    await this.stream.sendSubscribe(this.sessionId, this.delivered);

    for await (const envelope of this.stream.responses()) {
      if (envelope.sessionId !== this.sessionId) continue;
      // RFC-MACP-0006 §3.2 Redelivery: a redelivery MUST NOT advance the
      // resume cursor, and a consumer that accumulates state per envelope
      // MUST be idempotent w.r.t. `message_id`. An empty/absent messageId
      // has no identity to dedup on and increments unconditionally — the
      // same carve-out the projection guard documents at
      // `src/projections/base.ts:224-227`, so the two dedup sites read the
      // same way. In practice the `else` below can never run against a
      // conformant runtime: `validate_envelope_shape` rejects any envelope
      // with an empty `message_id` as `InvalidEnvelope` before it can be
      // accepted (`macp-runtime/src/server.rs:118`), and RFC-MACP-0001 §8.2
      // makes `message_id` the runtime's dedup identity, so no accepted
      // envelope in any session history can carry one. The branch stays
      // anyway — it costs nothing and errs toward still counting the
      // envelope instead of silently dropping it if a non-conformant server
      // ever sends one.
      if (envelope.messageId) {
        if (!this.seenMessageIds.has(envelope.messageId)) {
          this.seenMessageIds.add(envelope.messageId);
          this.delivered++;
        }
      } else {
        this.delivered++;
      }
      yield normalizeEnvelope(
        envelope,
        (mode, mt, p) => this.client.protoRegistry.decodeKnownPayload(mode, mt, p),
        this.seq++,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }
}

export interface HttpPollingConfig {
  baseUrl: string;
  sessionId: string;
  participantId: string;
  pollIntervalMs: number;
  authToken?: string;
}

export class HttpTransportAdapter implements TransportAdapter {
  private stopped = false;
  private seq = 0;
  private lastSeq = -1;

  constructor(private readonly config: HttpPollingConfig) {}

  async *start(): AsyncIterable<IncomingMessage> {
    while (!this.stopped) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.config.authToken) {
          headers['Authorization'] = `Bearer ${this.config.authToken}`;
        }

        const url = `${this.config.baseUrl}/sessions/${this.config.sessionId}/events?after=${this.lastSeq}`;
        const response = await fetch(url, { headers });

        if (!response.ok) {
          await this.sleep(this.config.pollIntervalMs);
          continue;
        }

        const body = await response.json();

        // Accept both Python format (JSON array of items) and
        // TypeScript format ({ events: [{ envelope, seq }] }).
        if (Array.isArray(body)) {
          // Python-style: plain array of envelope-like objects
          for (const item of body as Array<Record<string, unknown>>) {
            const itemSeq = (item.seq as number) ?? this.lastSeq + 1;
            if (itemSeq > this.lastSeq) {
              this.lastSeq = itemSeq;
            }
            // Normalize message_id -> messageId before yielding: without
            // this, `raw` is the raw snake_case JSON straight off the wire,
            // so `raw.messageId` is `undefined` and the projection's
            // redelivery guard (`if (envelope.messageId)`,
            // `src/projections/base.ts`) short-circuits — every polled
            // envelope looks id-less and skips dedup entirely, leaving HTTP
            // polling silently unprotected against RFC-MACP-0006 §3.2
            // redelivery.
            const messageId = (item.message_id as string) ?? (item.messageId as string) ?? '';
            yield {
              messageType: (item.message_type as string) ?? (item.messageType as string) ?? '',
              sender: (item.sender as string) ?? '',
              payload:
                typeof item.payload === 'object' && item.payload !== null
                  ? (item.payload as Record<string, unknown>)
                  : this.tryParsePayload(item.payload as Buffer | Uint8Array | string),
              proposalId: (item.proposal_id as string) ?? (item.proposalId as string),
              raw: { ...item, messageId } as unknown as Envelope,
              seq: this.seq++,
            };
          }
        } else {
          // TypeScript-style: { events: [{ envelope, seq }] }
          const wrapped = body as { events?: Array<{ envelope: Envelope; seq: number }> };
          const events = wrapped.events ?? [];

          for (const event of events) {
            if (event.seq > this.lastSeq) {
              this.lastSeq = event.seq;
            }
            yield {
              messageType: event.envelope.messageType,
              sender: event.envelope.sender,
              payload: this.tryParsePayload(event.envelope.payload),
              raw: event.envelope,
              seq: this.seq++,
            };
          }
        }
      } catch {
        // Ignore errors, retry after interval
      }

      await this.sleep(this.config.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private tryParsePayload(payload: Buffer | Uint8Array | string): Record<string, unknown> {
    try {
      const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
