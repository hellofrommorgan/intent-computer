# @intent-computer/architecture

The contract layer for the intent computer. This package defines every domain type, port interface, and store contract that other packages implement against. It imports nothing from the rest of the monorepo. If it's not defined here, it's not part of the shared vocabulary.

## What's in here

### Domain types (`domain.ts`)

The core nouns of the system, organized around the five-layer cognitive loop:

- **IntentRequest** / **SessionFrame** -- what the actor wants, and the session context it arrives in
- **PerceptionSnapshot** / **PerceptionSignal** / **DetectedGap** -- what the system observes about the world
- **IdentityState** / **IdentityDriftState** -- the actor's self-model, priorities, and drift detection
- **Commitment** / **CommitmentPlan** -- what the actor has committed to, and the engine's plan for advancing it
- **MemoryContext** / **Proposition** / **PropositionLink** -- the knowledge graph: atomic thoughts and their connections
- **ExecutionPlan** / **ActionProposal** / **ExecutionOutcome** -- what the system proposes to do, and what actually happened
- **PipelineTask** / **PipelineQueueFile** -- the processing queue for inbox-to-thought pipelines
- **IntentLoopResult** -- the full cycle output, carrying snapshots from every layer

Plus the type algebra: `CommitmentState`, `ActionAuthority`, `PipelinePhase`, `ConfidenceBand`, `DesireClass`, `FrictionClass`, and other union types that constrain the domain.

### Port interfaces (`ports.ts`)

One port per cognitive layer:

| Port | Method(s) | Layer |
|------|-----------|-------|
| `PerceptionPort` | `capture()` | Perception |
| `IdentityPort` | `resolve()` | Identity |
| `CommitmentPort` | `plan()`, `recordOutcome()` | Commitment |
| `MemoryPort` | `hydrate()`, `record()` | Memory |
| `ExecutionPort` | `propose()`, `execute()` | Execution |

`IntentComputerLayers` bundles all five into a single configuration object. `LifecycleHooksPort` defines session-level callbacks (start, cycle, end). `PipelinePort` handles phase execution for the processing queue.

Ports define **what** the system needs. Adapters (in other packages) define **how** it gets it. This package never contains an adapter.

### Contracts

- **MCP API** (`mcp-contracts.ts`) -- request/response types for every MCP tool: `vault_context`, `inbox_capture`, `thought_search`, `thought_write`, `link_graph`, `queue_push`, `queue_pop`
- **Queue store** (`queue-store.ts`) -- file-based queue with atomic writes and advisory locking
- **Commitment store** (`commitment-store.ts`) -- atomic JSON persistence with lock acquisition, ID derivation, and markdown mirror generation

### Utilities

- `slug.ts` -- deterministic slug generation for filenames
- `frontmatter.ts` -- YAML frontmatter parsing/serialization
- `telemetry.ts` -- telemetry event types
- `evaluation.ts` -- `ThoughtScore` and `EvaluationRecord` for vault health metrics
- `graph-links.ts` -- wiki-link extraction and graph edge utilities

### Intent loop (`intent-loop.ts`)

The `IntentLoop` class is the orchestrator. It threads data through all five layers in sequence: Perception -> Identity -> Commitment -> Memory -> Execution, then records the outcome. It takes an `IntentComputerLayers` bundle and optional `LifecycleHooksPort`.

## Dependency rule

This package has one dev dependency: `@types/node`. That's it. Architecture is the innermost ring -- every other package depends on it, it depends on nothing. If you find yourself wanting to import from `@intent-computer/plugin` or `@intent-computer/mcp-server` here, stop. You're going the wrong direction.

## Build

```
pnpm build    # tsc -> dist/
pnpm typecheck  # type-check without emit
```
