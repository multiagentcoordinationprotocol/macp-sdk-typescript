/**
 * Validating an evaluator's answer. The same rules as the LangGraph adapter's
 * `parseEvaluation`: an answer that doesn't validate becomes a REVIEW with
 * confidence 0 rather than failing the session.
 */

import type { EvaluationResult } from './consensus.js';

export const UNPARSEABLE: EvaluationResult = {
  recommendation: 'REVIEW',
  confidence: 0,
  reason: 'unparseable model output',
};

const RECOMMENDATIONS = new Set(['APPROVE', 'REVIEW', 'BLOCK', 'REJECT']);

/**
 * Parses a model answer into an EvaluationResult: strips a ```json fence,
 * uppercases the recommendation (ABSTAIN → REVIEW), requires a confidence in
 * [0, 1], and coerces the reason to a string. Anything else is {@link UNPARSEABLE}.
 */
export function parseEvaluation(text: string): EvaluationResult {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ...UNPARSEABLE };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...UNPARSEABLE };
  const { recommendation, confidence, reason } = parsed as Record<string, unknown>;
  if (typeof recommendation !== 'string') return { ...UNPARSEABLE };
  let rec = recommendation.trim().toUpperCase();
  if (rec === 'ABSTAIN') rec = 'REVIEW';
  if (!RECOMMENDATIONS.has(rec)) return { ...UNPARSEABLE };
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ...UNPARSEABLE };
  }
  return { recommendation: rec, confidence, reason: reason === undefined || reason === null ? '' : String(reason) };
}

/**
 * Validates an already-parsed answer (e.g. a structured output) the same way
 * {@link parseEvaluation} validates text; a string is parsed first.
 */
export function toEvaluation(answer: unknown): EvaluationResult {
  if (typeof answer === 'string') return parseEvaluation(answer);
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return { ...UNPARSEABLE };
  return parseEvaluation(JSON.stringify(answer));
}
