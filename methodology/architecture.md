# Architecture: The Intent Loop and Its Implementation

This document describes the intent computer's architecture — the five-layer loop, its TypeScript implementation, the domain type system, and the heartbeat that extends the loop into temporal autonomy. The architecture is not a design choice — it is the zeroth principles made executable.

---

## The Loop

The intent loop executes in sequence within a single cycle, but the system runs many cycles across time. Each cycle:

```
Perception → Identity → Commitment → Memory → Execution → Record
```

The sequence matters. Perception must fire before identity resolves (you must know what is real before deciding who you are in relation to it). Identity must resolve before commitment plans (you must know who you are before deciding what to pursue). Commitment must plan before memory hydrates (you must know what matters before deciding what to remember). Memory must hydrate before execution proposes (you must have the relevant knowledge before deciding what to do).

After execution, two write-back operations close the loop:
1. **Memory records** the full envelope (perception, identity, commitment, memory, plan, outcome) — this is how the knowledge graph compounds.
2. **Commitment records the outcome** — this is how the commitment engine learns which actions advance which trajectories.

### Implementation (`intent-loop.ts`)

```typescript
class IntentLoop {
  constructor(layers: IntentComputerLayers, hooks?: LifecycleHooksPort)

  async run(input: IntentLoopInput): Promise<IntentLoopResult>
}
```

The `IntentComputerLayers` interface bundles the five ports:

```typescript
interface IntentComputerLayers {
  perception: PerceptionPort;
  identity:   IdentityPort;
  commitment: CommitmentPort;
  memory:     MemoryPort;
  execution:  ExecutionPort;
}
```

The `LifecycleHooksPort` provides optional extension points:
- `onSessionStart(session)` — fires when a session begins (orientation)
- `onIntentCycle(result)` — fires after each cycle completes (observation)
- `onSessionEnd(session, lastCycle)` — fires when a session ends (persistence)

---

## The Domain Types

The type system encodes the philosophy. Every domain concept has a TypeScript representation that constrains implementation to honor the principles.

### Gap Classification

```typescript
type GapClass = "incidental" | "constitutive";
type DesireClass = "thick" | "thin" | "unknown";
type FrictionClass = "constitutive" | "incidental" | "unknown";
```

These types enforce the pilgrimage problem at the type level. Every detected gap between intent and outcome must be classified. The commitment plan separates protected gaps (constitutive — preserve the friction) from compressed gaps (incidental — eliminate the friction). A system that compresses all gaps equally has a type error in its classification.

### Identity

```typescript
interface IdentityState {
  actorId: ID;
  selfModel: string;          // N: normative structure
  umwelt: string[];            // U: what the agent perceives
  priorities: string[];        // ranked intent
  commitments: Commitment[];   // C: what the agent intends across time
  drift?: IdentityDriftState;  // deviation from established identity
  updatedAt: ISODateTime;
}
```

The `drift` field implements identity preservation: the system compares current behavior against established priorities and flags divergence. Drift is not inherently bad — it may represent growth — but unrecognized drift is a Z1 violation.

### Commitment

```typescript
interface Commitment {
  id: ID;
  label: string;
  state: CommitmentState;       // candidate → active → paused → satisfied | abandoned
  priority: number;
  horizon: "session" | "week" | "quarter" | "long";
  desireClass?: DesireClass;    // thick or thin
  frictionClass?: FrictionClass; // constitutive or incidental
}
```

Commitments have a lifecycle (`candidate → active → paused → satisfied | abandoned`) and a temporal horizon. The `desireClass` and `frictionClass` fields ensure the pilgrimage problem is tracked per-commitment, not just per-gap.

### Execution Authority

```typescript
type ActionAuthority = "none" | "advisory" | "delegated" | "autonomous";
```

Four levels, from passive observation to full autonomy. The authority level is itself a commitment — the human's decision about how much to trust the loop. The default is advisory: propose, don't act.

### Propositions (Memory Unit)

```typescript
interface Proposition {
  id: ID;
  vaultId: ID;
  title: string;        // a claim, not a label
  description: string;  // adds information beyond the title
  topics: string[];     // map membership
  confidence?: number;
  sourceRefs?: string[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
```

