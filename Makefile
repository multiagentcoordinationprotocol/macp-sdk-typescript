.PHONY: build test lint format check sync-fixtures sync-fixtures-local verify-fixtures sync-parity verify-parity dev-link-protos

SPEC_CONFORMANCE_DIR := ../multiagentcoordinationprotocol/schemas/conformance
SPEC_PARITY_DIR := ../multiagentcoordinationprotocol/schemas/parity
# Spec vector subdirectories of SPEC_CONFORMANCE_DIR, vendored flat under tests/vectors/<dir>/.
VECTOR_DIRS := cmt-hash receipt
# Single spec documents vendored byte-identical outside tests/conformance and
# tests/vectors, as <path under SPEC_ROOT>:<local path> pairs. SPEC_ROOT is
# overridable on its own; by default it follows SPEC_CONFORMANCE_DIR, so CI's
# single override moves both. VENDORED_DIRS are the local directories these
# land in: any other *.json found there is flagged EXTRA.
SPEC_ROOT ?= $(SPEC_CONFORMANCE_DIR)/../..
VENDORED_FILES := \
	examples/discovery/receipt_keys.json:tests/fixtures/receipt_keys.json \
	schemas/otel/macp-semconv.json:tests/otel/macp-semconv.json
VENDORED_DIRS := tests/fixtures tests/otel
VENDORED_LOCAL := $(foreach p,$(VENDORED_FILES),$(word 2,$(subst :, ,$(p))))

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
	@for d in $(VECTOR_DIRS); do \
		if [ ! -d "$(SPEC_CONFORMANCE_DIR)/$$d" ]; then \
			echo "Error: Canonical $$d vector directory not found at $(SPEC_CONFORMANCE_DIR)/$$d"; \
			exit 1; \
		fi; \
	done
	@for f in $(SPEC_CONFORMANCE_DIR)/*.json; do \
		[ -e "$$f" ] || continue; \
		cp "$$f" tests/conformance/; \
		echo "  Copied $$(basename $$f)"; \
	done
	@for d in $(VECTOR_DIRS); do \
		mkdir -p "tests/vectors/$$d"; \
		for f in $(SPEC_CONFORMANCE_DIR)/$$d/*.json; do \
			[ -e "$$f" ] || continue; \
			cp "$$f" "tests/vectors/$$d/"; \
			echo "  Copied $$d/$$(basename $$f)"; \
		done; \
	done
	@for p in $(VENDORED_FILES); do \
		case "$$p" in *:*) ;; *) echo "Error: VENDORED_FILES entry $$p is not <spec path>:<local path>"; exit 1;; esac; \
		src="$${p%%:*}"; dst="$${p#*:}"; \
		if [ ! -f "$(SPEC_ROOT)/$$src" ]; then \
			echo "Error: canonical file $$src not found at $(SPEC_ROOT)/$$src"; \
			exit 1; \
		fi; \
		mkdir -p "$$(dirname "$$dst")"; \
		cp "$(SPEC_ROOT)/$$src" "$$dst"; \
		echo "  Copied $$dst"; \
	done
	@echo "Done. Run 'git diff tests/conformance/ tests/vectors/ $(VENDORED_DIRS)' to review changes."

## Alias for sync-fixtures (same source)
sync-fixtures-local: sync-fixtures

## Fail if local conformance fixtures have drifted from the canonical source.
## Run in CI on every PR so hand-edited fixtures can never merge.
verify-fixtures:
	@if [ ! -d "$(SPEC_CONFORMANCE_DIR)" ]; then \
		echo "Error: Spec repo not found at $(SPEC_CONFORMANCE_DIR)"; \
		exit 1; \
	fi
	@for d in $(VECTOR_DIRS); do \
		if [ ! -d "$(SPEC_CONFORMANCE_DIR)/$$d" ]; then \
			echo "Error: Canonical $$d vector directory not found at $(SPEC_CONFORMANCE_DIR)/$$d"; \
			exit 1; \
		fi; \
	done
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
	for d in $(VECTOR_DIRS); do \
		for f in $(SPEC_CONFORMANCE_DIR)/$$d/*.json; do \
			[ -e "$$f" ] || continue; \
			b=$$(basename "$$f"); \
			if ! diff -q "$$f" "tests/vectors/$$d/$$b" >/dev/null 2>&1; then \
				echo "  DRIFT: tests/vectors/$$d/$$b differs from (or is missing vs) canonical"; drift=1; \
			fi; \
		done; \
		for f in tests/vectors/$$d/*.json; do \
			[ -e "$$f" ] || continue; \
			b=$$(basename "$$f"); \
			if [ ! -f "$(SPEC_CONFORMANCE_DIR)/$$d/$$b" ]; then \
				echo "  EXTRA: tests/vectors/$$d/$$b has no canonical source"; drift=1; \
			fi; \
		done; \
	done; \
	for p in $(VENDORED_FILES); do \
		case "$$p" in *:*) ;; *) echo "Error: VENDORED_FILES entry $$p is not <spec path>:<local path>"; exit 1;; esac; \
		src="$${p%%:*}"; dst="$${p#*:}"; \
		if ! cmp -s "$(SPEC_ROOT)/$$src" "$$dst"; then \
			echo "  DRIFT: $$dst differs from (or is missing vs) canonical $(SPEC_ROOT)/$$src"; drift=1; \
		fi; \
	done; \
	for d in $(VENDORED_DIRS); do \
		for f in "$$d"/*.json; do \
			[ -e "$$f" ] || continue; \
			case " $(VENDORED_LOCAL) " in *" $$f "*) ;; *) echo "  EXTRA: $$f is not in VENDORED_FILES (no canonical source)"; drift=1;; esac; \
		done; \
	done; \
	if [ $$drift -ne 0 ]; then \
		echo "Conformance fixtures drifted from canonical. Run 'make sync-fixtures' and commit."; \
		echo "Note: 'make sync-fixtures' copies but never deletes -- any file flagged EXTRA: above has no canonical source and must be removed by hand."; \
		exit 1; \
	fi; \
	echo "All conformance fixtures, vectors ($(VECTOR_DIRS)) and vendored files ($(VENDORED_LOCAL)) match the canonical source."

## Sync the vendored cross-SDK parity contract from canonical source
sync-parity:
	@if [ ! -d "$(SPEC_PARITY_DIR)" ]; then \
		echo "Error: Spec repo not found at $(SPEC_PARITY_DIR)"; \
		exit 1; \
	fi
	@if [ ! -f "$(SPEC_PARITY_DIR)/contract.json" ]; then \
		echo "Error: canonical parity contract not found at $(SPEC_PARITY_DIR)/contract.json"; \
		exit 1; \
	fi
	@cp "$(SPEC_PARITY_DIR)/contract.json" tests/parity/contract.json
	@echo "  Copied contract.json"
	@echo "Done. Run 'git diff tests/parity/contract.json' to review changes."

## Fail if the vendored parity contract has drifted from the canonical source.
## Run in CI on every PR so a hand-edited manifest can never merge.
verify-parity:
	@if [ ! -d "$(SPEC_PARITY_DIR)" ]; then \
		echo "Error: Spec repo not found at $(SPEC_PARITY_DIR)"; \
		exit 1; \
	fi
	@if [ ! -f "$(SPEC_PARITY_DIR)/contract.json" ]; then \
		echo "Error: canonical parity contract not found at $(SPEC_PARITY_DIR)/contract.json"; \
		exit 1; \
	fi
	@if ! diff -q "$(SPEC_PARITY_DIR)/contract.json" tests/parity/contract.json >/dev/null 2>&1; then \
		echo "  DRIFT: tests/parity/contract.json differs from canonical"; \
		echo "Parity contract drifted from canonical. Run 'make sync-parity' and commit."; \
		exit 1; \
	fi; \
	echo "tests/parity/contract.json matches the canonical source."

## Link local proto package for development (test proto changes before publishing)
dev-link-protos:
	cd ../multiagentcoordinationprotocol/packages/proto-npm && npm link
	npm link @multiagentcoordinationprotocol/proto
	@echo "Linked local @multiagentcoordinationprotocol/proto. Run 'npm unlink @multiagentcoordinationprotocol/proto' when done."
