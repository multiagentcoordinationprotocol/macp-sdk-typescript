import { buildReceipt, type DecisionReceipt, type ReceiptSigner } from 'macp-sdk-typescript/receipt';
import type { ConsensusResult } from './consensus.js';

/** Current time as RFC 3339 UTC at second precision, e.g. `2026-10-25T12:00:00Z`. */
export function nowIssuedAt(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The RFC-MACP-0013 Appendix A decision receipt for a consensus result, in one
 * call. Without a signer the receipt carries no attestation and verifies as
 * `integrity_only`.
 */
export function consensusReceipt(
  result: Pick<ConsensusResult, 'commitment' | 'sessionId' | 'mode'>,
  options: { issuer: string; issuedAt?: string; signer?: ReceiptSigner },
): DecisionReceipt {
  return buildReceipt(result.commitment, {
    sessionId: result.sessionId,
    mode: result.mode,
    issuer: options.issuer,
    issuedAt: options.issuedAt ?? nowIssuedAt(),
    signer: options.signer,
  });
}
