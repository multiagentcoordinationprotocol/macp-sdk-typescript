# Source

`macp-semconv.json` is a byte-identical copy of `schemas/otel/macp-semconv.json` in the spec repo
(`multiagentcoordinationprotocol/multiagentcoordinationprotocol`), commit `0f77753` ("docs(otel):
MACP OpenTelemetry semantic conventions macp-semconv/0.1", spec PR #231), copied on 2026-10-26.
It defines the experimental `macp-semconv/0.1` span names and attributes (prose:
`docs/opentelemetry.md` in the spec repo). The spec's weekly `check-sdk-sync.py` expects it at this
path in both SDKs; macp-sdk-python vendors the same file.

Nothing in this SDK reads it yet: the OpenTelemetry instrumentation that will (W5 S2) lands
separately. Never edit it here; refresh it with `make sync-fixtures`. `make verify-fixtures`
compares it byte for byte (the Makefile's `VENDORED_FILES`) and flags any other
`tests/otel/*.json` as EXTRA.
