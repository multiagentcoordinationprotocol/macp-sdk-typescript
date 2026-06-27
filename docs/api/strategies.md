# Strategies API Reference

The `src/agent/strategies.ts` module provides **composable handler factories**
that wire a strategy object (the decision logic) into a `MessageHandler`
(the thing you register with `Participant.on(...)`).

Strategies are focused on Decision Mode today — evaluating proposals, casting
votes, and committing outcomes — because Decision is where multi-step, order-
dependent logic benefits most from being abstracted away. For other modes,
register plain handlers directly via `Participant.on()`.

## Evaluation

### `EvaluationStrategy`

```typescript
interface EvaluationResult {
  recommendation: string;   // e.g. 'APPROVE', 'REVIEW', 'REJECT'
  confidence: number;       // 0..1
  reason: string;
}

interface EvaluationStrategy {
  evaluate(
    proposal: Record<string, unknown>,
    context: SessionInfo,
  ): Promise<EvaluationResult>;
}
```

### `evaluationHandler(strategy)`

Returns a handler that reacts to `Proposal` messages by calling
`strategy.evaluate(...)` and forwarding the result to `ctx.actions.evaluate()`.

```typescript
participant.on('Proposal', evaluationHandler(myEvaluator));
```

### `functionEvaluator(fn)`

Wraps a plain async function as an `EvaluationStrategy` — no class needed.

```typescript
import { agent } from 'macp-sdk-typescript';

const evaluator = agent.functionEvaluator(async (proposal, session) => ({
  recommendation: proposal.option === 'deploy' ? 'APPROVE' : 'REVIEW',
  confidence: 0.9,
  reason: `policy=${session.policyVersion}`,
}));

participant.on('Proposal', agent.evaluationHandler(evaluator));
```

## Voting

### `VotingStrategy`

```typescript
interface VoteResult {
  vote: string;     // 'APPROVE' | 'REJECT' | 'ABSTAIN'
  reason: string;
}

interface VotingStrategy {
  shouldVote(projection: DecisionProjection): boolean;
  decideVote(projection: DecisionProjection): Promise<VoteResult>;
}
```

Each incoming `Evaluation` envelope calls `shouldVote()` first; the handler
only votes when it returns `true`.

### `votingHandler(strategy)`

```typescript
participant.on('Evaluation', votingHandler(myVoter));
```

### `functionVoter(shouldVote, decideVote)`

```typescript
const voter = agent.functionVoter(
  (projection) => projection.evaluations.length >= 2,
  async (projection) => ({
    vote: projection.voteTotals()['approve'] ?? 0 > 0 ? 'APPROVE' : 'REJECT',
    reason: `${projection.evaluations.length} evaluations seen`,
  }),
);
```

### `majorityVoter({ positiveThreshold? })`

Prebuilt — votes `APPROVE` when the ratio of positive evaluations meets
`positiveThreshold` (default `0.5`); otherwise `REJECT`. Positive
recommendations are `approve` / `accept` / `yes` (case-insensitive).

```typescript
participant.on('Evaluation', votingHandler(majorityVoter({ positiveThreshold: 0.8 })));
```

## Commitment

### `CommitmentStrategy`

```typescript
interface CommitmentResult {
  action: string;             // outcome descriptor
  authorityScope: string;
  reason: string;
  outcomePositive?: boolean;  // defaults to inferOutcomePositive(action)
}

interface CommitmentStrategy {
  shouldCommit(projection: DecisionProjection): boolean;
  decideCommitment(projection: DecisionProjection): Promise<CommitmentResult>;
}
```

### `commitmentHandler(strategy)`

```typescript
participant.on('Vote', commitmentHandler(myCommitter));
```

### `functionCommitter(shouldCommit, decideCommitment)`

```typescript
const committer = agent.functionCommitter(
  (projection) => (projection.voteTotals()['APPROVE'] ?? 0) >= 2,
  async (projection) => ({
    action: 'decided',
    authorityScope: 'team',
    reason: `winner=${projection.majorityWinner()}`,
  }),
);
```

### `majorityCommitter({ quorumSize?, action?, authorityScope? })`

Prebuilt — commits when the projection's majority winner has at least
`quorumSize` votes. Defaults: `quorumSize = 1`, `action = 'commit'`,
`authorityScope = 'session'`.

```typescript
participant.on('Vote', commitmentHandler(majorityCommitter({
  quorumSize: 3,
  action: 'deploy',
  authorityScope: 'production',
})));
```

## Class form vs function form

Both produce the same strategy type — pick the one your codebase prefers.

```typescript
// Class form — convenient when the strategy has shared state or helpers.
class ThresholdVoter implements VotingStrategy {
  constructor(private readonly minConfidence: number) {}
  shouldVote(projection: DecisionProjection) {
    return projection.evaluations.every((e) => e.confidence >= this.minConfidence);
  }
  async decideVote(projection: DecisionProjection) {
    return { vote: 'APPROVE', reason: 'all evaluators confident' };
  }
}

// Function form — zero ceremony for stateless rules.
const voter = agent.functionVoter(
  (projection) => projection.evaluations.every((e) => e.confidence >= 0.8),
  async () => ({ vote: 'APPROVE', reason: 'all evaluators confident' }),
);
```

## Full worked example

See [`examples/agent-policy-aware.ts`](../../examples/agent-policy-aware.ts)
for a `Participant` that uses `functionEvaluator` + `functionVoter` against a
live runtime.

## Related

- [`docs/guides/agent-framework.md`](../guides/agent-framework.md) — `Participant` + handler registration
- [`docs/modes/decision.md`](../modes/decision.md) — the mode these strategies target
- [`docs/api/projections.md`](./projections.md) — `DecisionProjection` query helpers used by strategies
