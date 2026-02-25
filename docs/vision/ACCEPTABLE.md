# Acceptable

> This is the feature evaluation framework for the intent computer. For the principles these evaluations are grounded in, see [methodology/zeroth-principles.md](../../methodology/zeroth-principles.md). For the architecture they must conform to, see [methodology/architecture.md](../../methodology/architecture.md). For the design tensions they must navigate, see [methodology/design-tensions.md](../../methodology/design-tensions.md).

What kinds of features, contributions, and architectural changes belong in the intent computer — and what do not.

Linguistic precision matters here. **Never** means non-negotiable. **Required** means mandatory for all contributions. **Preferred** means strong opinion that can be overridden with evidence. **Acceptable** means welcome without justification.

---

## Acceptable Features

Contributions in these areas are welcomed. No justification required beyond quality.

| Category | Examples | Notes |
|----------|----------|-------|
| New skills as SKILL.md files | Processing skills, analysis skills, domain-specific extraction | Skills are the primary extension point. Keep them as markdown. If it can be a skill, it must be a skill. |
| Vault adapter implementations | Cloud storage adapter, S3 adapter, SQLite cache | Must implement existing port interfaces. Files remain canonical. The adapter is a transport layer, not a storage layer. |
| Heartbeat condition checks | New maintenance conditions, new threshold types | Must follow condition-based pattern, not time-based. A condition fires when something is true, not when the clock says so. |
| Processing pipeline improvements | Better quality gates, new verification checks, pipeline metrics | Must not bypass the pipeline. No direct writes to thoughts/. Quality gates are additive — you can tighten, never loosen. |
| Hook implementations | New lifecycle hooks for session events | Must be deterministic. Hooks enforce invariants; skills suggest actions. A hook that sometimes fires is a bug. |
| Evaluation metrics | Thought impact measurement, skill effectiveness, vault health scores | Start with simple heuristics. If you need a training set, you are premature. |
| Computer use action patterns | New action types for file-as-proposal flow | Must go through the proposal flow. Every action is a file before it is an effect. |
| Context compression techniques | Better skill loading, tighter perception bounds, smarter context selection | Context is computation. Wasting tokens is wasting compute. Improvements here multiply everything else. |
| Error surfacing improvements | Better drift detection, richer failure descriptions, new friction signals | Error is signal (Z5). Making failures more visible is always welcome. |
| Test infrastructure | Integration tests, skill evaluation harnesses, vault health assertions | Preferred: tests that validate the protocol, not the implementation. |

## Unacceptable Features (Never)

These violate core principles. No amount of user demand or evidence changes them without changing the principles first.

| Category | Why Not | Principle Violated |
|----------|---------|-------------------|
| Vector database as primary storage | Files are canonical. Vector search is a read-only cache, rebuildable from files. If the vector DB dies, nothing is lost. If the files die, everything is. | Z4 (compression), Alignment (files as power-equalizing substrate) |
| Agent hierarchy frameworks | Manager-of-managers, nested planner trees, orchestration graphs. Skills compose via filesystem. Coordination is peer-to-peer, not command-and-control. | Z4 (compression), Z3 (relation over representation) |
| GUI that hides the filesystem | The filesystem IS the interface. A GUI that mediates access breaks human-agent equality on the file substrate. GUIs that surface the filesystem are fine. GUIs that replace it are not. | Alignment, Z2 (context is the computer) |
| Auto-generated intents | The system never generates its own reasons to act. The bicycle does not pedal itself. A heartbeat that always acts is a cron job, not temporal autonomy. | Z0 (intentionality precedes computation) |
| Capability-gated features | Features that only work with specific models. If the architecture depends on GPT-5 features or Claude-specific tooling, we papered over the steerability gap instead of closing it. | The steerability bet |
| Suppressing error signals | Auto-fixing validation warnings, silencing failed actions, hiding drift detection, swallowing exceptions to keep pipelines "clean." | Z5 (error is signal, not noise) |
| Bypassing the processing pipeline | Direct writes to thoughts/ that skip surface/reflect/verify. No shortcuts. Quality compounds; sloppiness compounds faster. | Discovery-first design, pipeline integrity |
| Multi-tenant architectures | The trust model is personal assistant — one trusted operator, one vault, one identity. Shared buses, permission matrices, and role hierarchies belong to a different system. | Z1 (identity precedes capability) |
| Compressing constitutive friction | Automating away gaps that are load-bearing. The pilgrimage is not a bug in the transportation system. Some distance between intent and outcome is the point. | Z4 (compression requires understanding what to compress) |
| Capability scaling as strategy | Bigger models, more tools, longer contexts as the answer to architectural problems. Never trade coupling quality for raw power. | The steerability bet, Z4 |

## Conditional Features (Not Now, Maybe Later)

Premature today. Each has a specific condition that makes it appropriate.

