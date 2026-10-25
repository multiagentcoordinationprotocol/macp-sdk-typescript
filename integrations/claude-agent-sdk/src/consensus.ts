/**
 * The MACP consensus run behind {@link macpConsensus} and the `consensus` MCP
 * tool: one session, opened
 * and committed by the initiator, in which every participant evaluates the
 * proposal through its EvaluationStrategy and then casts a ballot.
 *
 * Participants run in-process, each sending as its own MACP identity (its own
 * `auth`), so a graph gets a binding decision without hosting long-lived
 * agents. The initiator commits as soon as the outcome is settled: approved
 * once approvals reach the threshold, rejected once they no longer can.
 *
 * The same engine as @multiagentcoordinationprotocol/langgraph (kept as a copy
 * so neither adapter depends on the other's framework); change both together.
 */

import {
  Auth,
  DecisionSession,
  MODE_DECISION,
  MODE_QUORUM,
  MacpSdkError,
  QuorumSession,
  buildCommitmentPayload,
  commitmentHash,
  validateConfidence,
  validateRecommendation,
  validateVote,
  type AuthConfig,
  type CommitmentPayload,
  type MacpClient,
  type agent,
} from 'macp-sdk-typescript';

export type ConsensusMode = 'decision' | 'quorum';

/** What participants are asked to decide on. */
export interface ConsensusProposal {
  /** The option under decision; also the session intent. */
  option: string;
  rationale?: string;
  /** Free-form context, JSON-encoded into the Proposal / ApprovalRequest. */
  details?: Record<string, unknown>;
}

export type EvaluationResult = agent.EvaluationResult;
export type EvaluationStrategy = agent.EvaluationStrategy;
export type VotingStrategy = agent.VotingStrategy;

/** An EvaluationStrategy, or a plain (async) function with the same signature. */
export type Evaluator =
  | EvaluationStrategy
  | ((proposal: Record<string, unknown>, session: agent.SessionInfo) => Promise<EvaluationResult> | EvaluationResult);

export interface ConsensusParticipant {
  /** The participant's MACP agent id. */
  id: string;
  evaluator: Evaluator;
  /** Decision mode only. Default: vote the participant's own evaluation (see {@link ownEvaluationVoter}). */
  voter?: VotingStrategy;
  /** Credential the participant sends with. Default: `Auth.devAgent(id)` (dev runtimes only). */
  auth?: AuthConfig;
}

export interface ConsensusOptions {
  /** A client authenticated as the initiator, which opens and commits the session and never votes. */
  client: MacpClient;
  participants: ConsensusParticipant[];
  /** Default `'decision'`. */
  mode?: ConsensusMode;
  /** policy_version of a policy registered on the runtime. Default: the SDK's `policy.default`. */
  policy?: string;
  /** Approvals required. Default: a strict majority, `floor(n / 2) + 1`. */
  threshold?: number;
  /** Default 60000. */
  ttlMs?: number;
  /** Committed as `${action}.approved` or `${action}.rejected`. Default `'macp.consensus'`. */
  action?: string;
  /** The initiator's agent id. Default: the client credential's `expectedSender` / `senderHint`. */
  initiator?: string;
}

export interface ConsensusBallot {
  participant: string;
  /** APPROVE, REJECT or ABSTAIN. */
  vote: string;
  reason: string;
}

export interface ConsensusResult {
  outcome: 'approve' | 'reject';
  sessionId: string;
  /** RFC-MACP-0013 `sha256:<hex>` of {@link commitment}. */
  commitmentHash: string;
  /** Full mode name, e.g. `macp.mode.decision.v1`. */
  mode: string;
  /** The committed payload, exactly as sent; feeds `buildReceipt` / {@link consensusReceipt}. */
  commitment: CommitmentPayload;
  approvals: number;
  threshold: number;
  ballots: ConsensusBallot[];
}

export const CONSENSUS_AUTHORITY_SCOPE = 'macp.consensus';
const PROPOSAL_ID = 'p1';
const REQUEST_ID = 'r1';

/**
 * Normalizes an evaluator's recommendation to one the runtime accepts on an
 * Evaluation (APPROVE, REVIEW, BLOCK, REJECT; uppercased). ABSTAIN becomes
 * REVIEW; anything else throws.
 */
export function normalizeRecommendation(recommendation: string): string {
  if (typeof recommendation === 'string' && recommendation.toUpperCase() === 'ABSTAIN') return 'REVIEW';
  return validateRecommendation(String(recommendation));
}

