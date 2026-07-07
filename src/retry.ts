import type { AuthConfig } from './auth';
import type { MacpClient } from './client';
import { MacpAckError, MacpRetryError, MacpTransportError } from './errors';
import type { Ack, Envelope } from './types';

export interface RetryPolicy {
  maxRetries: number;
  backoffBase: number;
  backoffMax: number;
  /**
   * Retryable **ack** (NACK) codes — MACP application-level error codes on a
   * `Send` response (e.g. `RATE_LIMITED`, `INTERNAL_ERROR`). This is distinct
   * from a gRPC **stream** status such as `RESOURCE_EXHAUSTED` (watch-stream
   * consumer lag), which is not an ack code and is not handled here — reconnect
   * the stream instead (see the watcher classes' reconnect JSDoc).
   */
  retryableCodes: Set<string>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffBase: 0.1,
  backoffMax: 2.0,
  retryableCodes: new Set(['RATE_LIMITED', 'INTERNAL_ERROR']),
};

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function retrySend(
  client: MacpClient,
  envelope: Envelope,
  options?: { policy?: Partial<RetryPolicy>; auth?: AuthConfig },
): Promise<Ack> {
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...options?.policy,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await client.send(envelope, { auth: options?.auth, raiseOnNack: true });
    } catch (err) {
      if (err instanceof MacpTransportError) {
        lastError = err;
      } else if (err instanceof MacpAckError) {
        if (!policy.retryableCodes.has(err.ack.error?.code ?? '')) {
          throw err;
        }
        lastError = err;
      } else {
        throw err;
      }
    }

    if (attempt < policy.maxRetries) {
      const delay = Math.min(policy.backoffBase * 2 ** attempt, policy.backoffMax);
      await sleep(delay);
    }
  }

  const error = new MacpRetryError(`retries exhausted after ${policy.maxRetries} attempts`);
  if (lastError) error.cause = lastError;
  throw error;
}
