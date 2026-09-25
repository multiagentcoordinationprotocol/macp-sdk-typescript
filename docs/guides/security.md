# Security

This page covers the SDK's security surface — TLS defaults, the `expectedSender` guardrail, and SDK-level retry behaviour for rate limits. The runtime is the source of truth for authentication, authorization, isolation, replay protection, rate limiting, and audit logging.

- [Runtime API § Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#authentication)
- [Runtime API § Rate Limiting](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#rate-limiting)
- [Runtime Deployment § Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#authentication)
- [Runtime Policy § Commitment authority](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#commitment-authority)
- Per-mode authorization rules: [Runtime Modes](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md)

For the SDK-side `AuthConfig` API and identity-mismatch guardrail, see [Authentication](authentication.md).

## Transport security

TLS is on by default ([RFC-MACP-0006 (Transport Bindings)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0006-transport-bindings.md) §3). The constructor throws `MacpSdkError` if you pass `secure: false` without the explicit dev-only `allowInsecure: true` escape hatch, so plaintext can never ship accidentally:

```typescript
import * as fs from 'fs';

// Production (TLS is implicit, but you may pin a CA)
const client = new MacpClient({
  address: 'runtime.example.com:50051',
  rootCertificates: fs.readFileSync('/path/to/ca.pem'),
  auth: Auth.bearer('tok-prod-123', { expectedSender: 'my-agent' }),
});

// Local dev against MACP_ALLOW_INSECURE=1
const dev = new MacpClient({
  address: '127.0.0.1:50051',
  secure: false,
  allowInsecure: true, // must be paired with secure: false
  auth: Auth.devAgent('my-agent'),
});
```

For server-side TLS configuration (`MACP_TLS_CERT_PATH`, `MACP_TLS_KEY_PATH`), see [Runtime Deployment](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md). See [Authentication § TLS](authentication.md#tls) for this SDK's full transport-security walkthrough.

## Sender identity guardrail

The runtime binds the envelope `sender` from the authenticated identity and rejects any mismatch. The SDK additionally enforces `expectedSender` *client-side* so spoofed senders fail before the envelope leaves the process, surfacing as `MacpIdentityMismatchError` rather than an opaque `UNAUTHENTICATED`:

```typescript
const auth = Auth.bearer('tok-alice', { expectedSender: 'alice' });
const session = new DecisionSession(client, { auth });

await session.vote({ proposalId: 'p1', vote: 'approve' }); // sender defaults to 'alice' — OK
await session.vote({ proposalId: 'p1', vote: 'approve', sender: 'mallory' });
// ↑ throws MacpIdentityMismatchError { expectedSender: 'alice', actualSender: 'mallory' }
```

Always set `expectedSender` in production. See [Authentication § Identity guard](authentication.md#identity-guard-strict-mode) for the full pattern, including per-operation auth overrides for multi-participant agents.

## Retrying rate limits and transient failures

The runtime enforces per-sender rate limits and returns `RATE_LIMITED` when exceeded. The SDK ships `RetryPolicy` + `retrySend()` for safe exponential-backoff retries (idempotency keys make this safe — see the [protocol spec's envelope model](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/architecture.md)):

```typescript
import { retrySend, type RetryPolicy } from 'macp-sdk-typescript';

const policy: RetryPolicy = {
  maxRetries: 5,
  backoffBase: 0.5,
  backoffMax: 2.0,
  retryableCodes: new Set(['RATE_LIMITED', 'INTERNAL_ERROR']),
};
await retrySend(client, envelope, { policy, auth });
```

Limit defaults and environment variables: [Runtime API § Rate Limiting](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#rate-limiting). See [Error Handling § Built-in Retry](error-handling.md#built-in-retry-retrysend) for this SDK's full retry-policy walkthrough, including `DEFAULT_RETRY_POLICY`.

## SDK-side production checklist

Runtime-side hardening (TLS keys, audit logging, token storage, rate-limit tuning) is covered in [Runtime Deployment § Production checklist](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#production-checklist). The items below are SDK-specific:

- [ ] Use TLS (the default) — never pass `allowInsecure: true` in prod
- [ ] Set `expectedSender` on every `Auth.bearer` call so sender spoofing fails fast (`MacpIdentityMismatchError`)
- [ ] Use real bearer tokens — never `Auth.devAgent` in prod
- [ ] When sending as multiple participants, scope auth per call (see [Authentication § Per-Operation Auth](authentication.md#per-operation-auth-multi-agent))
- [ ] Wrap network calls in `retrySend()` with a `RetryPolicy` that excludes permanent codes (`FORBIDDEN`, `INVALID_ENVELOPE`)
- [ ] Use `SessionLifecycleWatcher` for supervisor visibility rather than polling `getSession()` (see [Streaming § Session Lifecycle Watcher](streaming.md#session-lifecycle-watcher))
