/**
 * Claude Agent SDK subagents as MACP participants.
 *
 * - {@link claudeEvaluator} runs one Claude agent (an `AgentDefinition`) as an
 *   EvaluationStrategy: a separate `query()` per evaluation, answering with a
 *   structured `{recommendation, confidence, reason}`.
 * - {@link macpConsensus} runs a consensus session over named agents.
 * - {@link macpConsensusServer} exposes that session to a lead agent as the
 *   in-process MCP tool `mcp__macp__consensus`, so an orchestrating agent can
 *   put a decision to its subagents and get a binding, hash-addressed
 *   commitment back.
 *
 * Every subagent sends as its own MACP identity; the lead agent never votes.
 */

import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type AgentDefinition,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MacpSdkError, type AuthConfig, type agent } from 'macp-sdk-typescript';
import {
  resolveConsensusOptions,
  runConsensus,
  type ConsensusOptions,
  type ConsensusParticipant,
  type ConsensusProposal,
  type ConsensusResult,
  type EvaluationResult,
  type EvaluationStrategy,
  type VotingStrategy,
} from './consensus.js';
import { toEvaluation } from './evaluation.js';
import { VERSION } from './version.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_MAX_TURNS = 4;

/** The structured output every evaluator is asked for. */
export const EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    recommendation: { type: 'string', enum: ['APPROVE', 'REVIEW', 'BLOCK', 'REJECT'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', description: 'One sentence.' },
  },
  required: ['recommendation', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

/** Appended to the agent's own prompt, so any AgentDefinition can evaluate. */
export const EVALUATOR_INSTRUCTIONS =
  'You are one participant in a multi-agent decision. The user message is the proposal, as JSON. ' +
  'Evaluate it from your role and answer with your recommendation (APPROVE, REVIEW, BLOCK or REJECT), ' +
  'your confidence between 0 and 1, and a one-sentence reason.';

/** The part of the Agent SDK's `query` the evaluator calls; injectable for tests. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeEvaluatorOptions {
  /** Used when the agent sets no `model` (or `'inherit'`). Default `claude-opus-5-5`. */
  model?: string;
  /** Used when the agent sets no `maxTurns`. Default 4. */
  maxTurns?: number;
  /** Extra `query()` options, applied last (e.g. `env`, `abortController`, `mcpServers`). */
  queryOptions?: Partial<Options>;
  /** Default: the Agent SDK's `query`. */
  query?: QueryFn;
}

/**
 * Runs `agent` as an EvaluationStrategy. Each evaluation is its own `query()`
 * with the agent's prompt (plus {@link EVALUATOR_INSTRUCTIONS}) as the system
 * prompt, the proposal as the user message, only the agent's own tools, no
 * filesystem settings and no persisted session.
 *
 * A structured output that doesn't validate becomes a REVIEW with confidence 0.
 * A run that ends in error (auth, max turns, budget) throws, failing the
 * consensus run, which then cancels its session.
 */
export function claudeEvaluator(agentDef: AgentDefinition, options: ClaudeEvaluatorOptions = {}): EvaluationStrategy {
  const run = options.query ?? (sdkQuery as QueryFn);
  const agentModel = agentDef.model === 'inherit' ? undefined : agentDef.model;
  return {
    async evaluate(proposal: Record<string, unknown>, _session: agent.SessionInfo): Promise<EvaluationResult> {
      const queryOptions: Options = {
        systemPrompt: `${agentDef.prompt}\n\n${EVALUATOR_INSTRUCTIONS}`,
        model: agentModel ?? options.model ?? DEFAULT_MODEL,
        tools: agentDef.tools ?? [],
        maxTurns: agentDef.maxTurns ?? options.maxTurns ?? DEFAULT_MAX_TURNS,
        outputFormat: { type: 'json_schema', schema: EVALUATION_SCHEMA },
        settingSources: [],
        persistSession: false,
        ...(agentDef.disallowedTools ? { disallowedTools: agentDef.disallowedTools } : {}),
        ...(agentDef.effort !== undefined && typeof agentDef.effort === 'string' ? { effort: agentDef.effort } : {}),
        ...options.queryOptions,
      };
      let result: Extract<SDKMessage, { type: 'result' }> | undefined;
      try {
        for await (const message of run({ prompt: JSON.stringify(proposal), options: queryOptions })) {
          if (message.type === 'result') {
            result = message;
            break;
          }
        }
      } catch (err) {
        // The SDK throws after an error result; report the result itself when one arrived.
        if (!result) {
          const error = new MacpSdkError(`claude evaluator: ${(err as Error)?.message ?? String(err)}`);
          (error as Error & { cause?: unknown }).cause = err;
          throw error;
        }
      }
      if (!result) throw new MacpSdkError('claude evaluator: the query ended without a result');
      if (result.subtype !== 'success') {
        throw new MacpSdkError(`claude evaluator ${result.subtype}: ${result.errors.join('; ') || 'no detail'}`);
      }
      if (result.is_error) throw new MacpSdkError(`claude evaluator error: ${result.result || 'no detail'}`);
      return toEvaluation(result.structured_output ?? result.result);
    },
  };
}

/** An AgentDefinition taking part in a consensus, optionally with its MACP credential and voter. */
export type MacpAgent = AgentDefinition & { auth?: AuthConfig; voter?: VotingStrategy };

export type MacpConsensusOptions = Omit<ConsensusOptions, 'participants'> &
  (
    | { participants: ConsensusParticipant[]; agents?: never }
    | {
        /** Participants by agent id, in key order; each evaluates with {@link claudeEvaluator}. */
        agents: Record<string, MacpAgent>;
        participants?: never;
        /** Applied to every agent's evaluator. */
        evaluator?: ClaudeEvaluatorOptions;
      }
  );

/** Turns `agents` into `participants`; throws TypeError unless exactly one of the two is given. */
export function toConsensusOptions(options: MacpConsensusOptions): ConsensusOptions {
  const { agents, participants, ...rest } = options as MacpConsensusOptions & {
    agents?: Record<string, MacpAgent>;
    participants?: ConsensusParticipant[];
    evaluator?: ClaudeEvaluatorOptions;
  };
  if ((agents === undefined) === (participants === undefined)) {
    throw new TypeError('consensus needs exactly one of `agents` or `participants`');
  }
  if (participants) return { ...rest, participants };
  const { evaluator, ...base } = rest as typeof rest & { evaluator?: ClaudeEvaluatorOptions };
  return {
    ...base,
    participants: Object.entries(agents!).map(([id, { auth, voter, ...definition }]) => ({
      id,
      evaluator: claudeEvaluator(definition, evaluator),
      ...(auth ? { auth } : {}),
      ...(voter ? { voter } : {}),
    })),
  };
}

/** Run one consensus session over Claude agents (or any participants) to its commitment. */
export function macpConsensus(options: MacpConsensusOptions, proposal: ConsensusProposal): Promise<ConsensusResult> {
  return runConsensus(toConsensusOptions(options), proposal);
}

export type MacpConsensusServerOptions = MacpConsensusOptions & {
  /** MCP server name; the lead agent sees the tool as `mcp__<name>__consensus`. Default `'macp'`. */
  name?: string;
  /** Called after each committed session, e.g. to issue a receipt or record the hash. */
  onResult?: (result: ConsensusResult) => void | Promise<void>;
};

export const CONSENSUS_TOOL_NAME = 'consensus';

const consensusInput = {
  option: z.string().min(1).describe('The option under decision, e.g. "refund order 9".'),
  rationale: z.string().optional().describe('Why it is proposed.'),
  details: z.record(z.string(), z.unknown()).optional().describe('Facts the participants should weigh.'),
};

/**
 * The `consensus` tool on its own, for mounting on a server you build. It
 * returns the {@link ConsensusResult} as JSON text and `structuredContent`; a
 * failed session comes back as a tool error, not a throw.
 */
export function consensusTool(options: MacpConsensusServerOptions): SdkMcpToolDefinition<typeof consensusInput> {
  const { name: _name, onResult, ...consensus } = options;
  const resolved = toConsensusOptions(consensus as MacpConsensusOptions);
  resolveConsensusOptions(resolved);
  const ids = resolved.participants.map((p) => p.id).join(', ');
  return tool(
    CONSENSUS_TOOL_NAME,
    `Put a decision to the MACP participants (${ids}). Each evaluates and votes; the runtime commits ` +
      'the outcome. Returns {outcome: "approve" | "reject", sessionId, commitmentHash, approvals, threshold, ballots}. ' +
      'The outcome is binding: act on it, do not re-ask.',
    consensusInput,
    async (args) => {
      let result: ConsensusResult;
      try {
        result = await runConsensus(resolved, args);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `consensus failed: ${(err as Error)?.message ?? String(err)}` }],
          isError: true,
        };
      }
      try {
        await onResult?.(result);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text:
                `consensus committed ${result.outcome} (session ${result.sessionId}) but onResult failed: ` +
                `${(err as Error)?.message ?? String(err)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}

/**
 * An in-process MCP server with the one `consensus` tool. Pass it to the lead
 * agent's `query()` as `mcpServers: { macp: server }` and allow
 * `mcp__macp__consensus`. Options are checked here, so a bad configuration
 * throws TypeError before any agent runs.
 */
export function macpConsensusServer(options: MacpConsensusServerOptions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: options.name ?? 'macp', version: VERSION, tools: [consensusTool(options)] });
}
