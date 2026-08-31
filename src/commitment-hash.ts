/**
 * RFC-MACP-0013 canonical commitment hashing.
 *
 * Computes a deterministic content hash for a `CommitmentPayload` by
 * projecting it to a frozen snake_case shape, serializing that shape with a
 * hand-written subset of RFC 8785 (JSON Canonicalization Scheme, "JCS"), and
 * hashing the labeled preimage with SHA-256.
 *
 * Dependency decision (deliberate, not an oversight): this module does NOT
 * depend on a JCS library. RFC 8785's hardest requirement — canonical
 * ECMAScript float formatting for JSON numbers — is unreachable here: the
 * `CommitmentPayload` projection below is a frozen 9-field shape containing
 * only strings, one boolean, and one optional 2-string nested object. No
 * JSON numbers, no JSON arrays. That leaves only object-member ordering and
 * string escaping, both of which are small enough to hand-write and test
 * directly rather than pull in this SDK's first non-gRPC/proto runtime
 * dependency. `node:crypto` is a Node builtin, not a dependency.
 */
import { createHash } from 'node:crypto';
import type { CommitmentPayload, CommitmentRef } from './types';

/**
 * Domain-separation label mixed into the hash preimage (RFC-MACP-0013 §4).
 * Changing this string changes every hash this module produces — that is a
 * protocol MINOR version bump, not a routine edit.
 */
const LABEL = 'macp-commitment-hash/1';

/**
 * Escapes a single JSON string value per RFC 8785 §3.2.2.2:
 *   - short-form escapes for backspace/tab/newline/formfeed/carriage-return,
 *     `"`, and `\`
 *   - `\u00xx` (lowercase hex) for other C0 control characters (0x00-0x1F)
 *   - every other character, including non-ASCII and astral-plane
 *     codepoints, is emitted literally (NOT escaped).
 *
 * Lone surrogates: a bare UTF-16 surrogate code unit not paired into a valid
 * codepoint is out-of-contract input for this function — a `CommitmentPayload`
 * should never legitimately contain one, since this SDK's strings originate
 * from valid UTF-16 sources (JS string literals, JSON-decoded wire payloads,
 * etc.). If one appears anyway, this function does not detect or escape it
 * specially: `for (const ch of str)` below yields it as its own one-code-unit
 * step and it is emitted literally, unescaped, like any other character. The
 * actual loss happens one step later, in `commitmentHash`, when the finished
 * JCS string is encoded to bytes via `Buffer.from(preimage, 'utf8')` — Node's
 * standard lossy UTF-8 encoder silently substitutes a lone surrogate with
 * U+FFFD (the Unicode replacement character) before hashing. The observable
 * consequence: a field containing a lone surrogate (e.g. `'\uD800'`) hashes
 * IDENTICALLY to the same field containing a literal U+FFFD in that position
 * — pinned by the "lone surrogate" test in commitment-hash.test.ts. This is
 * an accepted consequence of D3 (never throw on malformed input), not a
 * claimed point of compatibility (or divergence) with any other
 * implementation of RFC-MACP-0013.
 *
 * `value` is typed `unknown`, not `string`, on purpose: this function is the
 * single choke point that keeps `commitmentHash` from ever throwing (D3) —
 * every field of a `CommitmentPayload` flows through here, and at runtime a
 * decoded or hand-built payload is not guaranteed to actually match its
 * static type. Non-string input is coerced via `String()` (never a template
 * literal or `+`, both of which throw on a bare `Symbol`) rather than
 * rejected — this file does not "fix" a malformed payload into a valid one,
 * it only guarantees serialization cannot crash.
 *
 * Iterates with `for (const ch of str)`, which walks Unicode codepoints, not
 * UTF-16 code units. Indexing by code unit would split an astral-plane
 * codepoint's surrogate pair (e.g. U+1F702) and emit half of it — iterating
 * by codepoint is what keeps a full character, including a surrogate pair,
 * together as a single loop step so it can be appended whole.
 */
function jcsString(value: unknown): string {
  const str = typeof value === 'string' ? value : String(value ?? '');
  let out = '"';
  for (const ch of str) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\r':
        out += '\\r';
        break;
      default: {
        // Non-null assertion is safe: `for (const ch of str)` always yields
        // a non-empty code-point substring, so `codePointAt(0)` can never
        // actually be `undefined` here — a `?? 0` fallback would be dead
        // code that misleadingly reads as if codepoints can be absent.
        const code = ch.codePointAt(0) as number;
        if (code < 0x20) {
          // Other C0 control character with no short form (e.g. U+0000).
          out += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          // Printable ASCII, non-ASCII, and astral-plane codepoints alike:
          // JCS emits these as literal UTF-8, never escaped.
          out += ch;
        }
      }
    }
  }
  return out + '"';
}

/**
 * Emits `value` as a JCS boolean literal. `??` (not `||`) materializes an
 * absent `outcomePositive` as `false` rather than omitting the key (D2.2) —
 * `||` would also fold an explicit falsy-but-not-nullish value incorrectly
 * for fields added in the future, so `??` documents the intent even though
 * `boolean` only has two values today. A non-boolean value (possible only
 * for a malformed/untyped payload at runtime) is coerced via a truthy check
 * rather than thrown on, keeping D3 intact.
 */
function jcsBoolean(value: unknown): string {
  return (value ?? false) ? 'true' : 'false';
}

/**
 * The exact `CommitmentPayload` member set that `canonicalizeCommitmentPayload`
 * below projects and hashes — RFC-MACP-0013's frozen field set, expressed as a
 * type rather than a runtime array because the projection is a hand-unrolled
 * string builder with no runtime field list to compare against.
 */