The unit of memory is propositional. A proposition is a titled claim with evidence and connections — not a fact, not an entity, not a key-value pair. This is the epistemological bet that distinguishes the intent computer's memory from every entity-extraction system.

---

## The Port Interfaces

Each layer is a port — an interface with no implementation details. Adapters implement the port for specific substrates.

| Port | Input | Output | Z-Principle |
|------|-------|--------|-------------|
| `PerceptionPort.capture()` | session + intent | `PerceptionSnapshot` (signals, gaps) | Z2 |
| `IdentityPort.resolve()` | session + intent + perception | `IdentityState` | Z1 |
| `CommitmentPort.plan()` | session + intent + perception + identity | `CommitmentPlan` (active, protected, compressed) | Z0 + Z3 |
| `CommitmentPort.recordOutcome?()` | session + intent + commitment + plan + outcome | void | Z5 |
| `MemoryPort.hydrate()` | session + intent + perception + identity + commitment | `MemoryContext` (propositions, links) | Z4 |
| `MemoryPort.record()` | full envelope (all layers + outcome) | void | Z4 + Z5 |
| `ExecutionPort.propose()` | session + intent + identity + commitment + memory | `ExecutionPlan` (actions) | Z6 |
| `ExecutionPort.execute()` | session + intent + plan | `ExecutionOutcome` (results) | Z5 + Z6 |

Note the accumulation pattern: each layer receives everything the previous layers produced. This is not incidental — it implements the dependency stack. Commitment cannot plan without identity, identity cannot resolve without perception, and so on.

---

## The Heartbeat

The heartbeat is what makes Z6 real. Between sessions, it extends the intent loop into temporal autonomy.

### Condition-Based Triggers

The heartbeat checks vault conditions against thresholds:

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Inbox items | 3+ | Process through pipeline |
| Pending observations | 10+ | Triage and process |
| Pending tensions | 5+ | Resolve conflicts |
| Unprocessed sessions | 5+ | Mine transcripts |
| Orphan thoughts | 5+ | Run reflect to connect |

### Commitment Evaluation

Beyond condition checking, the heartbeat evaluates commitments: are active commitments being advanced? Has the user's behavior diverged from stated goals? Should any commitment be escalated or deprioritized?

### The Capable Silence Principle

The heartbeat's hardest test is restraint. Not every threshold crossing warrants action. Not every observation warrants surfacing. The heartbeat must have sufficient judgment to choose silence when silence serves better — this is Z6's highest expression.

---

## The Processing Pipeline

Raw input enters through an inbox and passes through four phases:

| Phase | Operation | Quality Gate |
|-------|-----------|-------------|
| **Surface** | Extract meaning, name what's there, give it a title that works as a claim | Title passes the composability test: "This thought argues that [title]" |
| **Reflect** | Find connections to existing thoughts, update maps, add wiki links | Every link is propositional (the surrounding prose explains the relationship) |
| **Revisit** | Update older thoughts with new connections (the backward pass) | Older thoughts gain new links without losing existing coherence |
| **Verify** | Check description quality, schema compliance, discoverability | The thought is findable by a future agent who does not know it exists |

The pipeline exists because direct writes skip quality gates. Every thought must pass through the pipeline — this is not bureaucracy but the mechanism by which the knowledge graph maintains its epistemological integrity.

### The Proposition-as-Title Pattern

Every thought is titled as a complete prose sentence that makes a claim — not a topic label. "Morning routine" is a label. "Morning routine breaks the inertia when nothing else does" is a claim. The claim must work as prose when linked: "This connects to [[morning routine breaks the inertia when nothing else does]]." If it doesn't read naturally as prose, the title isn't finished.

---

## The Holistic Runtime

The runtime wraps the intent loop with session management, adapter resolution, and lifecycle hooks. It is the entry point for any substrate:

1. **Session start:** Establish the session frame (actor, worktree, model). Fire `onSessionStart`.
2. **Intent cycle:** For each intent, run the full five-layer loop. Fire `onIntentCycle`.
3. **Session end:** Persist state, update goals, capture session. Fire `onSessionEnd`.

The runtime is intentionally thin. It orchestrates but does not implement. All intelligence lives in the adapters behind the ports. This separation ensures the architecture is substrate-independent: swap the adapters and the same loop runs against a different vault, a different model, a different execution environment.
