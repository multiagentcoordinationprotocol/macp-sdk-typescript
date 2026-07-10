// Auth: export only the public constructors and types. The helpers
// `validateAuth`, `authSender`, `assertSenderMatchesIdentity`, and
// `metadataFromAuth` are SDK-internal — importable from the `./auth`
// submodule if needed, but intentionally absent from the top-level surface
// to match python-sdk's `__all__` (which only exposes `AuthConfig`).
export { Auth, type AuthConfig, type BearerAuthOptions } from './auth';
export * from './base-session';
export * from './client';
export * from './constants';
export * from './decision';
export * from './envelope';
export * from './errors';
export * from './handoff';
export * from './logging';
export * from './policy';
export * from './projections';
export * from './proposal';
export * from './proto-registry';
export * from './retry';
export * from './quorum';
export * from './task';
export * from './types';
export * from './validation';
export { VERSION } from './version';
export * from './watchers';
export * as agent from './agent';
