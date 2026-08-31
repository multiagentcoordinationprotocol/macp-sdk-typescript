import type { ProjectionAnomaly } from '../projections/base';
import type { Envelope } from '../types';

export interface IncomingMessage {
  messageType: string;
  sender: string;
  payload: Record<string, unknown>;
  proposalId?: string;
  raw: Envelope;
  seq?: number;
}

export interface SessionInfo {
  sessionId: string;
  mode: string;
  participants: string[];
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
}

export interface SessionActions {
  evaluate?(input: { proposalId: string; recommendation: string; confidence: number; reason?: string }): Promise<void>;
  vote?(input: { proposalId: string; vote: string; reason?: string }): Promise<void>;
  raiseObjection?(input: { proposalId: string; reason: string; severity?: string }): Promise<void>;
  propose?(input: { proposalId: string; option: string; rationale?: string; supportingData?: Buffer }): Promise<void>;
  commit?(input: {
    action: string;
    authorityScope: string;
    reason: string;
    commitmentId?: string;
    outcomePositive?: boolean;
  }): Promise<void>;
  send?(messageType: string, payload: Record<string, unknown>): Promise<void>;
}

export interface HandlerContext {
  participant: ParticipantLike;
  projection: ProjectionLike;
  actions: SessionActions;
  session: SessionInfo;
  log: (msg: string, details?: Record<string, unknown>) => void;
}

export interface ParticipantLike {
  readonly participantId: string;
  readonly sessionId: string;
  readonly mode: string;
}

export interface ProjectionLike {
  readonly phase: string;
  readonly transcript: Envelope[];
  /**
   * Cardinality anomalies observed and discarded by the projection, in transcript order.
   *
   * OPTIONAL, and it must STAY optional. `ProjectionLike` is structurally
   * implementable by consumers — test fakes, custom transports, alternative
   * projection implementations — none of which this SDK controls. Making this
   * member required would break every such implementer at compile time for a
   * field most of them have no reason to provide. The guard below turns a
   * later "tightening" into a build failure rather than a silent break.
   */
  readonly anomalies?: readonly ProjectionAnomaly[];
}

/** Fails to instantiate — a `tsc` error — for any `T` that is not exactly `true`. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time guard that `ProjectionLike.anomalies` stays OPTIONAL.
 *
 * A minimal structural implementer — `{ phase, transcript }` and nothing else —
 * must continue to satisfy `ProjectionLike`. If someone later drops the `?`, this
 * alias stops resolving to `true` and `npm run check` (and therefore CI and
 * `prepublishOnly`) goes red on this line rather than the break surfacing as a
 * consumer's compile error after publish.
 *
 * Same shape and intent as `commitment-hash.ts`'s frozen-field-set guard: a
 * type-level assertion in `src/`, where the build actually type-checks it.
 * `tests/` is NOT type-checked by any gate (`tsconfig.json` includes only
 * `src/**`), so an equivalent assertion written in a test file compiles nothing
 * and proves nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ProjectionLikeAnomaliesStaysOptional = AssertTrue<
  { phase: string; transcript: Envelope[] } extends ProjectionLike ? true : false
>;

export type MessageHandler = (event: IncomingMessage, ctx: HandlerContext) => void | Promise<void>;
export type TerminalHandler = (result: TerminalResult) => void | Promise<void>;
export type PhaseChangeHandler = (newPhase: string, ctx: HandlerContext) => void | Promise<void>;

export interface TerminalResult {
  state: string;
  commitment?: Record<string, unknown>;
}
