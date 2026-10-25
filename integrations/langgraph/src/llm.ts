/**
 * `llmEvaluator`: an EvaluationStrategy backed by any LangChain chat model.
 * The model is asked for `{recommendation, confidence, reason}` as JSON; an
 * answer that doesn't parse becomes a REVIEW with confidence 0 rather than
 * failing the session.
 */

import type { BaseMessageLike } from '@langchain/core/messages';
import type { agent } from 'macp-sdk-typescript';
import type { EvaluationResult, EvaluationStrategy } from './consensus';

/** The part of a LangChain chat model the evaluator calls. */
export interface ChatModelLike {
  invoke(input: BaseMessageLike[]): Promise<{ content: unknown }>;
}

export const DEFAULT_EVALUATOR_PROMPT =
  'You are one participant in a multi-agent decision. Evaluate the proposal you are given. ' +
  'Answer with only a JSON object: {"recommendation": "APPROVE" | "REVIEW" | "BLOCK" | "REJECT", ' +
  '"confidence": <number between 0 and 1>, "reason": "<one sentence>"}.';

export const UNPARSEABLE: EvaluationResult = {
  recommendation: 'REVIEW',
  confidence: 0,
  reason: 'unparseable model output',
};

const RECOMMENDATIONS = new Set(['APPROVE', 'REVIEW', 'BLOCK', 'REJECT']);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: unknown })?.text ?? '')))
      .filter((t): t is string => typeof t === 'string')
      .join('');
  }
  return '';
}

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
 * Wraps a chat model as an EvaluationStrategy. The model sees the system
 * prompt and the proposal as JSON. A model call that throws (network, auth)
 * propagates and fails the run; only an unparseable answer is absorbed.
 */
export function llmEvaluator(model: ChatModelLike, options: { systemPrompt?: string } = {}): EvaluationStrategy {
  const systemPrompt = options.systemPrompt ?? DEFAULT_EVALUATOR_PROMPT;
  return {
    async evaluate(proposal: Record<string, unknown>, _session: agent.SessionInfo): Promise<EvaluationResult> {
      const answer = await model.invoke([
        ['system', systemPrompt],
        ['human', JSON.stringify(proposal)],
      ]);
      return parseEvaluation(textOf(answer.content));
    },
  };
}