/** Maps a recommendation to a ballot: APPROVE → APPROVE, REVIEW/ABSTAIN → ABSTAIN, REJECT/BLOCK → REJECT. */
export function ballotFor(recommendation: string): 'APPROVE' | 'REJECT' | 'ABSTAIN' {
  const r = normalizeRecommendation(recommendation);
  if (r === 'APPROVE') return 'APPROVE';
  if (r === 'REVIEW') return 'ABSTAIN';
  return 'REJECT';
}

/** The default Decision voter: the participant votes its own evaluation of the proposal. */
export function ownEvaluationVoter(participantId: string): VotingStrategy {
  const own = (projection: Parameters<VotingStrategy['decideVote']>[0]) =>
    projection.evaluations.filter((e) => e.sender === participantId).at(-1);
  return {
    shouldVote: (projection) => own(projection) !== undefined,
    async decideVote(projection) {
      const evaluation = own(projection)!;
      return { vote: ballotFor(evaluation.recommendation), reason: evaluation.reason ?? '' };
    },
  };
}

function evaluateWith(
  evaluator: Evaluator,
  proposal: Record<string, unknown>,
  session: agent.SessionInfo,
): Promise<EvaluationResult> {
  return Promise.resolve(
    typeof evaluator === 'function' ? evaluator(proposal, session) : evaluator.evaluate(proposal, session),
  );
}

export interface ResolvedConsensus {
  initiator: string;
  mode: ConsensusMode;
  threshold: number;
}

/**
 * Checks the options without touching the network; throws TypeError on a
 * configuration that could never run. {@link macpConsensusServer} calls it
 * when the server is built, so a bad configuration fails before any agent runs.
 */
export function resolveConsensusOptions(options: ConsensusOptions): ResolvedConsensus {
  if (!options?.client) throw new TypeError('consensus needs a client');
  const initiator = options.initiator ?? options.client.auth?.expectedSender ?? options.client.auth?.senderHint;
  if (!initiator)
    throw new TypeError('consensus needs the initiator agent id: pass `initiator` or an identified client auth');
  const mode = options.mode ?? 'decision';
  if (mode !== 'decision' && mode !== 'quorum') throw new TypeError(`unknown consensus mode '${String(mode)}'`);
  const ids = (options.participants ?? []).map((p) => p?.id);
  if (ids.length === 0) throw new TypeError('consensus needs at least one participant');
  if (ids.some((id) => typeof id !== 'string' || id === ''))
    throw new TypeError('every participant needs a non-empty id');
  if (new Set(ids).size !== ids.length) throw new TypeError('consensus participant ids must be unique');
  if (ids.includes(initiator)) throw new TypeError(`the initiator '${initiator}' cannot also be a participant`);
  if (options.participants.some((p) => !p.evaluator)) throw new TypeError('every participant needs an evaluator');
  const threshold = options.threshold ?? Math.floor(ids.length / 2) + 1;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > ids.length) {
    throw new TypeError(`threshold must be an integer in 1..${ids.length}, got ${threshold}`);
  }
  return { initiator, mode, threshold };
}

function encodeDetails(details: Record<string, unknown> | undefined): Buffer | undefined {
  return details === undefined ? undefined : Buffer.from(JSON.stringify(details), 'utf8');
}

