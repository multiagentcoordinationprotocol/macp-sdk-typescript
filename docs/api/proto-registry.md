# ProtoRegistry API Reference

The `ProtoRegistry` handles protobuf serialization and deserialization for all MACP message types.

## Constructor

```typescript
import { ProtoRegistry } from 'macp-sdk-typescript';

const registry = new ProtoRegistry();                    // default proto dir
const registry = new ProtoRegistry('/path/to/proto');    // custom proto dir
```

Loads and resolves all `.proto` files at construction time (synchronous).

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `protoDir` | `string` | Resolved path to the proto directory |

## Methods

### `getKnownTypeName(mode, messageType)`

Look up the canonical protobuf type name for a given mode and message type.

```typescript
registry.getKnownTypeName('macp.mode.decision.v1', 'Proposal');
// → 'macp.modes.decision.v1.ProposalPayload'

registry.getKnownTypeName('', 'SessionStart');
// → 'macp.v1.SessionStartPayload'

registry.getKnownTypeName('ext.multi_round.v1', 'Contribute');
// → 'macp.modes.multi_round.v1.ContributePayload'  (canonical protobuf, proto ≥ 0.1.4)

registry.getKnownTypeName('unknown', 'Unknown');
// → undefined
```

### `encodeMessage(typeName, value)`

Encode a TypeScript object to a protobuf Buffer using a specific type name.

```typescript
const buffer = registry.encodeMessage(
  'macp.modes.decision.v1.ProposalPayload',
  { proposalId: 'p1', option: 'A' },
);
```

### `decodeMessage(typeName, payload)`

Decode a protobuf Buffer to a TypeScript object.

```typescript
const obj = registry.decodeMessage(
  'macp.modes.decision.v1.ProposalPayload',
  buffer,
);
// → { proposalId: 'p1', option: 'A', rationale: '', supportingData: <Buffer> }
```

### `encodeKnownPayload(mode, messageType, value)`

Convenience: look up the type name and encode in one step.

```typescript
const buffer = registry.encodeKnownPayload(
  'macp.mode.decision.v1',
  'Proposal',
  { proposalId: 'p1', option: 'A' },
);
```

`ext.multi_round.v1` `Contribute` encodes as canonical protobuf
(`ContributePayload`) as of proto 0.1.4 / runtime 0.5.0. Unmapped extension
modes still fall back to `__json__` (JSON serialization).

Throws if no mapping exists for the given mode/messageType combination.

### `decodeKnownPayload(mode, messageType, payload)`

Convenience: look up the type name and decode in one step.

```typescript
const obj = registry.decodeKnownPayload(
  'macp.mode.decision.v1',
  'Proposal',
  buffer,
);
```

For unknown types, attempts UTF-8 JSON decoding. Returns `undefined` for empty payloads.

`ext.multi_round.v1` `Contribute` decodes both wire formats: legacy JSON
(`{"value":"..."}`, replayed verbatim from pre-proto histories) is tried first,
then canonical protobuf. Both normalize to `{ value: string }`. The two
encodings are disjoint on their first byte, so neither mis-parses as the other.

## Type Mappings

### Core Messages

| messageType | Proto Type |
|-------------|-----------|
| `SessionStart` | `macp.v1.SessionStartPayload` |
| `Commitment` | `macp.v1.CommitmentPayload` |
| `Signal` | `macp.v1.SignalPayload` |
| `Progress` | `macp.v1.ProgressPayload` |

### Mode Messages

Each mode maps its message types to proto types in the corresponding `.proto` file. For the full mapping, see `MODE_MAP` in `src/proto-registry.ts`.
