.PHONY: build test lint format check sync-fixtures sync-fixtures-local verify-fixtures dev-link-protos

SPEC_CONFORMANCE_DIR := ../multiagentcoordinationprotocol/schemas/conformance

build:
	npm run build

test:
	npm test

lint:
	npm run lint

format:
	npm run format

check: lint format build test

## Sync conformance fixtures from canonical source
sync-fixtures:
	@if [ ! -d "$(SPEC_CONFORMANCE_DIR)" ]; then \
		echo "Error: Spec repo not found at $(SPEC_CONFORMANCE_DIR)"; \
		exit 1; \
	fi
	@if [ ! -d "$(SPEC_CONFORMANCE_DIR)/cmt-hash" ]; then \
		echo "Error: Canonical cmt-hash vector directory not found at $(SPEC_CONFORMANCE_DIR)/cmt-hash"; \
		exit 1; \
	fi
	@for f in $(SPEC_CONFORMANCE_DIR)/*.json; do \
		[ -e "$$f" ] || continue; \
		cp "$$f" tests/conformance/; \
		echo "  Copied $$(basename $$f)"; \
	done
	@for f in $(SPEC_CONFORMANCE_DIR)/cmt-hash/*.json; do \
		[ -e "$$f" ] || continue; \
		cp "$$f" tests/vectors/cmt-hash/; \
		echo "  Copied $$(basename $$f)"; \
	done
	@echo "Done. Run 'git diff tests/conformance/' and 'git diff tests/vectors/cmt-hash/' to review changes."

## Alias for sync-fixtures (same source)
sync-fixtures-local: sync-fixtures

## Fail if local conformance fixtures have drifted from the canonical source.
## Run in CI on every PR so hand-edited fixtures can never merge.
verify-fixtures:
	@if [ ! -d "$(SPEC_CONFORMANCE_DIR)" ]; then \
		echo "Error: Spec repo not found at $(SPEC_CONFORMANCE_DIR)"; \
		exit 1; \
	fi
	@if [ ! -d "$(SPEC_CONFORMANCE_DIR)/cmt-hash" ]; then \
		echo "Error: Canonical cmt-hash vector directory not found at $(SPEC_CONFORMANCE_DIR)/cmt-hash"; \
		exit 1; \
	fi
	@drift=0; \
	for f in $(SPEC_CONFORMANCE_DIR)/*.json; do \
		[ -e "$$f" ] || continue; \
		b=$$(basename "$$f"); \
		if ! diff -q "$$f" "tests/conformance/$$b" >/dev/null 2>&1; then \
			echo "  DRIFT: tests/conformance/$$b differs from (or is missing vs) canonical"; drift=1; \
		fi; \
	done; \
	for f in tests/conformance/*.json; do \
		[ -e "$$f" ] || continue; \
		b=$$(basename "$$f"); \
		if [ ! -f "$(SPEC_CONFORMANCE_DIR)/$$b" ]; then \
			echo "  EXTRA: tests/conformance/$$b has no canonical source"; drift=1; \
		fi; \
	done; \
	for f in $(SPEC_CONFORMANCE_DIR)/cmt-hash/*.json; do \
		[ -e "$$f" ] || continue; \
		b=$$(basename "$$f"); \
		if ! diff -q "$$f" "tests/vectors/cmt-hash/$$b" >/dev/null 2>&1; then \
			echo "  DRIFT: tests/vectors/cmt-hash/$$b differs from (or is missing vs) canonical"; drift=1; \
		fi; \
	done; \
	for f in tests/vectors/cmt-hash/*.json; do \
		[ -e "$$f" ] || continue; \
		b=$$(basename "$$f"); \
		if [ ! -f "$(SPEC_CONFORMANCE_DIR)/cmt-hash/$$b" ]; then \
			echo "  EXTRA: tests/vectors/cmt-hash/$$b has no canonical source"; drift=1; \
		fi; \
	done; \
	if [ $$drift -ne 0 ]; then \
		echo "Conformance fixtures drifted from canonical. Run 'make sync-fixtures' and commit."; \
		echo "Note: 'make sync-fixtures' copies but never deletes -- any file flagged EXTRA: above has no canonical source and must be removed by hand."; \
		exit 1; \
	fi; \
	echo "All conformance fixtures and cmt-hash vectors match the canonical source."

## Link local proto package for development (test proto changes before publishing)
dev-link-protos:
	cd ../multiagentcoordinationprotocol/packages/proto-npm && npm link
	npm link @multiagentcoordinationprotocol/proto
	@echo "Linked local @multiagentcoordinationprotocol/proto. Run 'npm unlink @multiagentcoordinationprotocol/proto' when done."
