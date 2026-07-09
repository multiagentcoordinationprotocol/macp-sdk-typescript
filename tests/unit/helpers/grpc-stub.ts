import type { MacpClient } from '../../../src/client';

export interface RecordedCall {
  request: unknown;
  /** Positional args between the request and the callback (metadata and/or {deadline}). */
  extras: unknown[];
}

/**
 * Stub a unary RPC on the private gRPC client behind a real `MacpClient`.
 *
 * `MacpClient.unary()` dispatches on four shapes depending on whether auth
 * metadata and a deadline are present — `(req, cb)`, `(req, metadata, cb)`,
 * `(req, {deadline}, cb)`, `(req, metadata, {deadline}, cb)`. The callback is
 * always the last function-typed argument, so this helper works for all four
 * and records everything between the request and the callback for assertions.
 *
 * Pass an `Error`-like `{ code, details, message }` object as `response` to
 * make the RPC fail; anything else resolves as the RPC response.
 */
export function stubUnary(
  client: MacpClient,
  name: string,
  response: unknown,
  options?: { fail?: boolean },
): RecordedCall[] {
  const grpcClient = (client as unknown as { client: Record<string, unknown> }).client;
  const calls: RecordedCall[] = [];
  grpcClient[name] = (...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: unknown, res?: unknown) => void;
    calls.push({ request: args[0], extras: args.slice(1, -1) });
    if (options?.fail) callback(response);
    else callback(null, response);
  };
  return calls;
}
