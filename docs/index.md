# MACP TypeScript SDK Documentation

## Overview

The MACP TypeScript SDK connects TypeScript/Node.js applications to the [Multi-Agent Coordination Protocol](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol) runtime over gRPC. It provides typed helpers for all five standards-track coordination modes, local state projections, and streaming capabilities.

## Table of Contents

### Guides

- [Getting Started](guides/getting-started.md) — Install, connect, and run your first session
- [Architecture](guides/architecture.md) — Three-layer design, projections, and the runtime boundary
- [Authentication](guides/authentication.md) — Dev agents, bearer tokens, and multi-agent patterns
- [Error Handling](guides/error-handling.md) — Error classes, ACK semantics, and retry patterns
- [Streaming](guides/streaming.md) — Session streams, registry watchers, signal watchers, and policy watchers
- [Policy Framework](guides/policy.md) — Governance policies, rule builders, and policy lifecycle
- [Agent Framework](guides/agent-framework.md) — Participant abstraction, strategies, and bootstrap
- [Testing](guides/testing.md) — Running tests, writing new tests, and integration test patterns

### Coordination Modes

- [Decision Mode](modes/decision.md) — Proposals, evaluations, objections, votes
- [Proposal Mode](modes/proposal.md) — Negotiation with counterproposals
- [Task Mode](modes/task.md) — Bounded task delegation
- [Handoff Mode](modes/handoff.md) — Responsibility transfer
- [Quorum Mode](modes/quorum.md) — Threshold-based approval voting

### API Reference

- [MacpClient](api/client.md) — Low-level gRPC transport
- [Session Classes](api/sessions.md) — High-level session helpers
- [Projections](api/projections.md) — Client-side state tracking
- [Envelope Builders](api/envelope.md) — Message construction utilities
- [ProtoRegistry](api/proto-registry.md) — Protobuf encode/decode
- [Policy Builders](api/policy.md) — Policy descriptor builders and PolicyWatcher
- [Types](api/types.md) — TypeScript interfaces
- [Constants](api/constants.md) — Mode identifiers and defaults
- [Errors](api/errors.md) — Error class hierarchy

## Related documentation

This SDK is the gRPC client; the runtime is the source of truth for protocol semantics, RPC contracts, deployment, and auth. Rather than duplicate runtime material, we link to it:

- [Runtime — Getting Started](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md) — build the runtime, static/JWT auth configuration, first session
- [Runtime — API Reference](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md) — all 22 gRPC RPCs with request/response fields and capability flags
- [Runtime — Architecture](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/architecture.md) — layer structure, request flow, durability model
- [Runtime — Modes](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md) — per-mode state machine implementation details
- [Runtime — Policy](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md) — policy framework, rule schemas, evaluator internals
- [Runtime — Deployment](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md) — production config, storage backends, TLS, crash recovery
- [Runtime — SDK Developer Guide](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/sdk-guide.md) — envelope construction, streaming, passive subscribe, retries
- [Protocol Specification](https://www.multiagentcoordinationprotocol.io/docs) — two-plane model, session lifecycle, determinism, security, transport bindings