/** Run one consensus session to its commitment. */
export async function runConsensus(options: ConsensusOptions, proposal: ConsensusProposal): Promise<ConsensusResult> {
  if (typeof proposal?.option !== 'string' || proposal.option === '') {
    throw new MacpSdkError('the proposal needs a non-empty option');
  }
  const { initiator, mode, threshold } = resolveConsensusOptions(options);
  const participants = options.participants.map((p) => ({ ...p, auth: p.auth ?? Auth.devAgent(p.id) }));
  const ttlMs = options.ttlMs ?? 60_000;
  const action = options.action ?? 'macp.consensus';
  // Decision: the initiator proposes, and only declared participants may. Quorum: the
  // initiator only sends the ApprovalRequest and Commitment, so it stays off the roster.
  const ids = participants.map((p) => p.id);
  const roster = mode === 'decision' ? [initiator, ...ids] : ids;
  const session =
    mode === 'decision'
      ? new DecisionSession(options.client, { policyVersion: options.policy })
      : new QuorumSession(options.client, { policyVersion: options.policy });
  const info: agent.SessionInfo = {
    sessionId: session.sessionId,
    mode: mode === 'decision' ? MODE_DECISION : MODE_QUORUM,
    participants: roster,
    modeVersion: session.modeVersion,
    configurationVersion: session.configurationVersion,
    policyVersion: session.policyVersion,
  };
  // What evaluators see; the same keys as the Python adapters, camelCased.
  const subject: Record<string, unknown> = {
    proposalId: mode === 'decision' ? PROPOSAL_ID : REQUEST_ID,
    option: proposal.option,
    rationale: proposal.rationale ?? '',
    details: proposal.details ?? null,
    mode: info.mode,
  };

  await session.start({ intent: proposal.option, participants: roster, ttlMs });
  const ballots: ConsensusBallot[] = [];
  try {
    const settled = (): 'approve' | 'reject' | undefined => {
      const approvals = ballots.filter((b) => b.vote === 'APPROVE').length;
      if (approvals >= threshold) return 'approve';
      if (approvals + (participants.length - ballots.length) < threshold) return 'reject';
      return undefined;
    };

    if (session instanceof DecisionSession) {
      await session.propose({
        proposalId: PROPOSAL_ID,
        option: proposal.option,
        rationale: proposal.rationale ?? '',
        supportingData: encodeDetails(proposal.details),
      });
      // Every evaluation lands before the first vote (RFC-MACP-0007's two phases).
      for (const p of participants) {
        const result = await evaluateWith(p.evaluator, subject, info);
        validateConfidence(result.confidence);
        await session.evaluate({
          proposalId: PROPOSAL_ID,
          recommendation: normalizeRecommendation(result.recommendation),
          confidence: result.confidence,
          reason: result.reason,
          sender: p.id,
          auth: p.auth,
        });
      }
      for (const p of participants) {
        if (settled()) break;
        const voter = p.voter ?? ownEvaluationVoter(p.id);
        if (!voter.shouldVote(session.projection)) {
          ballots.push({ participant: p.id, vote: 'ABSTAIN', reason: 'declined to vote' });
          continue;
        }
        const { vote, reason } = await voter.decideVote(session.projection);
        const normalized = validateVote(vote);
        await session.vote({ proposalId: PROPOSAL_ID, vote: normalized, reason, sender: p.id, auth: p.auth });
        ballots.push({ participant: p.id, vote: normalized, reason });
      }
    } else {
      await session.requestApproval({
        requestId: REQUEST_ID,
        action: proposal.option,
        summary: proposal.rationale || proposal.option,
        details: encodeDetails(proposal.details),
        requiredApprovals: threshold,
      });
      for (const p of participants) {
        if (settled()) break;
        const result = await evaluateWith(p.evaluator, subject, info);
        validateConfidence(result.confidence);
        const vote = ballotFor(result.recommendation);
        const input = { requestId: REQUEST_ID, reason: result.reason, sender: p.id, auth: p.auth };
        if (vote === 'APPROVE') await session.approve(input);
        else if (vote === 'REJECT') await session.reject(input);
        else await session.abstain(input);
        ballots.push({ participant: p.id, vote, reason: result.reason });
      }
    }

    const outcome = settled() ?? 'reject';
    const approvals = ballots.filter((b) => b.vote === 'APPROVE').length;
    const commitment = buildCommitmentPayload({
      action: `${action}.${outcome === 'approve' ? 'approved' : 'rejected'}`,
      authorityScope: CONSENSUS_AUTHORITY_SCOPE,
      reason: `${approvals}/${participants.length} approvals (threshold ${threshold})`,
      outcomePositive: outcome === 'approve',
      modeVersion: session.modeVersion,
      configurationVersion: session.configurationVersion,
      policyVersion: session.policyVersion,
    });
    // Same commitmentId and fields, so the session encodes exactly `commitment`.
    await session.commit({
      action: commitment.action,
      authorityScope: commitment.authorityScope,
      reason: commitment.reason,
      commitmentId: commitment.commitmentId,
      outcomePositive: commitment.outcomePositive,
    });
    return {
      outcome,
      sessionId: session.sessionId,
      commitmentHash: commitmentHash(commitment),
      mode: info.mode,
      commitment,
      approvals,
      threshold,
      ballots,
    };
  } catch (err) {
    // Leave no session open behind a failed run; the original error is what matters.
    await session.cancel(`consensus failed: ${(err as Error)?.message ?? String(err)}`).catch(() => undefined);
    throw err;
  }
}
