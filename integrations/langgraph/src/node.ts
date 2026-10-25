/**
 * `MacpConsensusNode`: a LangGraph node that turns a graph step into a binding
 * MACP decision. Add it like any other node; it reads the proposal from graph
 * state, runs one session to its commitment, and writes the result back under
 * `outputKey`.
 */

import { MacpSdkError } from 'macp-sdk-typescript';
import {
  resolveConsensusOptions,
  runConsensus,
  type ConsensusOptions,
  type ConsensusProposal,
  type ConsensusResult,
} from './consensus';

export interface MacpConsensusNodeOptions<S = Record<string, unknown>> extends ConsensusOptions {
  /**
   * Reads the proposal from graph state. Default: `state.proposal`, either an
   * option string or a {@link ConsensusProposal}.
   */
  proposal?: (state: S) => ConsensusProposal | string;
  /** State key the {@link ConsensusResult} is written to. Default `'macp'`. */
  outputKey?: string;
}

function defaultProposal(state: unknown): ConsensusProposal | string {
  const value = (state as Record<string, unknown> | undefined)?.proposal;
  if (value === undefined) throw new MacpSdkError("graph state has no 'proposal'; pass a `proposal` reader");
  return value as ConsensusProposal | string;
}

/**
 * Builds the node function. Options are checked here, so a misconfigured node
 * throws TypeError when the graph is built rather than when it runs. A failed
 * run cancels its session and throws; nothing is written to state.
 */
export function MacpConsensusNode<S = Record<string, unknown>>(
  options: MacpConsensusNodeOptions<S>,
): (state: S) => Promise<Record<string, ConsensusResult>> {
  resolveConsensusOptions(options);
  const outputKey = options.outputKey ?? 'macp';
  const read = options.proposal ?? defaultProposal;
  return async (state: S) => {
    const raw = read(state);
    const proposal = typeof raw === 'string' ? { option: raw } : raw;
    return { [outputKey]: await runConsensus(options, proposal) };
  };
}
