import * as grpc from '@grpc/grpc-js';
import { MacpIdentityMismatchError } from './errors';

export interface AuthConfig {
  bearerToken?: string;
  senderHint?: string;
  /**
   * The authenticated sender this credential represents. When present, the SDK
   * refuses to emit an envelope whose `sender` differs from this value
   * (RFC-MACP-0004 §4). Leave undefined for legacy/dev flows that want to
   * retain the pre-0.2 permissive behavior.
   */
  expectedSender?: string;
}

/**
 * Optional second argument to {@link Auth.bearer}. Accepts either a bare
 * `senderHint` string (legacy) or a structured object that can also declare
 * the authenticated identity via `expectedSender`.
 */
export type BearerAuthOptions =
  | string
  | {
      expectedSender?: string;
      senderHint?: string;
    };

export const Auth = {
  /**
   * Dev-mode agent identity (bearer-only, runtime ≥ 0.5.0). Sends
   * `Authorization: Bearer <agentId>`; the runtime's dev fallback authenticates
   * any bearer value as the sender of that value, so `Auth.devAgent('alice')`
   * authenticates as sender `alice`. Requires the runtime to be started with
   * `MACP_ALLOW_INSECURE=1` (it refuses to start with no auth configured
   * otherwise). Not for production — use {@link Auth.bearer}.
   *
   * The legacy `x-macp-agent-id` header was removed in 0.5.0: no supported
   * runtime reads it. Does not set {@link AuthConfig.expectedSender}; dev flows
   * stay permissive so tests can reuse a single credential across senders.
   */
  devAgent(agentId: string): AuthConfig {
    return { bearerToken: agentId, senderHint: agentId };
  },
  /**
   * Production bearer-token credential. Pass `{ expectedSender }` to have the
   * SDK refuse to emit envelopes whose `sender` differs from the authenticated
   * identity (RFC-MACP-0004 §4).
   *
   * ```ts
   * Auth.bearer('tok')                               // legacy; no identity guard
   * Auth.bearer('tok', 'alice')                      // legacy; alice is senderHint only
   * Auth.bearer('tok', { expectedSender: 'alice' })  // strict; SDK enforces sender=='alice'
   * ```
   */
  bearer(token: string, options?: BearerAuthOptions): AuthConfig {
    if (options === undefined) return { bearerToken: token };
    if (typeof options === 'string') return { bearerToken: token, senderHint: options };
    const { expectedSender, senderHint } = options;
    return {
      bearerToken: token,
      expectedSender,
      senderHint: senderHint ?? expectedSender,
    };
  },
};

export function validateAuth(auth: AuthConfig): void {
  if (!auth.bearerToken) {
    throw new Error('bearerToken is required');
  }
}

export function authSender(auth?: AuthConfig): string | undefined {
  if (!auth) return undefined;
  return auth.expectedSender ?? auth.senderHint;
}

/**
 * Throw {@link MacpIdentityMismatchError} when a caller-supplied `sender`
 * conflicts with `auth.expectedSender`. Silent when either is undefined, so
 * dev credentials and legacy bearer usage retain pre-0.2 behavior.
 */
export function assertSenderMatchesIdentity(auth: AuthConfig | undefined, sender: string | undefined): void {
  if (!auth?.expectedSender) return;
  if (sender === undefined) return;
  if (sender !== auth.expectedSender) {
    throw new MacpIdentityMismatchError(auth.expectedSender, sender);
  }
}

export function metadataFromAuth(auth: AuthConfig): grpc.Metadata {
  validateAuth(auth);
  const metadata = new grpc.Metadata();
  metadata.set('authorization', `Bearer ${auth.bearerToken}`);
  return metadata;
}
