# Integration tests

These tests drive the TypeScript SDK against a real MACP runtime. They are
excluded from `npm test` and run via `npm run test:integration`.

## Runtime setup

Build and start the runtime with dev credentials enabled:

```bash
docker build -t macp-runtime ../../macp-runtime/
docker run -d --name macp-runtime-test -p 50051:50051 \
  -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 \
  -e MACP_ALLOW_DEV_SENDER_HEADER=1 -e MACP_MEMORY_ONLY=1 macp-runtime
```

## Variables

| Variable | Used by | Required? | Description |
|---|---|---|---|
| `MACP_RUNTIME_ADDRESS` | all | no (defaults `localhost:50051`) | gRPC address |
| `MACP_TEST_BEARER_ALICE` | *Direct-agent auth* | yes for that block | Bearer token the runtime accepts for sender `alice` |
| `MACP_TEST_BEARER_BOB` | *Direct-agent auth* | yes for that block | Bearer token the runtime accepts for sender `bob` |

The direct-agent-auth tests (RFC-MACP-0004 §4) are skipped automatically when
the bearer envs are absent, so the default `npm run test:integration` flow
still works against a dev-header-only runtime.

## Enabling direct-agent-auth tests

Give the runtime real bearer credentials for the test senders, e.g.:

```bash
export MACP_AUTH_TOKENS_JSON='{"tokens":[
  {"token":"alice-test-token","sender":"alice","can_start_sessions":true},
  {"token":"bob-test-token","sender":"bob","can_start_sessions":false}
]}'

docker run -d --name macp-runtime-test -p 50051:50051 \
  -e MACP_BIND_ADDR=0.0.0.0:50051 \
  -e MACP_ALLOW_INSECURE=1 \
  -e MACP_ALLOW_DEV_SENDER_HEADER=1 \
  -e MACP_MEMORY_ONLY=1 \
  -e MACP_AUTH_TOKENS_JSON="$MACP_AUTH_TOKENS_JSON" \
  macp-runtime

export MACP_TEST_BEARER_ALICE=alice-test-token
export MACP_TEST_BEARER_BOB=bob-test-token

npm run test:integration
```

## Running

```bash
npm run test:integration

# Clean up
docker rm -f macp-runtime-test
```
