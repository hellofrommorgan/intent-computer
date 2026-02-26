# PRINCIPLES.md

Coding principles for the intent-computer project. Every rule here is observable in the existing codebase. If something isn't followed in practice, it doesn't belong in this document.

---

## Philosophy

This codebase implements a cognitive architecture as a feedback loop: perceive the world, identify gaps between desired and actual state, propose actions, execute them. The code values **graceful degradation** over correctness guarantees, **data types as documentation** over runtime validation, and **small composable modules** over frameworks. Nothing should block the user's session if it fails.

---

## Architecture

### Layer Model

Five layers, each behind a port interface defined in `packages/architecture/src/ports.ts`:

| Layer | Port | Responsibility |
|---|---|---|
| Perception | `PerceptionPort` | Read the world, emit signals and gaps |
| Identity | `IdentityPort` | Resolve who the actor is and what they care about |
| Commitment | `CommitmentPort` | Decide what to protect and what to compress |
| Memory | `MemoryPort` | Hydrate relevant context from the knowledge graph |
| Execution | `ExecutionPort` | Propose actions, optionally execute them |

Each layer receives the accumulated output of all previous layers. The pipeline is sequential and additive — `CommitmentPlanningInput` includes session, intent, perception, AND identity. See `ports.ts` for the full threading pattern.

### Package Boundaries

- **`@intent-computer/architecture`** — Types, ports, pure domain logic, and shared utilities. Zero runtime dependencies beyond Node builtins. This is the contract layer.
- **`@intent-computer/plugin`** — Adapter implementations that fulfill the port interfaces. Depends on `architecture`. Contains all filesystem I/O and external tool calls.
- **`@intent-computer/heartbeat`** — Between-session autonomy. Depends on `architecture`. Runs on a schedule, reads vault state, triggers aligned work.

The dependency arrow is one-way: `plugin` and `heartbeat` depend on `architecture`, never the reverse. Adapters import types from `@intent-computer/architecture`; architecture never imports from adapters.

### Barrel Exports

Each package re-exports through `src/index.ts`. All public types, interfaces, and functions are listed there explicitly. See `packages/architecture/src/index.ts` — every module gets a `export * from "./module.js"` line.

Import from the package name, not from internal paths:

```typescript
// Yes
import type { PerceptionPort, PerceptionSignal } from "@intent-computer/architecture";

// No
import type { PerceptionPort } from "@intent-computer/architecture/src/ports.js";
```

---

## Type Design

### String Literal Unions Over Enums

Every categorical value is a string literal union type. No TypeScript enums exist in this codebase.

```typescript
// This pattern — always
export type ConfidenceBand = "low" | "medium" | "high";
export type ActionAuthority = "none" | "advisory" | "delegated" | "autonomous";

// Never enums
```

This keeps types serializable as plain JSON with no runtime overhead.

### Branded Primitives as Type Aliases

Semantic types like `ID` and `ISODateTime` are aliases for `string`. They exist for documentation, not enforcement:

```typescript
export type ID = string;
export type ISODateTime = string;
```

### Interface Shape Conventions

- **PascalCase** for type names and interfaces.
- **camelCase** for all field names and function names.
- Required fields first, optional fields (with `?`) last.
- `metadata` bags are typed as `Record<string, string | number | boolean>` — not `unknown`, not `any`.
- Timestamps are always `ISODateTime` (ISO 8601 string), never `Date` objects.

### Where Types Go

All domain types live in `packages/architecture/src/domain.ts`. Port interfaces live in `ports.ts`. Adapter-specific types (like `LocalExecutionPolicy`) are defined in the adapter file that uses them.

When adding a new type:
- If it's part of the domain contract (used across layers), put it in `domain.ts`.
- If it's adapter-specific (only one implementation uses it), co-locate it with the adapter.
- Group related types with section headers: `// ─── Metabolic Rate ──────────────────────────────────────────────────────────`

---

## Module Design

### Small Focused Modules

Each module does one thing. `metabolic.ts` measures metabolic rate. `triggers.ts` runs the quality trigger battery. `desired-state.ts` compares actual metrics against targets. A module typically exports 1-3 public functions.

### Function Exports Over Classes

Most modules export plain async functions, not classes. Classes are used only when state needs to be held across method calls — `IntentLoop` holds its layer references, `LocalPerceptionAdapter` holds its vault root and options. If your module is stateless, export functions.

