import { vi } from 'vitest';
import { Auth, MacpClient, type Envelope } from 'macp-sdk-typescript';

export interface Sent {
  messageType: string;
  sender: string;
  payload: Record<string, unknown>;
}

/** A real MacpClient whose send/cancel never touch the network; records every envelope, decoded. */
export function fakeClient(options: { failOn?: string } = {}) {
  const client = new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.devAgent('coordinator'),
  });
  const sent: Sent[] = [];
  vi.spyOn(client, 'send').mockImplementation(async (envelope: Envelope) => {
    const payload =
      client.protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload as Buffer) ?? {};
    sent.push({ messageType: envelope.messageType, sender: envelope.sender, payload });
    if (options.failOn === envelope.messageType) throw new Error(`boom on ${envelope.messageType}`);
    return { ok: true } as never;
  });
  const cancel = vi.spyOn(client, 'cancelSession').mockResolvedValue({ ok: true } as never);
  return { client, sent, cancel };
}

export const fixed =
  (recommendation: string, confidence = 0.9, reason = `says ${recommendation}`) =>
  () => ({
    recommendation,
    confidence,
    reason,
  });
