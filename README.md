# intent-computer

The bicycle for the mind, ported to opencode. intent-computer is an `@opencode-ai/plugin` package that implements the ars-contexta knowledge system — giving opencode sessions persistent memory, schema enforcement, and a full library of thinking skills that survive across sessions. It turns the gap between knowing and doing into a closed loop: vault context injected at session start, notes validated on write, sessions captured on exit, and working memory updated automatically so the next session starts knowing who you are and what you were doing.

## What it does

Two layers — hooks that run automatically, and skills you invoke on demand.

### Hooks (always-on)

| Hook | Trigger | What it does |
|------|---------|--------------|
| `sessionOrient` | Every LLM call, and after context compaction | Injects vault structure, working-memory.md, morning-brief.md, goals.md, and identity.md into the system prompt. Also surfaces maintenance conditions (inbox pressure, orphan count, unprocessed sessions). |
| `writeValidate` | After every `write` tool call on a vault note | Validates YAML frontmatter: presence of `description` and `topics` fields, description length, description not identical to title. Warnings are appended to the write output so the model sees them immediately. |
| `autoCommit` | After every `write` tool call on a vault note (async, non-blocking) | Stages the changed note plus `self/`, `ops/`, and `inbox/`, then commits. Vault history stays clean without manual git. |
| `sessionCapture` | On `session.deleted` | Writes session metadata JSON to `ops/sessions/` and commits the artifact. |
| `sessionContinuity` | On `session.deleted` (async) | Calls an LLM to review what changed during the session and update `self/working-memory.md`. Next session starts warm. |

All hooks are vault-scoped. They short-circuit immediately if the current worktree is not a vault (detected via `.arscontexta` marker, `ops/config.yaml`, or legacy `.claude/hooks/session-orient.sh`).

### Skills (invoked on demand)

Skills are SKILL.md instruction files — structured prompts the model follows when you invoke a command. Two categories:

**skill-sources/** — operational skills for working with your vault: `reduce`, `reflect`, `reweave`, `verify`, `validate`, `seed`, `ralph`, `pipeline`, `tasks`, `stats`, `graph`, `next`, `learn`, `remember`, `rethink`, `refactor`.

**plugin-skills/** — system management: `setup`, `help`, `health`, `ask`, `recommend`, `architect`, `add-domain`, `reseed`, `tutorial`, `upgrade`.

Skills use `{vocabulary.*}` placeholders resolved from `ops/derivation-manifest.md`, so the same skill works in vaults with different domain vocabularies (`thoughts/` vs `notes/` vs `claims/`).

## Installation

Add to your vault's `opencode.json`:

```json
{
  "plugin": ["intent-computer"]
}
```

Install the package:

```bash
npm install intent-computer
# or: npx intent-computer (once published)
```

If you don't have a vault yet, run `/setup` inside opencode after installing. It walks you through the derivation conversation and generates your full vault structure.

## Skill sync

Skills live in the package's `src/skill-sources/` and `src/plugin-skills/` directories. The sync script deploys them to your vault and registers them as opencode commands:

```bash
npm run sync
# or with a custom vault path:
node scripts/sync-skills.js ~/path/to/vault
# preview what would sync without writing:
node scripts/sync-skills.js --dry-run
```

What it does:
- Copies each `SKILL.md` to `{vault}/.opencode/skills/{name}/SKILL.md`
- Generates command stubs at `{vault}/.opencode/commands/{name}.md` and `~/.config/opencode/commands/{name}.md`
- Skips any skill with `status: stub` or `status: TODO` in frontmatter

After sync, skills appear in the opencode command picker as `/arscontexta:{name}`.

## Requirements

- opencode (latest)
- Node.js 18+
- Git (for auto-commit hook)
- qmd (optional — enables semantic search via MCP; configured by `/setup` if present)
- A vault initialized with `/setup` or the ars-contexta system

## Architecture

### Vault detection

`vaultguard.ts` checks for `.arscontexta` marker, `ops/config.yaml` (auto-creates the marker for migration), or legacy `.claude/hooks/session-orient.sh`. Every hook calls `isVault()` on the worktree path and returns immediately if no vault is detected. This means the plugin is safe to install globally — it's a no-op in non-vault projects.

### Hooks vs skills

Hooks are TypeScript functions wired to opencode's plugin event system in `src/index.ts`. They run transparently — no invocation needed. Skills are instruction files the model reads and follows when you invoke a command; they are not TypeScript code.

### Vocabulary substitution

Skills reference placeholders like `{vocabulary.notes}` and `{vocabulary.reduce}`. At runtime, `src/skills/injector.ts` reads `ops/derivation-manifest.md` from the active vault and substitutes these before the skill instructions reach the model. This is what makes one skill package serve vaults with different domain vocabularies.

### Note path detection

`isNotePath()` in `vaultguard.ts` recognizes note writes by path segment: `/thoughts/`, `/notes/`, `/thinking/`, `/claims/`. Write validation and auto-commit only fire for paths matching these segments. Custom vocabulary paths are resolved via `ops/derivation-manifest.md` after setup.

### Holistic runtime

The repository includes a domain-first architecture module and a live plugin runtime wiring for the full intent computer loop (perception -> identity -> commitment -> memory -> execution):

- `packages/architecture/src/domain.ts`
- `packages/architecture/src/ports.ts`
- `packages/architecture/src/intent-loop.ts`
- `packages/architecture/src/holistic-runtime.ts`
- `packages/architecture/src/mcp-contracts.ts`
- `packages/architecture/src/saas-contracts.ts`
- `packages/architecture/src/queue.ts`
- `docs/HOLISTIC-ARCHITECTURE.md`

Runtime behavior now includes:
- Per-turn intent ingestion from chat/commands (no hardcoded actor or static intent text)
- Execution dispatch with policy gates via `ops/runtime-policy.json`
- Canonical queue schema migration (`version: 1`) across plugin, MCP server, and heartbeat
- Runtime cycle logs at `ops/runtime/cycles/*.json` and session events at `ops/runtime/session-events.jsonl`

### Data feed scaffold

The repository also includes an additive `packages/plugin/src/data-feed/` scaffold for ingesting external activity (browser history, email, webhook sources) into vault inbox artifacts without changing current hooks/runtime:

- contracts + canonical event model
- cursor/checkpoint runtime
- policy layer (allowlist + sensitivity + redaction)
- vault inbox sink
- local Chrome history connector (safe SQLite snapshot read)
- Gmail / Microsoft Graph / IMAP connector stubs with incremental-sync cursor semantics
- research/design notes in `docs/DATA-FEED-RESEARCH.md`

## Development

```bash
# Build TypeScript
npm run build

# Type check without emitting
npm run typecheck

# Watch mode
npm run dev

# Sync skills to ~/Mind vault
npm run sync

# Sync to a different vault
node scripts/sync-skills.js ~/path/to/test-vault

# Dry-run — see what would sync
node scripts/sync-skills.js --dry-run

# Runtime + queue + heartbeat integration checks
npm run test:runtime

# Heartbeat with aligned-task execution (runner command receives task context via env vars)
node packages/heartbeat/dist/index.js --vault ~/Mind --execute-aligned --runner-cmd "./ops/scripts/heartbeat-runner.sh"
```

To test hooks against a real vault, open the vault directory in opencode with the plugin installed. Session orient fires on every LLM call; write validate fires whenever you ask the model to write a note.
