# Constants API Reference

## Protocol Version

```typescript
import { MACP_VERSION } from 'macp-sdk-typescript';

MACP_VERSION  // '1.0'
```

## Default Versions

```typescript
import {
  DEFAULT_MODE_VERSION,
  DEFAULT_CONFIGURATION_VERSION,
  DEFAULT_POLICY_VERSION,
} from 'macp-sdk-typescript';

DEFAULT_MODE_VERSION           // '1.0.0'
DEFAULT_CONFIGURATION_VERSION  // 'config.default'
DEFAULT_POLICY_VERSION         // 'policy.default'
```

## Mode Identifiers

```typescript
import {
  MODE_DECISION,
  MODE_PROPOSAL,
  MODE_TASK,
  MODE_HANDOFF,
  MODE_QUORUM,
  MODE_MULTI_ROUND,
} from 'macp-sdk-typescript';

MODE_DECISION    // 'macp.mode.decision.v1'
MODE_PROPOSAL    // 'macp.mode.proposal.v1'
MODE_TASK        // 'macp.mode.task.v1'
MODE_HANDOFF     // 'macp.mode.handoff.v1'
MODE_QUORUM      // 'macp.mode.quorum.v1'
MODE_MULTI_ROUND // 'ext.multi_round.v1'
```

The first five are **standards-track** modes. `MODE_MULTI_ROUND` is a built-in extension mode.