```typescript
// Stateless — export functions (metabolic.ts)
export async function measureMetabolicRate(vaultRoot: string): Promise<MetabolicReport> { ... }

// Stateful — class with constructor injection (local-perception.ts)
export class LocalPerceptionAdapter implements PerceptionPort {
  constructor(vaultRoot: string, options: LocalPerceptionOptions = {}) { ... }
}
```

### Error Handling: Try/Catch + Fallback

The dominant pattern is: try the operation, catch everything, return a safe default. Errors are logged to stderr, never thrown to callers unless the operation is foundational.

```typescript
// Pattern 1: Return safe default (most common)
try {
  const metabolicReport = await measureMetabolicRate(this.vaultRoot);
  // ... use it
} catch (err) {
  console.error("[perception] metabolic rate measurement failed:", err);
}

// Pattern 2: Return null for "not available"
private safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// Pattern 3: Config loading always returns a valid default
if (!existsSync(path)) return { ...DEFAULT_THRESHOLDS };
try {
  // parse...
} catch {
  return { ...DEFAULT_THRESHOLDS };
}
```

The intent-loop-runner takes this further: the entire run returns `null` on any failure, and errors are logged to a file rather than propagated. The session hook must never block.

### Async Conventions

- Use `async/await` throughout, never raw `.then()` chains.
- For child processes, promisify `execFile`: `const execFileAsync = promisify(execFile)`.
- For time-critical paths, use `Promise.race` with timeout: see `intent-loop-runner.ts` where each layer gets an individual timeout.

---

## Feedback Loops

### The Core Chain: Measurement → Gap → Proposal → Action

Perception measures the world and produces signals and gaps. Gaps flow to execution planning where `gapToAction()` maps each gap label to a concrete action proposal. Proposals get filtered by policy and authority level before execution.

To add a new feedback signal:

1. **Measure it** in the perception adapter (`local-perception.ts`). Create a `PerceptionSignal` with a channel name and metadata.
2. **Detect the gap** — if the measurement exceeds a threshold, push a `DetectedGap` with a unique label string.
3. **Map the gap** — add an entry in `local-execution.ts`'s `gapToAction()` record that maps your gap label to an `ActionKey` and authority level.
4. **Handle it** — if the action is auto-executable, add a dispatch handler in `LocalExecutionDispatch`.

The `desired:*` prefix pattern in `gapToAction()` shows how to handle families of related gaps with a prefix match.

### Signal Capping

Perception caps signals per channel to prevent noise from drowning useful information. `MAX_SIGNALS_PER_CHANNEL = 3` — when a channel produces more, the adapter emits the first 3 plus a summary signal with the total count. See `capChannelSignals()`.

### Advisory by Default

Most actions are `"advisory"` — they surface recommendations without executing. The execution policy (`ops/runtime-policy.json`) controls which `ActionKey` values are auto-executed. Default: only `process_queue` and `process_inbox` are auto-execute. Everything else requires explicit opt-in.

When identity drift is detected, all non-core actions are escalated to require permission.

---

## Adapter Patterns

### Constructor Takes Vault Root

Every adapter's constructor takes `vaultRoot: string` as its first argument. Additional configuration comes through an options object with defaults:

```typescript
constructor(vaultRoot: string, options: LocalPerceptionOptions = {}) {
  this.vaultRoot = vaultRoot;
  this.options = { recordTriggerHistory: true, ...options };
}
```

### Missing Files and Directories

Always guard with `existsSync()` before reading. Return empty arrays or null for missing content, never throw:

```typescript
private listDir(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f: string) => f.endsWith(ext));
  } catch {
    return [];
  }
}
```

### Config Loading Pattern

Configuration is loaded from the vault's `ops/` directory with three-tier fallback:

1. Try to read the config file from the expected path.
2. Parse with a lenient parser (the YAML parser in `ops-config.ts` handles scalars only, no dependencies).
3. Fall back to `DEFAULT_*` constants on any failure.

The config parser is hand-rolled to avoid YAML library dependencies. See `parseYamlScalars()` in `ops-config.ts`.

### Time-Budgeted Orchestration

The intent-loop-runner in `packages/plugin/src/adapters/claude-code/intent-loop-runner.ts` demonstrates the pattern for running the full pipeline under a hard timeout:

