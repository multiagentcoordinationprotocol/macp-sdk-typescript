export interface Root {
  uri: string;
  name?: string;
}

export interface Envelope {
  macpVersion: string;
  mode: string;
  messageType: string;
  messageId: string;
  sessionId: string;
  sender: string;
  timestampUnixMs: string;
  payload: Buffer;
}

export interface MacpErrorShape {
  code: string;
  message: string;
  sessionId?: string;
  messageId?: string;
  details?: Buffer;
}

/**
 * Lifecycle state of a session. Mirrors the `SessionState` enum in
 * `macp/v1/envelope.proto`.
 *
 * `SESSION_STATE_SUSPENDED` is a non-terminal pause (TTL is banked while
 * suspended and restored on resume); `SESSION_STATE_CANCELLED` is the terminal
 * state for an explicit `CancelSession` — distinct from `SESSION_STATE_EXPIRED`
 * (TTL / deterministic runtime policy) so consumers can tell explicit
 * cancellation from expiry.
 */
export type SessionState =
  | 'SESSION_STATE_UNSPECIFIED'
  | 'SESSION_STATE_OPEN'
  | 'SESSION_STATE_RESOLVED'
  | 'SESSION_STATE_EXPIRED'
  | 'SESSION_STATE_SUSPENDED'
  | 'SESSION_STATE_CANCELLED';

export interface Ack {
  ok?: boolean;
  duplicate?: boolean;
  messageId?: string;
  sessionId?: string;
  acceptedAtUnixMs?: string;
  sessionState?: SessionState;
  error?: MacpErrorShape;
}

export interface ParticipantActivity {
  participantId: string;
  lastMessageAtUnixMs: string;
  messageCount: number;
}

export interface SessionMetadata {
  sessionId?: string;
  mode?: string;
  state?: SessionState;
  startedAtUnixMs?: string;
  expiresAtUnixMs?: string;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
  participants?: string[];
  participantActivity?: ParticipantActivity[];
  initiator?: string;
  contextId?: string;
  extensionKeys?: string[];
}

export interface ModeDescriptor {
  mode: string;
  modeVersion: string;
  title?: string;
  description?: string;
  determinismClass?: string;
  participantModel?: string;
  messageTypes?: string[];
  terminalMessageTypes?: string[];
  schemaUris?: Record<string, string>;
}

export interface TransportEndpoint {
  transport: string;
  uri: string;
  contentTypes?: string[];
  metadata?: Record<string, string>;
}

export interface AgentManifest {
  agentId?: string;
  title?: string;
  description?: string;
  supportedModes?: string[];
  inputContentTypes?: string[];
  outputContentTypes?: string[];
  metadata?: Record<string, string>;
  transportEndpoints?: TransportEndpoint[];
}

export interface InitializeResult {
  selectedProtocolVersion: string;
  runtimeInfo?: {
    name?: string;
    title?: string;
    version?: string;
    description?: string;
    websiteUrl?: string;
  };
  supportedModes?: string[];
  instructions?: string;
  capabilities?: Record<string, unknown>;
}

export interface SessionStartPayload {
  intent: string;
  participants: string[];
  modeVersion: string;
  configurationVersion: string;
  policyVersion?: string;
  ttlMs: number;
  contextId?: string;
  extensions?: Record<string, Buffer>;
  roots?: Root[];
}

/**
 * Reference to a specific accepted commitment, used for cross-session
 * supersession (RFC-MACP-0001 §7.3). Mirrors `macp.v1.CommitmentRef`.
 */
export interface CommitmentRef {
  sessionId: string;
  /** Content hash of the superseded `CommitmentPayload`. */
  commitmentHash: string;
}

export interface CommitmentPayload {
  commitmentId: string;
  action: string;
  authorityScope: string;
  reason: string;
  modeVersion: string;
  policyVersion?: string;
  configurationVersion: string;
  outcomePositive?: boolean;
  /**
   * Cross-session supersession (RFC-MACP-0001 §7.3): when present, this
   * commitment supersedes a prior commitment identified by
   * `{sessionId, commitmentHash}`. The superseding commitment lives in a NEW
   * session — a RESOLVED session accepts no further messages.
   */
  supersedes?: CommitmentRef;
}

