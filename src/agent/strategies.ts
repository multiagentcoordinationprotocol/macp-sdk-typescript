import type { DecisionProjection } from '../projections/decision';
import { inferOutcomePositive } from '../envelope';
import { validateConfidence, validateRecommendation, validateVote } from '../validation';
import type { HandlerContext, IncomingMessage, MessageHandler, SessionInfo } from './types';

// ── Evaluation strategy ─────────────────────────────────────────────

export interface EvaluationResult {
  recommendation: string;
  confidence: number;
  reason: string;
}

export interface EvaluationStrategy {
  evaluate(proposal: Record<string, unknown>, context: SessionInfo): Promise<EvaluationResult>;
}

export function evaluationHandler(strategy: EvaluationStrategy): MessageHandler {
  return async (event: IncomingMessage, ctx: HandlerContext): Promise<void> => {
    if (event.messageType !== 'Proposal') return;

    const result = await strategy.evaluate(event.payload, ctx.session);
    // Issue #108.7/4g: validate the strategy's own output — reusing this
    // repo's own validators (they throw MacpSessionError, the documented
    // error contract) rather than porting Python's inline ValueError checks
    // — and dispatch the normalized value, so a bad strategy fails loudly at
    // the handler naming the strategy, not later from the session.
    const recommendation = validateRecommendation(result.recommendation);
    validateConfidence(result.confidence);
    if (ctx.actions.evaluate) {
      await ctx.actions.evaluate({
        proposalId: event.proposalId ?? (event.payload.proposalId as string) ?? (event.payload.proposal_id as string),
        recommendation,
        confidence: result.confidence,
        reason: result.reason,
      });
    }
  };
}

export function functionEvaluator(
  fn: (proposal: Record<string, unknown>, context: SessionInfo) => Promise<EvaluationResult>,
): EvaluationStrategy {
  return { evaluate: fn };
}

// ── Voting strategy ─────────────────────────────────────────────────

export interface VoteResult {
  vote: string;
  reason: string;
}

export interface VotingStrategy {
  shouldVote(projection: DecisionProjection): boolean;
  decideVote(projection: DecisionProjection): Promise<VoteResult>;
}

export function votingHandler(strategy: VotingStrategy): MessageHandler {
  return async (event: IncomingMessage, ctx: HandlerContext): Promise<void> => {
    if (event.messageType !== 'Evaluation') return;

    const projection = ctx.projection as unknown as DecisionProjection;
    if (!strategy.shouldVote(projection)) return;

    const result = await strategy.decideVote(projection);
    const vote = validateVote(result.vote);
    if (ctx.actions.vote) {
      const proposalId =
        event.proposalId ?? (event.payload.proposalId as string) ?? (event.payload.proposal_id as string);
      await ctx.actions.vote({
        proposalId,
        vote,
        reason: result.reason,
      });
    }
  };
}

export function functionVoter(
  shouldVote: (projection: DecisionProjection) => boolean,
  decideVote: (projection: DecisionProjection) => Promise<VoteResult>,
): VotingStrategy {
  return { shouldVote, decideVote };
}

export function majorityVoter(options?: { positiveThreshold?: number }): VotingStrategy {
  const threshold = options?.positiveThreshold ?? 0.5;
  return {
    shouldVote(projection: DecisionProjection): boolean {
      return projection.evaluations.length > 0;
    },
    async decideVote(projection: DecisionProjection): Promise<VoteResult> {
      const positive = projection.evaluations.filter((e) =>
        ['approve', 'accept', 'yes'].includes(e.recommendation.toLowerCase()),
      );
      const ratio = projection.evaluations.length > 0 ? positive.length / projection.evaluations.length : 0;
      if (ratio >= threshold) {
        return { vote: 'APPROVE', reason: `${positive.length}/${projection.evaluations.length} evaluations positive` };
      }
      return {
        vote: 'REJECT',
        reason: `Only ${positive.length}/${projection.evaluations.length} evaluations positive`,
      };
    },
  };
}

// ── Commitment strategy ─────────────────────────────────────────────

export interface CommitmentResult {
  action: string;
  authorityScope: string;
  reason: string;
  outcomePositive?: boolean;
}

export interface CommitmentStrategy {
  shouldCommit(projection: DecisionProjection): boolean;
  decideCommitment(projection: DecisionProjection): Promise<CommitmentResult>;
}

export function commitmentHandler(strategy: CommitmentStrategy): MessageHandler {
  return async (event: IncomingMessage, ctx: HandlerContext): Promise<void> => {
    if (event.messageType !== 'Vote') return;

    const projection = ctx.projection as unknown as DecisionProjection;
    if (!strategy.shouldCommit(projection)) return;

    const result = await strategy.decideCommitment(projection);
    if (ctx.actions.commit) {
      await ctx.actions.commit({
        action: result.action,
        authorityScope: result.authorityScope,
        reason: result.reason,
        outcomePositive: result.outcomePositive ?? inferOutcomePositive(result.action),
      });
    }
  };
}

export function functionCommitter(
  shouldCommit: (projection: DecisionProjection) => boolean,
  decideCommitment: (projection: DecisionProjection) => Promise<CommitmentResult>,
): CommitmentStrategy {
  return { shouldCommit, decideCommitment };
}

export function majorityCommitter(options?: {
  quorumSize?: number;
  action?: string;
  authorityScope?: string;
}): CommitmentStrategy {
  const quorum = options?.quorumSize ?? 1;
  const action = options?.action ?? 'commit';
  const authorityScope = options?.authorityScope ?? 'session';
  return {
    shouldCommit(projection: DecisionProjection): boolean {
      const totals = projection.voteTotals();
      const winner = projection.majorityWinner();
      if (!winner) return false;
      return (totals[winner] ?? 0) >= quorum;
    },
    async decideCommitment(projection: DecisionProjection): Promise<CommitmentResult> {
      const winner = projection.majorityWinner();
      const proposal = winner ? projection.proposals.get(winner) : undefined;
      return {
        action,
        authorityScope,
        reason: proposal ? `Majority selected: ${proposal.option}` : 'Majority reached',
        outcomePositive: inferOutcomePositive(action),
      };
    },
  };
}
