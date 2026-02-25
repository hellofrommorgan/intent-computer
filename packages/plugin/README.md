# @intent-computer/plugin

Session-time runtime for the intent computer. When a user opens an agentic CLI (OpenCode, Claude Code), this plugin runs the five-layer intent loop: perception, identity, commitment, memory, execution. It maps OpenCode plugin events to `HolisticIntentComputerRuntime` from `@intent-computer/architecture`.

The intent loop fires at session bookends:
- **`system.transform`** (first call) — `startSession` + `processIntent` produces the system prompt
- **`session.deleted`** — `endSession` persists state

Everything between those bookends — skill routing, write validation, auto-commits — runs as hooks and skills within the session.

## Hooks (always-on)

Hooks fire automatically on plugin events. They are not invoked by the user.

| Hook | Trigger | What it does |
|------|---------|--------------|
| **write-validate** | After every file write | Checks YAML frontmatter: requires `description` and `topics`, rejects description-as-title restatements, enforces kebab-case filenames |
| **auto-commit** | After every note write | Stages and commits vault changes async. Non-blocking, failures swallowed. Message format: `auto: update N note(s) — [filenames]` |
| **session-capture** | Session end | Saves session metadata (title, diff summary, timestamps) to `ops/sessions/` and commits |
| **session-continuity** | Session end | Diffs changed `.md` files since session start, calls LLM to regenerate `working-memory.md`, commits |

## Skills and the SKILL.md pattern

Skills are markdown files, not code. A `SKILL.md` is a cultural artifact — it programs the LM through language, not instructions. The plugin loads the skill text and injects it into the system prompt as active context.

**Dispatch chain:** user types `/surface` (or natural language equivalent) -> **router** detects the skill name -> **injector** loads `skill-sources/reflect/SKILL.md` -> content is injected via `system.transform` -> the LM executes the skill behaviorally.

The router reads `ops/derivation-manifest.md` for domain-renamed command vocabulary (e.g., `/arscontexta:surface`), falling back to canonical names.

### Skill sources (17 SKILL.md definitions)

| Category | Skills |
|----------|--------|
| Thought pipeline | `reflect`, `verify`, `validate`, `reweave`, `reanalyze` |
| Knowledge growth | `seed`, `learn`, `reduce` |
| Orchestration | `process`, `pipeline`, `ralph` (batch orchestrator) |
| System evolution | `remember`, `rethink`, `refactor` |
| Operational queries | `graph`, `stats`, `next`, `tasks` |

### Code-level skills

| Skill | Role |
|-------|------|
| **router** | Command detection — slash commands, natural language triggers, mixed input |
| **injector** | Loads SKILL.md content, replaces vocabulary placeholders, wraps in `=== ACTIVE SKILL ===` |
| **ralph** | Programmatic orchestrator for batch processing (runs `process` pipeline) |
| **fork** | Isolated skill execution in a separate session (approximates Claude Code's `context: fork`) |

## Adapters

The architecture package defines abstract ports. This package provides local filesystem implementations:

| Adapter | Port | Responsibility |
|---------|------|----------------|
| `LocalPerceptionAdapter` | PerceptionPort | Reads vault state, detects changes |
| `LocalIdentityAdapter` | IdentityPort | Loads identity, goals, working memory, morning brief |
| `LocalCommitmentAdapter` | CommitmentPort | Reads commitment/condition state |
| `LocalMemoryAdapter` | MemoryPort | Vault read/write, thought retrieval |
| `LocalExecutionAdapter` | ExecutionPort | Action execution against the filesystem |
| `LocalPipelineAdapter` | PipelinePort | Task queue management |

Additional adapter directories (`claude-code/`, `openclaw/`, `pi-dev/`) contain client-specific implementations.

## Plugin vs Heartbeat

| | Plugin | Heartbeat |
|-|--------|-----------|
| **When** | During interactive sessions | Between sessions (launchd, every 15 min) |
| **Trigger** | User opens CLI | Cron schedule |
| **Loop** | Full five-layer intent loop | Commitment evaluation + condition checks |
| **Output** | System prompt, skill execution, vault writes | Morning brief, queue task triggers, working memory updates |
| **Agency** | Reactive to user interaction | Autonomous within configured autonomy levels |

## Dependencies

- `@intent-computer/architecture` — runtime, ports, event system, queue utilities
- `@opencode-ai/plugin` (peer) — plugin interface and event types
