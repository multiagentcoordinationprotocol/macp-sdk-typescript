# Assumptions

## commitmentHash / canonicalizeCommitmentPayload exported as public API in Phase 1
- **Plan:** `../multiagentcoordinationprotocol/plans/cross-repo/macp-sdk-typescript-rfc-macp-0013.md` (Phase 1)
- **Assumed:** the plan asked for "a separate exported helper so the vector runner can localize a failure" but didn't say whether that helper should be part of the SDK's public (barrel-exported) surface or an internal-only export.
- **Chose:** exported both `commitmentHash` and `canonicalizeCommitmentPayload` through the `src/index.ts` wildcard barrel (`export * from './commitment-hash';`), same as every other module in this SDK — there is no internal/external export split pattern elsewhere in the codebase to follow instead.
- **Alternatives:** keep `canonicalizeCommitmentPayload` internal (not re-exported from `src/commitment-hash.ts`, or re-exported but omitted from the barrel) until Phase 3 proves the algorithm against the RFC's spec vectors.
- **Blast radius if wrong:** `commitmentHash`'s output becomes public API under semver as of Phase 1's commit, before Phase 3 validates it against the RFC's canonical vectors. If Phase 3 finds a mismatch, fixing it changes every previously-computed hash — a protocol MINOR per the module's own docblock, and a breaking change to an already-published symbol if a release cuts between phases. Mitigated for now by keeping Phase 1 as a local, unpushed commit until Phase 3 lands (see PROGRESS.md) rather than shipping it standalone.
- **Status:** UNCONFIRMED

## supersedes: null / non-object collides with a legitimate empty-string CommitmentRef
- **Plan:** `../multiagentcoordinationprotocol/plans/cross-repo/macp-sdk-typescript-rfc-macp-0013.md` (Phase 1, D3)
- **Assumed:** `commitmentHash()` must never throw (D3), including on malformed/out-of-contract input (e.g. a decoded or hand-built payload with `supersedes: null` or `supersedes: 'oops'` instead of a proper `CommitmentRef | undefined`).
- **Chose:** treat any non-`undefined` `supersedes` value as "present" and coerce its fields defensively (via the same string coercion used elsewhere), rather than distinguishing "malformed object" from "valid empty-string ref". Both currently canonicalize to `"supersedes":{"commitment_hash":"","session_id":""}` and therefore hash identically.
- **Alternatives:** treat non-object `supersedes` values as if they were `undefined` (omit the key) instead of coercing them into an empty-string ref — rejected because it would silently discard a payload the caller might expect to be validated/rejected outright.
- **Blast radius if wrong:** low in practice — this only bites hand-built or corrupted payloads that bypass typed construction, and Phase 2's `validateCommitmentHash` is the intended enforcement point for well-formed `CommitmentRef`s generally (it validates the hash *string* shape, not the ref's structural well-formedness, so this specific collision is not fully closed by Phase 2 either — noted here for visibility, not as a Phase 2 requirement).
- **Status:** UNCONFIRMED
