// Auth: export only the public constructors and types. The helpers
// `validateAuth`, `authSender`, `assertSenderMatchesIdentity`, and
// `metadataFromAuth` are SDK-internal — importable from the `./auth`
// submodule if needed, but intentionally absent from the top-level surface
// to match python-sdk's `__all__` (which only exposes `AuthConfig`).
export { Auth, type AuthConfig, type BearerAuthOptions } from './auth';
export * from './base-session';
export * from './client';
// RFC-MACP-0001 §10 canonical JSON for Envelopes and Acks (A2A `data` Parts,
// JSON transports). Node-free, like `./receipt`.
export {
  CanonicalJsonError,
  ackFromCanonicalJson,
  ackToCanonicalJson,
  envelopeFromCanonicalJson,
  envelopeToCanonicalJson,
  type CanonicalEnvelope,
  type CanonicalJsonOptions,
} from './canonical-json';
// RFC-MACP-0014 A2A extension binding codec: Envelopes and Acks as A2A Parts,
// Messages and Artifacts. Plain JSON objects, no A2A SDK dependency; Node-free,
// also published as the `./a2a` subpath.
export {
  A2A_VERSION,
  MACP_A2A_EXTENSION_URI,
  MEDIA_TYPE_ENVELOPE_JSON,
  MEDIA_TYPE_ENVELOPE_PROTO,
  MacpA2aError,
  ackFromA2aMessage,
  ackToA2aMessage,
  envelopeFromA2aArtifact,
  envelopeFromA2aMessage,
  envelopeFromA2aPart,
  envelopeToA2aArtifact,
  envelopeToA2aMessage,
  envelopeToA2aPart,
  errorInfoFromA2a,
  macpAgentExtension,
  sessionStateFromA2a,
  sessionStateToA2a,
  type A2aAckMessageOptions,
  type A2aAgentExtension,
  type A2aArtifact,
  type A2aDecodeOptions,
  type A2aEncodeOptions,
  type A2aMessage,
  type A2aMessageOptions,
  type A2aPart,
  type A2aTask,
  type A2aErrorInfo,
  type MacpA2aErrorLayer,
  type MacpAgentExtensionOptions,
} from './a2a';
// Commitment hash: export `commitmentHash`, `isCanonicalCommitmentHash`, and
// the RFC-MACP-0013 §6.1 verifier `verifyCommitmentHash`.
// `canonicalizeCommitmentPayload` is the projection/JCS half of the
// algorithm — importable from the `./commitment-hash` submodule (as the
// vector-runner tests do) but kept off the top-level surface to match
// python-sdk's public API, which does not expose its `canonical_projection`
// equivalent either.
export { commitmentHash, isCanonicalCommitmentHash, verifyCommitmentHash, type VerifyOutcome } from './commitment-hash';
export * from './constants';
export * from './decision';
export * from './envelope';
export * from './errors';
export * from './handoff';
// Logging: export the public surface only. `_resetLoggingForTests` is a
// test-only reset helper — excluded here (a one-hop wildcard, unlike
// `PROJECTION_ANOMALY_FIELD_ORDER`'s two-hop chain via `./projections`,
// which cannot be excluded this way). `package.json`'s `exports` map
// exposes only `.`, so this makes it unreachable from the published
// package, not merely un-barrelled — accepted, since it is test-only by
// name and by purpose.
export { configureLogging, logger, type LogLevel, type LogSink } from './logging';
export * from './policy';
export * from './projections';
export * from './proposal';
export * from './proto-registry';
export * from './retry';
export * from './quorum';
// RFC-MACP-0013 Appendix A decision receipts. Also published as the
// browser-safe `macp-sdk-typescript/receipt` subpath (no gRPC, no node:crypto).
export {
  RECEIPT_FORMAT,
  buildReceipt,
  commitmentFromProjection,
  trustedKeysFromJwks,
  verifyReceipt,
  type AttestationOutcome,
  type BuildReceiptOptions,
  type DecisionReceipt,
  type DecisionReceiptResult,
  type JwsAttestation,
  type ReceiptAttestation,
  type ReceiptCommitment,
  type ReceiptIntegrity,
  type ReceiptJwk,
  type ReceiptKeySet,
  type ReceiptSigner,
  type ReceiptVerdict,
  type ReceiptVerification,
  type VendorAttestation,
} from './receipt';
export * from './task';
export * from './types';
export * from './validation';
export { VERSION } from './version';
export * from './watchers';
export * as agent from './agent';