| Category | When It Becomes Acceptable | Current Status |
|----------|---------------------------|----------------|
| Autonomous authority as default | When the commitment engine demonstrates judgment across 100+ cycles with measurable restraint metrics | Advisory is default. Escalation is earned. |
| Economic agency | When trust architecture is proven and authority escalation is demonstrated end-to-end | No economic primitives. The system does not transact. |
| Cross-vault federation | When single-vault architecture is proven stable and a sync protocol is designed from first principles | Single vault only. One identity, one graph. |
| Real-time computer use | When file-as-proposal trust architecture is proven for planned actions across diverse action types | Planned actions only. Every effect is a proposal first. |
| ML-based evaluation | When simple heuristic evaluation has a baseline, known failure modes, and at least 6 months of data | Heuristic only. If you need a training set, you are premature. |
| Streaming perception | When bounded perception (3 signals/channel) is proven and the attention budget model is validated | Polling with conditions. Not event streams. |
| Plugin marketplace | When the skill format is stable, versioned, and the quality bar is enforceable without manual review | Skills are local. No distribution mechanism yet. |

## Architectural Non-Negotiables (Required)

Flat declarations. These are load-bearing. Removing any one collapses the system into a different kind of thing.

- **Files are canonical.** Everything else — databases, indices, caches — is derivative and rebuildable from files. This is not a simplicity preference. It is an alignment requirement. The file substrate equalizes human and agent access to system state.

- **Skills are markdown.** Not Python modules, not TypeScript classes, not YAML configs. Markdown files interpreted by language models. Skills are tuning forks, not programs. A skill that requires a specific runtime has failed at compression.

- **Propositions, not entities.** The unit of knowledge is the titled claim. Not the named entity, not the keyword, not the embedding vector. "Morning routine breaks the inertia" is knowledge. "Morning routine" is a label. Labels are not knowledge. Propositions connect via typed, contextual wiki links.

- **Authority defaults to advisory.** The system proposes, the human decides. Escalation to delegated or autonomous authority is earned through demonstrated judgment, never assumed, always revocable.

- **Context budget is finite.** Every token in the context window has a cost. Skills are loaded on-demand. Perception is bounded (3 signals per channel max). Context is computation — waste it and you waste compute. Preferred: smaller context with higher relevance over larger context with lower relevance.

- **The pipeline is mandatory.** Raw input enters inbox, passes through surface/reflect/revisit/verify, exits as structured thought. No shortcuts. No "quick add." No "I'll process it later." The pipeline is how quality compounds.

- **The heartbeat is judgment, not automation.** Between-session processing must demonstrate restraint. A heartbeat that always acts is a cron job. A heartbeat that acts when conditions warrant and stays silent otherwise is temporal autonomy. The difference is Z0.

- **Constitutive friction is protected.** The system must distinguish gaps worth compressing from gaps worth preserving. Compressing a constitutive gap destroys value. This requires a model of the human sophisticated enough to know the difference — and the restraint to act on it.

- **Error is signal.** Failures, friction, drift, and surprise carry information. The system surfaces them, names them, and learns from them. Suppression is never acceptable. A clean log is not a sign of health — it is a sign of blindness.

- **Identity is singular.** One vault, one operator, one identity graph. The system knows who it serves. Multi-tenancy, shared contexts, and role-switching are architectural violations, not missing features.

## How to Evaluate a Proposed Feature

Before proposing a code change, run this checklist. If any answer disqualifies, stop.

| # | Question | Disqualifying Answer |
|---|----------|---------------------|
| 1 | Does it trace to a human intent? | No — violates Z0. The system acts only when someone wants something. |
| 2 | Does it respect identity constraints? | No — violates Z1. Features that assume multiple operators or shared state do not belong. |
| 3 | Does it improve context quality, not just quantity? | Quantity only — violates Z2. More tokens without better relevance is waste. |
| 4 | Is it relational or representational? | Representational only — reconsider via Z3. Hardcoded structures are brittle. |
| 5 | Does it compress or accumulate? | Accumulates — violates Z4. Each evolution must simplify while expanding capability. |
| 6 | Does it surface errors or suppress them? | Suppresses — violates Z5. Non-negotiable. |
| 7 | Does it work between sessions or only within them? | If it should work between sessions but does not, it is incomplete. Consider Z6. |
| 8 | Does it keep files as canonical state? | No — non-negotiable. Files are the substrate. |
| 9 | Does it preserve human agency over system state? | No — non-negotiable. The bicycle does not pedal itself. |
| 10 | Could it be a skill instead of a code change? | Yes — write a skill. Skills are the primary extension point. Code changes are for infrastructure that skills cannot provide. |

The burden of proof is on the proposer. "It would be useful" is not sufficient. "It would be useful, it traces to Z0, and it cannot be a skill" is the minimum bar.

## Preferred Patterns

Strong opinions, weakly held. Override with evidence, not preference.

| Pattern | Preferred | Acceptable | Never |
|---------|-----------|------------|-------|
| Extension mechanism | SKILL.md file | Hook script | Runtime plugin, dynamic module loading |
| State storage | Markdown + YAML frontmatter | JSON sidecar files | Database tables, binary formats |
| Inter-agent communication | Filesystem (shared directories) | Structured file protocol | Message queues, RPC, shared memory |
| Configuration | YAML in ops/config.yaml | Environment variables | GUI settings panels, database config |
| Scheduling | Condition-based (when X is true) | Hybrid (conditions + minimum intervals) | Pure cron (every N minutes) |
| Error handling | Surface and name the error | Log and retry with backoff | Swallow, auto-fix, or suppress |
| Testing | Protocol-level integration tests | Unit tests on pure functions | Mocked-everything unit tests |
| Dependencies | Zero or vendored | Minimal, pinned | Framework-level, version-ranged |
