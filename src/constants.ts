export const MACP_VERSION = '1.0';

export const DEFAULT_MODE_VERSION = '1.0.0';
export const DEFAULT_CONFIGURATION_VERSION = 'config.default';
export const DEFAULT_POLICY_VERSION = 'policy.default';

export const MODE_DECISION = 'macp.mode.decision.v1';
export const MODE_PROPOSAL = 'macp.mode.proposal.v1';
export const MODE_TASK = 'macp.mode.task.v1';
export const MODE_HANDOFF = 'macp.mode.handoff.v1';
export const MODE_QUORUM = 'macp.mode.quorum.v1';
export const MODE_MULTI_ROUND = 'ext.multi_round.v1';

/**
 * The five first-class coordination modes. Parity with
 * python-sdk `macp_sdk.constants.STANDARD_MODES`.
 */
export const STANDARD_MODES = [MODE_DECISION, MODE_PROPOSAL, MODE_TASK, MODE_HANDOFF, MODE_QUORUM] as const;

// Well-known error codes. Names match the on-the-wire strings the runtime
// emits and python-sdk's exports (no ERR_ prefix).
export const UNSUPPORTED_PROTOCOL_VERSION = 'UNSUPPORTED_PROTOCOL_VERSION';
export const INVALID_ENVELOPE = 'INVALID_ENVELOPE';
export const SESSION_ALREADY_EXISTS = 'SESSION_ALREADY_EXISTS';
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND';
export const SESSION_NOT_OPEN = 'SESSION_NOT_OPEN';
export const MODE_NOT_SUPPORTED = 'MODE_NOT_SUPPORTED';
export const FORBIDDEN = 'FORBIDDEN';
export const UNAUTHENTICATED = 'UNAUTHENTICATED';
export const DUPLICATE_MESSAGE = 'DUPLICATE_MESSAGE';
export const PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE';
export const RATE_LIMITED = 'RATE_LIMITED';
export const INTERNAL_ERROR = 'INTERNAL_ERROR';
export const POLICY_DENIED = 'POLICY_DENIED';
export const INVALID_SESSION_ID = 'INVALID_SESSION_ID';
export const UNKNOWN_POLICY_VERSION = 'UNKNOWN_POLICY_VERSION';
export const INVALID_POLICY_DEFINITION = 'INVALID_POLICY_DEFINITION';
// Control-plane codes added in runtime 0.9.0 (carried in `macp-error-code`
// metadata; see `MacpTransportError.macpErrorCode` / `MacpAckError.macpErrorCode`).
/** Register/UnregisterPolicy against a file-loaded (read-only) policy registry — FAILED_PRECONDITION. */
export const REGISTRY_READ_ONLY = 'REGISTRY_READ_ONLY';
/** Malformed control-plane request (bad page_size/page_token, missing descriptor, …) — INVALID_ARGUMENT. */
export const INVALID_REQUEST = 'INVALID_REQUEST';
/** Stream/watch subscriber fell behind — RESOURCE_EXHAUSTED; resubscribe with `afterSequence`. */
export const STREAM_LAGGED = 'STREAM_LAGGED';
/** GetManifest for an agent this runtime does not host — NOT_FOUND. */
export const AGENT_NOT_FOUND = 'AGENT_NOT_FOUND';
