/**
 * The fraud domain from macp-playground's langgraph worker (graph.py /
 * mappers.py), shared by both examples: the transaction under review and the
 * deterministic scorer the playground falls back to without an API key.
 */

import type { EvaluationResult } from '../src';

export interface Transaction {
  id: string;
  amount: number;
  deviceTrust: number;
  chargebacks: number;
}

/** mappers.py `score_fraud`. */
export function scoreFraud(trust: number, chargebacks: number): EvaluationResult {
  if (trust < 0.08 || chargebacks >= 2) {
    return {
      recommendation: 'BLOCK',
      confidence: 0.94,
      reason: 'device trust is critically low for this account history',
    };
  }
  if (trust < 0.2 || chargebacks >= 1) {
    return {
      recommendation: 'REVIEW',
      confidence: 0.84,
      reason: 'device trust or chargeback history requires manual review',
    };
  }
  return {
    recommendation: 'APPROVE',
    confidence: 0.72,
    reason: 'fraud signals are within the acceptable range for this session',
  };
}

export const TRANSACTIONS: Record<string, Transaction> = {
  clean: { id: 'txn-1001', amount: 240, deviceTrust: 0.81, chargebacks: 0 },
  borderline: { id: 'txn-1002', amount: 1850, deviceTrust: 0.17, chargebacks: 0 },
  fraudulent: { id: 'txn-1003', amount: 4999, deviceTrust: 0.05, chargebacks: 3 },
};
