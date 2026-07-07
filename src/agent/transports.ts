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

  constructor(
    private readonly client: MacpClient,
    private readonly sessionId: string,
    private readonly auth?: AuthConfig,
  ) {}

  /**
   * The server passive-subscribe ordinal of the last delivered envelope (the
   * 1-based count of accepted envelopes delivered on this stream, RFC-MACP-0006
   * §3.2). `0` before anything is delivered. Pass this as `afterSequence` to
   * `MacpStream.sendSubscribe` on a reconnect to resume exactly-once — ordinals
   * are stable across compaction/restart. Distinct from `IncomingMessage.seq`,
   * which is a client-local 0-based delivery index.
   */
  get lastSequence(): number {
    return this.delivered;
  }

  async *start(): AsyncIterable<IncomingMessage> {
    this.stream = this.client.openStream({ auth: this.auth });

    // RFC-MACP-0006-A1: Subscribe to the session with history replay.
    // The runtime replays accepted envelopes then switches to live broadcast.
    // This ensures non-initiator agents receive the SessionStart + Proposal
    // regardless of spawn order or connection timing.
    await this.stream.sendSubscribe(this.sessionId);

    for await (const envelope of this.stream.responses()) {
      if (envelope.sessionId !== this.sessionId) continue;
      this.delivered++;
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
            yield {
              messageType: (item.message_type as string) ?? (item.messageType as string) ?? '',
              sender: (item.sender as string) ?? '',
              payload:
                typeof item.payload === 'object' && item.payload !== null
                  ? (item.payload as Record<string, unknown>)
                  : this.tryParsePayload(item.payload as Buffer | Uint8Array | string),
              proposalId: (item.proposal_id as string) ?? (item.proposalId as string),
              raw: item as unknown as Envelope,
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
