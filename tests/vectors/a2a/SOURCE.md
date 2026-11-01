# Source

These `a2a_*.json` vectors (and `vector-schema.json`) are a point-in-time copy of:

```
schemas/conformance/a2a/
```

from the spec repo (`multiagentcoordinationprotocol/multiagentcoordinationprotocol`),
commit `2e7d3ab` ("conformance(a2a): RFC-MACP-0014 codec vectors + reference checker
(W6 P6.3)", spec PR #245), copied on 2026-11-01 for W6 S6.2 (the A2A binding codec,
`src/a2a.ts`). The spec's `README.md` there lists the conventions and what the
vectors do not pin. Never edit them here; refresh them with `make sync-fixtures`.

`make verify-fixtures` and `make sync-fixtures` cover this directory bidirectionally
through the Makefile's `VECTOR_DIRS` list, and the spec's `scripts/check-sdk-sync.py`
holds it identical to macp-sdk-python's copy.

`tests/vectors/a2a.test.ts` runs every vector through the codec. Envelopes and Acks in
`input` are parsed with the canonical-json codec, and results are re-encoded with it and
compared with `expected` as parsed JSON. Every reject vector must throw `MacpA2aError`
with the vector's `layer` and `code`.