export interface SignalPayload {
  signalType: string;
  data?: Buffer;
  confidence?: number;
  correlationSessionId?: string;
}

export interface ProgressPayload {
  progressToken: string;
  progress: number;
  total: number;
  message?: string;
  targetMessageId?: string;
}

export interface DecisionProposalPayload {
  proposalId: string;
  option: string;
  rationale?: string;
  supportingData?: Buffer;
}

export interface DecisionEvaluationPayload {
  proposalId: string;
  recommendation: string;
  confidence: number;
  reason?: string;
}

export interface DecisionObjectionPayload {
  proposalId: string;
  reason: string;
  severity?: string;
}

export interface DecisionVotePayload {
  proposalId: string;
  vote: string;
  reason?: string;
}

export interface ProposalModeProposalPayload {
  proposalId: string;
  title: string;
  summary?: string;
  details?: Buffer;
  tags?: string[];
}

export interface CounterProposalPayload {
  proposalId: string;
  supersedesProposalId: string;
  title: string;
  summary?: string;
  details?: Buffer;
}

export interface AcceptPayload {
  proposalId: string;
  reason?: string;
}

export interface RejectPayload {
  proposalId: string;
  terminal?: boolean;
  reason?: string;
}

export interface WithdrawPayload {
  proposalId: string;
  reason?: string;
}

export interface TaskRequestPayload {
  taskId: string;
  title: string;
  instructions: string;
  requestedAssignee?: string;
  input?: Buffer;
  deadlineUnixMs?: number;
}

export interface TaskAcceptPayload {
  taskId: string;
  assignee: string;
  reason?: string;
}

export interface TaskRejectPayload {
  taskId: string;
  assignee: string;
  reason?: string;
}

export interface TaskUpdatePayload {
  taskId: string;
  status: string;
  progress: number;
  message?: string;
  partialOutput?: Buffer;
}

export interface TaskCompletePayload {
  taskId: string;
  assignee: string;
  output?: Buffer;
  summary?: string;
}

export interface TaskFailPayload {
  taskId: string;
  assignee: string;
  errorCode?: string;
  reason?: string;
  retryable?: boolean;
}

export interface HandoffOfferPayload {
  handoffId: string;
  targetParticipant: string;
  scope?: string;
  reason?: string;
}

export interface HandoffContextPayload {
  handoffId: string;
  contentType: string;
  context?: Buffer;
}

export interface HandoffAcceptPayload {
  handoffId: string;
  acceptedBy: string;
  reason?: string;
}

export interface HandoffDeclinePayload {
  handoffId: string;
  declinedBy: string;
  reason?: string;
}

export interface ApprovalRequestPayload {
  requestId: string;
  action: string;
  summary: string;
  details?: Buffer;
  requiredApprovals: number;
}

export interface ApprovePayload {
  requestId: string;
  reason?: string;
}

export interface QuorumRejectPayload {
  requestId: string;
  reason?: string;
}

export interface AbstainPayload {
  requestId: string;
  reason?: string;
}

export interface PolicyDescriptor {
  policyId: string;
  mode: string;
  description: string;
  rules: string;
  schemaVersion: number;
  registeredAtUnixMs?: number;
}

export interface RegistryChanged {
  registry: string;
  observedAtUnixMs: string;
}

export interface RootsChanged {
  observedAtUnixMs: string;
}

export type SessionLifecycleEventType =
  | 'EVENT_TYPE_UNSPECIFIED'
  | 'EVENT_TYPE_CREATED'
  | 'EVENT_TYPE_RESOLVED'
  | 'EVENT_TYPE_EXPIRED'
  | 'EVENT_TYPE_SUSPENDED'
  | 'EVENT_TYPE_RESUMED'
  | 'EVENT_TYPE_CANCELLED';

export interface SessionLifecycleEvent {
  eventType: SessionLifecycleEventType;
  session: SessionMetadata;
  observedAtUnixMs: string;
}