- Total budget: 12 seconds (under a 30-second hook timeout).
- Each layer gets an individual `Promise.race` with a per-layer timeout.
- Memory hydration is optional — skipped if 8+ seconds have elapsed.
- Execution is advisory-only at session start (no `execute()` call).
- The entire runner returns `null` on any failure. Never throws.

### Fresh-Context Isolation (Fork Pattern)

When autonomous work needs inference (Claude CLI calls), it runs in a forked process to prevent context contamination. The heartbeat module spawns Claude with specific prompts and reads stdout. This keeps the main process's state clean.

---

## Formatting & Style

### Section Headers

Major sections within a file use this exact comment style:

```typescript
// ─── Section Name ──────────────────────────────────────────────────────────
```

The line is built with em-dash characters (`─`), not hyphens. Used in `domain.ts`, `local-perception.ts`, `triggers.ts`, `heartbeat.ts`, and throughout. Every perception channel block, every group of related functions, every logical section gets one.

### Module-Level JSDoc

Each file opens with a JSDoc block describing what the module does and its role in the system:

```typescript
/**
 * metabolic.ts — Vault metabolic rate tracking
 *
 * Queries git history to calculate write rates per vault space (self/, thoughts/,
 * ops/) and detects anomalies like identity churn, pipeline stalls, or system
 * disuse.
 */
```

Individual functions get JSDoc only when the signature isn't self-documenting. Inline comments explain "why", not "what."

### Naming Conventions

- **Files**: `kebab-case.ts` — `local-perception.ts`, `intent-loop-runner.ts`, `graph-links.ts`.
- **Types/Interfaces**: `PascalCase` — `PerceptionSignal`, `DetectedGap`, `MetabolicReport`.
- **Functions**: `camelCase` — `measureMetabolicRate`, `runTriggerBattery`, `loadMaintenanceThresholds`.
- **Constants**: `SCREAMING_SNAKE_CASE` for module-level constants — `MAX_SIGNALS_PER_CHANNEL`, `TOTAL_BUDGET_MS`, `DEFAULT_POLICY`.
- **Private helpers**: prefixed with nothing special; they're just `private` methods on classes or unexported functions in modules.

### File Organization

Files follow this order:

1. Module JSDoc
2. Imports (architecture package first, then relative imports, then Node builtins)
3. Module-level constants
4. Helper types (unexported interfaces used only in this file)
5. Private/helper functions
6. Exported functions or class
7. (Optional) secondary exports at the bottom

### TypeScript Configuration

- Target: `ESNext`
- Module: `ESNext` with `bundler` resolution
- `strict: true` — always
- All imports use `.js` extension (ESM convention): `import { foo } from "./bar.js"`
- No default exports. Everything is named.

### Import Style

`type` imports use the `import type` form consistently:

```typescript
import type { PerceptionPort, PerceptionSignal } from "@intent-computer/architecture";
import { loadMaintenanceThresholds, scanVaultGraph } from "@intent-computer/architecture";
```

Type-only imports are separated from value imports even when they come from the same package.

---

## Anti-patterns

**No YAML library dependencies for config.** The codebase hand-rolls a scalar-only YAML parser rather than pulling in `js-yaml` or similar. If you need to parse YAML, extend `parseYamlScalars()`.

**No thrown errors for recoverable failures.** If a file doesn't exist, a directory is missing, or a parse fails — return a default. Throwing is reserved for genuine programming errors (like invalid state transitions in the commitment engine).

**No `any` types.** The codebase uses `Record<string, unknown>` for unstructured data and typed records (`Record<string, string | number | boolean>`) for metadata bags. The few places `any` appears are in frontmatter parsing where YAML values are genuinely untyped — and even those are being migrated.

**No default exports.** Every export is named. Barrel files use `export * from`.

**No enums.** String literal union types only. See Type Design above.

**No framework dependencies in architecture.** The `architecture` package has zero external dependencies. It uses only Node builtins (`fs`, `path`, `crypto`). Adapter packages can pull in libraries as needed.

**No blocking operations in hooks.** Session-start and session-end hooks must complete within their timeout budget. Any operation that might be slow (inference, network calls, large file scans) gets a `Promise.race` timeout wrapper. If it doesn't finish in time, skip it.

**No mutation of input parameters.** Functions receive data and return new data. The one exception is `recordStateTransition()` in the commitment engine, which mutates in place — and it's documented as doing so.