type HashedCommitmentField =
  | 'action'
  | 'authorityScope'
  | 'commitmentId'
  | 'configurationVersion'
  | 'modeVersion'
  | 'outcomePositive'
  | 'policyVersion'
  | 'reason'
  | 'supersedes';

/** Fails to instantiate — a `tsc` error — for any `T` that is not `never`. */
type AssertNever<T extends never> = T;

/**
 * Compile-time frozen-field-set guard (parity with macp-sdk-python's runtime
 * `_check_frozen_field_set`, which this SDK previously had no equivalent of).
 *
 * `canonicalizeCommitmentPayload` hard-codes its member list. Without this
 * alias, a `CommitmentPayload` that grew a tenth field would keep hashing only
 * nine — no compile error, no runtime error, just a hash that silently omits
 * new protocol data. Adding such a field is itself a protocol MINOR bump per
 * this module's header, so the intended workflow when this alias goes red is:
 * project the new field into the member list below (in RFC 8785 §3.2.3
 * code-unit order), publish new spec vectors, then extend
 * `HashedCommitmentField` — never to widen the union alone.
 *
 * Both directions are checked. A field ADDED to `CommitmentPayload` and not
 * listed above leaves the first `Exclude` non-empty; a field REMOVED from
 * `CommitmentPayload` while still listed above (and so still emitted, as an
 * empty string, by the projection) leaves the second non-empty. Either way
 * `AssertNever`'s `T extends never` constraint fails and `npm run check` — and
 * therefore CI and `prepublishOnly` — goes red on this line.
 *
 * Zero runtime cost: this is a type alias, erased at compile time. It is
 * intentionally never referenced, which is what the disable comment is for.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CommitmentFieldSetIsFrozen = AssertNever<
  Exclude<keyof CommitmentPayload, HashedCommitmentField> | Exclude<HashedCommitmentField, keyof CommitmentPayload>
>;

/**
 * Projects a `CommitmentPayload` (this SDK's camelCase shape) to its RFC
 * 8785 canonical JSON string (snake_case, D2.1) and serializes it directly
 * — no intermediate object graph — in the fixed member order below.
 *
 * Member order is RFC 8785 §3.2.3: object members sorted lexicographically
 * by UTF-16 code unit on the member name. Every member name here is ASCII
 * and the field set is frozen (it mirrors `CommitmentPayload`, a stable
 * wire type), so this order is hard-coded rather than sorted at runtime:
 * action, authority_scope, commitment_id, configuration_version,
 * mode_version, outcome_positive, policy_version, reason, then supersedes
 * last (only when present). Do not "simplify" this to `.localeCompare()` —
 * that is locale-sensitive and not equivalent to code-unit ordering; it is
 * moot only because the names above are already in the right order.
 *
 * `supersedes` is omitted entirely when `payload.supersedes === undefined`
 * (D2.3) — including when the payload itself is missing/malformed, `payload
 * ?? {}` never manufactures a `supersedes` key. An explicit
 * `supersedes: { sessionId: '', commitmentHash: '' }` is NOT collapsed into
 * omission; it is present with two empty-string members, `commitment_hash`
 * before `session_id` (also alphabetical).
 *
 * Exported separately from `commitmentHash` so a vector-runner test can
 * localize a mismatch to projection/JCS (compare this string) vs. digest
 * (compare the final `sha256:` hash).
 */
export function canonicalizeCommitmentPayload(payload: CommitmentPayload): string {
  // D3: a malformed/absent payload must not throw. `{}` lets every field
  // read below fall through to `jcsString`'s/`jcsBoolean`'s own defensive
  // coercion instead of dereferencing a null/undefined payload.
  const p: CommitmentPayload = payload ?? ({} as CommitmentPayload);

  const members = [
    `"action":${jcsString(p.action)}`,
    `"authority_scope":${jcsString(p.authorityScope)}`,
    `"commitment_id":${jcsString(p.commitmentId)}`,
    `"configuration_version":${jcsString(p.configurationVersion)}`,
    `"mode_version":${jcsString(p.modeVersion)}`,
    `"outcome_positive":${jcsBoolean(p.outcomePositive)}`,
    `"policy_version":${jcsString(p.policyVersion ?? '')}`,
    `"reason":${jcsString(p.reason)}`,
  ];

  if (p.supersedes !== undefined) {
    // Optional chaining tolerates `supersedes` being present but not
    // actually an object (null, a primitive, ...) on a malformed payload —
    // it never throws, it just yields `undefined` for the sub-fields, which
    // `jcsString` then coerces to `""` the same way it handles any other
    // missing string field.
    const sup = p.supersedes as CommitmentRef | null | undefined;
    members.push(
      `"supersedes":{"commitment_hash":${jcsString(sup?.commitmentHash)},"session_id":${jcsString(sup?.sessionId)}}`,
    );
  }

  return `{${members.join(',')}}`;
}

/**
 * Computes the RFC-MACP-0013 canonical commitment hash for `payload`:
 * `sha256:` followed by 64 lowercase hex digits of
 * `SHA-256(LABEL + ':' + JCS(project(payload)))`.
 *
 * Never throws (D3), for any input — well-formed or not. Every step that
 * could plausibly throw on malformed input (unknown-typed field reads,
 * string iteration, control-character formatting) is guarded in
 * `canonicalizeCommitmentPayload` / `jcsString` / `jcsBoolean` instead of
 * being caught here, so a genuine bug in this file shows up as a test
 * failure rather than being silently swallowed by a catch-all.
 */
export function commitmentHash(payload: CommitmentPayload): string {
  const jcs = canonicalizeCommitmentPayload(payload);
  const preimage = `${LABEL}:${jcs}`;
  const digest = createHash('sha256').update(Buffer.from(preimage, 'utf8')).digest('hex');
  return `sha256:${digest}`;
}
