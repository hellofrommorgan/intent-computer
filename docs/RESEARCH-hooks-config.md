# Research: Hooks and Config Templates

Source: arscontexta repository (agenticnotetaking/arscontexta)
Date: 2026-02-19

---

## 1. Hooks Analysis

### arscontexta Hook Architecture

arscontexta uses shell scripts as hooks, wired via `hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-orient.sh", "timeout": 10 }],
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          { "type": "command", "command": "write-validate.sh", "timeout": 5 },
          { "type": "command", "command": "auto-commit.sh", "timeout": 5, "async": true }
        ]
      }
    ],
    "Stop": [{ "type": "command", "command": "session-capture.sh", "timeout": 15 }]
  }
}
```

Three hooks fire on: SessionStart (orient), PostToolUse/Write (validate + commit), Stop (capture).

### arscontexta Hook Scripts — Behavior Summary

**vaultguard.sh**
- Primary: detects `.arscontexta` marker file at repo root. Exit 0 = vault, exit 1 = not vault.
- Fallback: auto-migrates legacy vaults (ops/config.yaml or .claude/hooks/ present) by writing the marker.
- All other hooks call this first and bail on non-zero exit. This prevents firing in random repos.

**session-orient.sh**
- Outputs markdown injected into the system prompt.
- Shows vault directory tree (3 levels, .md files only, using `tree` or `find` fallback).
- Reads `ops/sessions/current.json` (previous session state).
- Reads `self/goals.md` OR `ops/goals.md` (fallback).
- Reads `self/identity.md` + `self/methodology.md` (if present).
- Reads 5 most recent `ops/methodology/*.md` files (head -3 of each).
- Fires condition-based maintenance signals:
  - `OBS_COUNT >= 10`: suggest /rethink
  - `TENS_COUNT >= 5`: suggest /rethink
  - `SESS_COUNT >= 5`: suggest /remember --mine-sessions
  - `INBOX_COUNT >= 3`: suggest /reduce or /pipeline
- Runs `ops/scripts/reconcile.sh --compact` (workboard reconciliation) if it exists.
- Methodology staleness check: if config.yaml is 30+ days newer than newest methodology note, fires CONDITION.

**write-validate.sh**
- Reads tool input JSON from stdin, extracts `tool_input.file_path`.
- Only validates files in `*/notes/*` or `*thinking/*` paths (note: NOT `*/thoughts/*`).
- Checks: YAML frontmatter present, `description:` field present, `topics:` field present.
- Returns `additionalContext` JSON with warning string: `{"additionalContext": "Schema warnings for X: ..."}`.

**auto-commit.sh**
- Runs async (does NOT receive reliable tool input via stdin).
- Stages ALL changes (`git add -A`) — not scoped to note paths.
- Builds commit message from changed file count and stats.
- Format: `"Auto: filename"` for single file, `"Auto: N files | stats"` for multiple.
- Uses `--no-verify` to skip pre-commit hooks.

**session-capture.sh**
- Reads JSON from stdin, extracts `session_id`.
- Writes `ops/sessions/YYYYMMDD-HHMMSS.json` with id + ended + status.
- Stages and commits: `self/goals.md`, `ops/goals.md`, `ops/sessions/`, `ops/observations/`, `ops/methodology/`.
- Commit message: `"Session capture: TIMESTAMP"`.

---

### intent-computer Hook Implementation — Current State

intent-computer is an opencode plugin (TypeScript). The hook architecture is fundamentally different from Claude Code shell hooks: everything is registered in `src/index.ts` via the Plugin SDK.

**Mapping of arscontexta shell hooks to intent-computer plugin hooks:**

| arscontexta hook | intent-computer equivalent | SDK event |
|------------------|---------------------------|-----------|
| vaultguard.sh | `isVault()` in vaultguard.ts | Called at plugin init |
| session-orient.sh | `sessionOrient()` | `experimental.chat.system.transform` |
| write-validate.sh | `writeValidate()` | `tool.execute.after` (tool === "write") |
| auto-commit.sh | `autoCommit()` | `tool.execute.after` (async void) |
| session-capture.sh | `sessionCapture()` | `event` (type === "session.deleted") |
| (new) | `sessionContinuity()` | `event` (fires after sessionCapture) |

intent-computer has one additional hook with no arscontexta equivalent: **session-continuity** — calls the LLM after session end to generate updated working-memory.md from changed files. This is a significant capability extension.

---

### Comparison: gaps and differences

**1. vaultguard.ts vs vaultguard.sh**

The TypeScript version is a close port and covers the same detection logic. One notable extension: `isNotePath()` is added to vaultguard.ts, handling the note-path scoping that arscontexta's write-validate.sh does inline. isNotePath checks for `/thoughts/`, `/notes/`, `/thinking/`, `/claims/` — slightly broader than arscontexta's `*/notes/*` and `*thinking/*` patterns.

Gap: arscontexta's vaultguard writes the marker file during auto-migration. vaultguard.ts does this too, but wraps it in a dynamic import of `fs` (unnecessary — fs is already statically imported at top of vaultguard.ts in the same file scope).

**2. session-orient.ts vs session-orient.sh**

intent-computer extends arscontexta's orient significantly:
- Adds `working-memory.md` injection (new — arscontexta doesn't have this)
- Adds `morning-brief.md` injection (new)
- Has `self/working-memory.md` and `ops/working-memory.md` fallback path
- Orphan pressure condition checks `ops/orphans/` and `thoughts/orphans/` directories (arscontexta doesn't check orphans at all in its orient hook — orphan detection there is done by graph scripts)
- Does NOT read `self/methodology.md` or recent ops/methodology/ notes (arscontexta does)
- Does NOT run `reconcile.sh` (arscontexta runs this if it exists)
- Does NOT include methodology staleness check
- Uses `find` instead of `tree` — but doesn't filter to `.md` files only; returns all files up to 200 lines

Gap: intent-computer's session-orient does not inject `self/methodology.md` or recent `ops/methodology/` notes. arscontexta considers this important for identity continuity ("loaded behavioral patterns"). Since methodology.md is part of the kernel's `self-space` primitive, this is a meaningful gap.

Gap: No reconcile.sh analog. arscontexta uses reconcile for workboard/condition state. intent-computer has no equivalent condition reconciliation.

**3. write-validate.ts vs write-validate.sh**

intent-computer's version is strictly more capable:
- Validates full YAML frontmatter structure (both opening AND closing delimiters)
- Checks description quality: detects restatement of title, minimum length (20 chars)
- Checks topics quality: verifies non-empty (not just present)
- Returns warning string appended to tool output (Claude sees it inline)
- arscontexta returns `additionalContext` JSON (injected as tool result context)

Gap: arscontexta's write-validate only fires on `*/notes/*` and `*thinking/*` paths. intent-computer uses `isNotePath()` which covers `thoughts/`, `notes/`, `thinking/`, `claims/`. This is intentionally broader to cover the companion domain's `thoughts/` folder naming.

**4. auto-commit.ts vs auto-commit.sh**

Key behavioral difference: arscontexta's auto-commit does `git add -A` (all changes), while intent-computer's scopes to: the changed note file + `self/`, `ops/`, `inbox/`. This is a deliberate design choice — staging everything can accidentally commit unrelated changes in non-vault directories of the same repo. The scoped approach is safer for a plugin that runs in any opencode project.

Gap: arscontexta constructs a commit message from file stats (`git diff --cached --stat`). intent-computer uses file count and names. Both approaches are fine; arscontexta's stat line is slightly more informative.

**5. session-capture.ts vs session-capture.sh**

intent-computer's version is richer:
- Stores full Session object metadata (title, additions/deletions/files count, timestamps)
- Has explicit deduplication guard (`capturedSessionIDs` set)
- Triggers session-continuity afterward (LLM working memory update)
- arscontexta's only stores `{id, ended, status}` and simple file commits

Gap: arscontexta stages `ops/sessions/current.json` and session-oriented goals. intent-computer stages `self/working-memory.md` and `self/goals.md`. intent-computer does NOT write `ops/sessions/current.json` — it writes timestamped files only. arscontexta's `session-orient.sh` reads `ops/sessions/current.json` for previous session context, but intent-computer has no equivalent. This is bridged by working-memory.md, but the gap is worth noting.

**6. session-continuity.ts (no arscontexta equivalent)**

This is a new capability: after each session, calls the LLM to:
- Identify changed .md files in thoughts/, inbox/, self/, ops/
- Read goals.md and previous working-memory.md
- Generate updated working-memory.md with active threads, unresolved items, forming patterns, next move, temperature

This covers the "persist" phase of the session rhythm at a level arscontexta's shell hooks cannot reach without an external LLM call. The working-memory.md becomes the primary continuity artifact read at next session start.

---

### Hook gaps to address

1. **session-orient: missing methodology injection** — Read and inject `self/methodology.md` if present. arscontexta does this; it's a kernel-level identity continuity requirement.

2. **write-validate: path coverage for companion domain** — The current `isNotePath` covers `thoughts/` which is correct for the companion/arscontexta personal vocabulary. No change needed, but confirm this is intentional.

3. **session-capture: no `ops/sessions/current.json` handoff** — arscontexta writes `current.json` which session-orient reads. intent-computer replaces this with working-memory.md. The intent-computer approach is architecturally superior (rich LLM-generated summary vs raw session state). No change needed unless we want arscontexta compatibility.

4. **auto-commit: `git add -A` vs scoped staging** — intent-computer's scoped approach is correct for a plugin. No change needed.

5. **session-orient: tensions directory not checked** — arscontexta checks `ops/tensions/` for the `TENS_COUNT >= 5` condition. intent-computer's `sessionOrient` does not. This condition should be added.

---

## 2. Config Templates Needed

From `src/config/` (now deleted but recovered from git HEAD), three templates exist:

### derivation-manifest-template.md

**Purpose:** Written by `/setup` into the user's vault as `ops/derivation-manifest.md`. Records the configuration choices made during setup — which dimensions were set, vocabulary mapping, active feature blocks.

**Current structure (from git HEAD):**

```yaml
---
_comment: "Phase 7: This template is generated by /setup as ops/derivation-manifest.md."
engine_version: "intent-computer-0.1.0"
platform: opencode
kernel_version: "1.0"

granularity: "{{granularity}}"
organization: "{{organization}}"
linking: "{{linking}}"
processing: "{{processing}}"
navigation: "{{navigation}}"
maintenance: "{{maintenance}}"
schema: "{{schema}}"
automation: "{{automation}}"

active_blocks:
  - wiki-links
  - processing-pipeline
  - schema
  - maintenance
  - self-evolution
  - session-rhythm
  - templates
  - ethical-guardrails
  - atomic-notes
  - personality

vocabulary:
  folder_notes: "{{folder_notes}}"
  folder_inbox: "inbox"
  folder_archive: "archive"
  folder_self: "self"
  folder_ops: "ops"
  note_singular: "{{note_singular}}"
  note_plural: "{{note_plural}}"
  map_singular: "map"
  map_plural: "maps"
  verb_reduce: "{{verb_reduce}}"
  verb_reflect: "{{verb_reflect}}"
  verb_reweave: "{{verb_reweave}}"
  cmd_reduce: "{{cmd_reduce}}"
  cmd_reflect: "{{cmd_reflect}}"
  cmd_reweave: "{{cmd_reweave}}"
  cmd_verify: "verify"
  cmd_validate: "validate"
  cmd_seed: "seed"
  cmd_ralph: "ralph"
  cmd_pipeline: "pipeline"
  cmd_tasks: "tasks"
  cmd_stats: "stats"
  cmd_graph: "graph"
  cmd_next: "next"
  cmd_learn: "learn"
  cmd_remember: "remember"
  cmd_rethink: "rethink"
  cmd_refactor: "refactor"

platform_hints:
  context_type: "opencode-plugin"
  semantic_search_tool: "mcp__qmd__vector_search"
  autoapprove:
    - "mcp__qmd__search"
    - "mcp__qmd__vector_search"
    - "mcp__qmd__deep_search"
    - "mcp__qmd__get"
    - "mcp__qmd__multi_get"
---
```

**Comparison with arscontexta:** arscontexta doesn't have a `derivation-manifest-template.md` equivalent — it uses `ops/derivation.md` (prose rationale document) and `ops/config.yaml` (machine-readable config). intent-computer merges both into a single YAML frontmatter file. This is the right approach for opencode: one file, machine and human readable.

**What needs to be generated (derived from arscontexta research):**

The template should include the 8 kernel dimensions from `reference/kernel.yaml`:
- `atomicity` (0-1) — note granularity
- `organization` (0-1) — folder depth
- `linking` (0-1) — explicit vs implicit
- `processing` (0-1) — pipeline depth
- `session` (0-1) — session continuity investment
- `maintenance` (0-1) — health check frequency
- `search` (0-1) — search capability
- `automation` (0-1) — convention vs full automation

The personal preset uses `{atomicity: 0.5, organization: 0.5, linking: 0.3, processing: 0.7, session: 0.3, maintenance: 0.4, search: 0.3, automation: 0.6}`. The research preset uses `{atomicity: 0.8, organization: 0.3, linking: 0.7, processing: 0.8, session: 0.7, maintenance: 0.6, search: 0.8, automation: 0.8}`.

The template should be re-created at `src/config/derivation-manifest-template.md`.

### mcp-template.json

**Purpose:** Written by `/setup` into the user's vault root as `.mcp.json` when semantic search (qmd) is enabled.

**Structure (from git HEAD):**
```json
{
  "_comment": "Phase 7: Generated by /setup as .mcp.json when semantic search enabled.",
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"],
      "autoapprove": [
        "mcp__qmd__search",
        "mcp__qmd__vector_search",
        "mcp__qmd__deep_search",
        "mcp__qmd__get",
        "mcp__qmd__multi_get",
        "mcp__qmd__status"
      ]
    }
  }
}
```

**Note:** This is a Claude Code `.mcp.json` format, not opencode. For opencode, qmd is configured inside `opencode.json` under the `mcp` key. The `.mcp.json` format is kept for Claude Code compatibility (users may run both). No changes needed to structure.

The template should be re-created at `src/config/mcp-template.json`.

### opencode-template.json

**Purpose:** Written by `/setup` into the user's vault root as `opencode.json`. Configures the opencode runtime for the vault.

**Structure (from git HEAD):**
```json
{
  "_comment": "Phase 7: Generated by /setup as opencode.json. {{qmd_enabled}} replaced during generation.",
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["intent-computer"],
  "mcp": {
    "_comment_qmd": "qmd block included only when semantic search enabled",
    "qmd": {
      "type": "local",
      "command": "qmd",
      "args": ["mcp"]
    }
  },
  "permission": {
    "read": "allow",
    "edit": "allow",
    "write": "allow",
    "bash": {
      "*": "allow",
      "rm -rf *": "ask",
      "git push --force *": "ask",
      "sudo *": "deny"
    }
  }
}
```

**Key notes:**
- `plugin: ["intent-computer"]` wires the plugin.
- `mcp.qmd` block is conditional on semantic search being enabled — `/setup` must omit this block or comment it out when qmd is not configured.
- Permission block is permissive by default (read/edit/write: allow) with safety guards on destructive operations.

The template should be re-created at `src/config/opencode-template.json`.

---

## 3. Reference Docs

arscontexta's `reference/` directory contains the research and design knowledge backing the system. These are NOT shipped to users — they are the source-of-truth documentation for building the system.

### What's in reference/

| File | What it is | Relevance to intent-computer |
|------|-----------|------------------------------|
| `kernel.yaml` | 15 universal primitives, their requirements, validation criteria | HIGH: defines what must be implemented |
| `methodology.md` | Cognitive science foundations, universal note pattern, universal operations | HIGH: reference for any CLAUDE.md generation |
| `components.md` | How to build each system component (notes, schema, links, MOCs, folders) | HIGH: blueprint for generated vault structure |
| `session-lifecycle.md` | How sessions should be structured, session types, smart-zone theory | HIGH: informs session-orient and session-continuity design |
| `failure-modes.md` | 10 failure modes, prevention patterns, warning signs | MEDIUM: informs condition thresholds in session-orient |
| `vocabulary-transforms.md` | Universal → domain vocabulary mapping (7 domains) | HIGH: needed for setup skill's vocabulary generation |
| `derivation-validation.md` | Tests for derivation correctness, cross-domain validation | MEDIUM: reference for setup skill quality gates |
| `claim-map.md` | Knowledge claim map (system design) | LOW: internal design doc |
| `dimension-claim-map.md` | Dimension-level design claims | LOW: internal design doc |
| `tradition-presets.md` | How design traditions map to configurations | MEDIUM: reference for setup onboarding |
| `use-case-presets.md` | How user use cases map to configurations | MEDIUM: reference for setup onboarding |
| `conversation-patterns.md` | Conversation patterns for the setup wizard | MEDIUM: reference for setup onboarding |
| `personality-layer.md` | Personality derivation mechanics | LOW: consumed by setup |
| `three-spaces.md` | Three-space model (notes, self, ops) | MEDIUM: conceptual foundation |
| `self-space.md` | Self-space design reference | MEDIUM: reference for identity injection |

**Templates in reference/templates/:**
- `base-note.md` — universal note template (description, type, created)
- `moc.md` — map of content template (description, type, created; Core Ideas / Tensions / Open Questions sections)
- `research-note.md` — research domain template (adds methodology, source, classification)
- `companion-note.md` — companion domain template (adds status, people, context; type: memory|ritual|milestone|moment)
- `session-log.md` — session log template (description, type: session-log)
- Other domain templates: `learning-note.md`, `therapy-note.md`, `creative-note.md`, `life-note.md`, `relationship-note.md`

**Recommendation:** These reference files should be imported into the intent-computer codebase at `methodology/` (which currently exists as an empty directory). They serve as the source-of-truth library for all skill generation and setup logic in phases 2-7. At minimum: `kernel.yaml`, `methodology.md`, `components.md`, `session-lifecycle.md`, `vocabulary-transforms.md`, and `failure-modes.md` should be present.

The companion-note template is directly relevant since intent-computer ships with the companion/personal domain vocabulary (the user's vault uses `thoughts/` and the personal vocabulary mapping).

---

## 4. Presets

arscontexta ships three preset configurations: `personal/`, `research/`, `experimental/`.

### personal preset (preset.yaml)

```yaml
name: personal-assistant
dimensions: {atomicity: 0.5, organization: 0.5, linking: 0.3, processing: 0.7, session: 0.3, maintenance: 0.4, search: 0.3, automation: 0.6}
blocks:
  always: [atomic-notes, wiki-links, mocs, processing-pipeline, schema, maintenance, self-evolution, session-rhythm, templates, ethical-guardrails, helper-functions, graph-analysis, personality, self-space]
  conditional: [semantic-search, multi-domain]
self_space: true
qmd: "user_choice"
personality: "warm-supportive"
starter_mocs: [life-areas, people, goals]
```

vocabulary.yaml maps: note→reflection, reduce→surface, reflect→find patterns, moc→life area, inbox→journal.

categories.yaml: [reflections, relationship-dynamics, goals, habits, gratitude, lessons]

**Relevance:** This is the closest preset to the user's vault configuration (warm-supportive personality, self_space: true, processing: 0.7, semantic-search conditional on qmd). The vocabulary mapping aligns with CLAUDE.md (though the user's vault uses "thoughts" instead of "reflections"). The starter MOCs (life-areas, people, goals) match the vault's existing structure.

**Note:** intent-computer's `src/config/` was building toward generating these from setup. The derivation-manifest-template uses the same 8 dimensions as the preset.yaml files. This confirms the template approach is correct.

### research preset (preset.yaml)

Full-automation from day one, all pipeline skills at full depth, self_space: false, qmd: true.

Vocabularies: universal (note=claim, etc.). Starter MOCs: domain-overview, methods, open-questions.

**Relevance:** Reference implementation. Useful for testing that the setup skill can generate both a personal and research configuration.

### experimental preset (preset.yaml)

All dimensions null (user-chosen). Minimal always-blocks, most blocks conditional. Personality derived from conversation.

**Relevance:** The experimental preset drives the co-design onboarding path. Relevant to the `/setup` skill's branching logic.

### Should presets be in intent-computer?

Yes, but as internal data files for the setup skill — not shipped to users. Recommended location: `src/config/presets/personal.yaml`, `src/config/presets/research.yaml`, `src/config/presets/experimental.yaml`. The `/setup` skill reads these to seed dimension defaults before asking the onboarding questions.

The vocabulary.yaml and categories.yaml files should also be included: `src/config/presets/personal-vocabulary.yaml` etc.

---

## 5. Recommendations

### Hook changes needed

**Priority 1 (session-orient): inject self/methodology.md**

Current `session-orient.ts` injects identity but not methodology. arscontexta's `session-orient.sh` injects both:

```bash
if [ -f self/identity.md ]; then
  cat self/identity.md self/methodology.md 2>/dev/null
fi
```

And also reads recent ops/methodology/ notes (head -3 of the 5 most recent). This matters because methodology.md contains the agent's processing rules and quality standards — without it, the agent doesn't know HOW to work, just WHO it is.

**Change needed in `src/hooks/session-orient.ts`:**
1. After identity injection, also read `self/methodology.md` (same path fallbacks: `self/`, then `ops/`).
2. Optionally: read head-3 of 5 most recent `ops/methodology/*.md` files (the "recent methodology learnings" section).

**Priority 2 (session-orient): add tensions condition check**

Current code checks observations and orphans but not tensions. arscontexta checks:
```bash
TENS_COUNT=$(ls -1 ops/tensions/*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$TENS_COUNT" -ge 5 ]; then
  echo "CONDITION: $TENS_COUNT unresolved tensions. Consider /rethink."
fi
```

**Change needed in `src/hooks/session-orient.ts`:** Add tensions directory check alongside observations check.

**Priority 3 (session-orient): tree output — filter to .md files**

Current code returns all files from `find`, including non-markdown files. arscontexta filters to `.md` files only (`-P '*.md'`). This keeps the tree output focused and reduces context noise.

**Change needed:** Either filter the find output to `.md` files, or cap more aggressively at 100 lines.

**Priority 4 (vaultguard.ts): fix unnecessary dynamic import**

In `isVault()`, the auto-migration path uses `const { writeFileSync } = await import("fs")` when `writeFileSync` is already imported at the top of the file. This is a minor code quality issue.

**Change needed:** Remove the dynamic import, use the statically imported `writeFileSync` directly.

### Config templates to create (or restore)

All three templates were deleted in the working tree (per git status). They need to be restored/created:

1. **`src/config/derivation-manifest-template.md`** — Restore from git HEAD with one enhancement: add the 8 numeric dimension values (`atomicity: "{{atomicity}}"` etc.) alongside the existing named dimension strings. This aligns with arscontexta's preset.yaml format which uses 0-1 floats.

2. **`src/config/mcp-template.json`** — Restore from git HEAD as-is. No changes needed.

3. **`src/config/opencode-template.json`** — Restore from git HEAD. Consider making the `mcp.qmd` block clearly conditional (move the comment-based conditionality to a `{{#if qmd_enabled}}` placeholder that `/setup` handles explicitly).

### Preset files to create

Create `src/config/presets/` directory with:
- `personal.yaml` — from arscontexta presets/personal/preset.yaml
- `personal-vocabulary.yaml` — from arscontexta presets/personal/vocabulary.yaml
- `personal-categories.yaml` — from arscontexta presets/personal/categories.yaml
- `research.yaml` — from arscontexta presets/research/preset.yaml
- `research-vocabulary.yaml` — from arscontexta presets/research/vocabulary.yaml
- `research-categories.yaml` — from arscontexta presets/research/categories.yaml
- `experimental.yaml` — from arscontexta presets/experimental/preset.yaml

### Reference docs to populate methodology/

The `methodology/` directory exists but is empty. Populate it with:
- `kernel.yaml` — from reference/kernel.yaml (15 primitives, the implementation spec)
- `methodology.md` — from reference/methodology.md (cognitive science foundations)
- `components.md` — from reference/components.md (component blueprints)
- `session-lifecycle.md` — from reference/session-lifecycle.md (session design reference)
- `vocabulary-transforms.md` — from reference/vocabulary-transforms.md (domain vocab mapping)
- `failure-modes.md` — from reference/failure-modes.md (10 failure modes + prevention)

These are research backing documents, not shipped to users. They are read by meta-skills (`/architect`, `/ask`, `/setup`) to make informed configuration decisions.

### Reference templates

Create `src/config/templates/` with the vault note templates from arscontexta's `reference/templates/`:
- `base-note.md` — universal base template
- `moc.md` — map of content template
- `companion-note.md` — companion/personal domain template (relevant for the user's vault and similar configurations)
- `research-note.md` — research domain template
- `session-log.md` — session log template
- `observation.md` — operational observation template (currently in src/config/ as deleted)

These are what `/setup` writes to the user's `templates/` directory during vault initialization.

---

## 6. Summary of Current State

| Component | arscontexta | intent-computer current | Gap |
|-----------|-------------|------------------------|-----|
| Vault detection | vaultguard.sh | vaultguard.ts (port) | Minor: dynamic import cleanup |
| Session orient | session-orient.sh | session-orient.ts (extends) | Missing: methodology.md injection, tensions condition |
| Write validate | write-validate.sh (basic) | write-validate.ts (richer) | None — intent-computer is superior |
| Auto commit | auto-commit.sh (git add -A) | auto-commit.ts (scoped) | None — scoped is intentionally better |
| Session capture | session-capture.sh (basic) | session-capture.ts (richer) | None — intent-computer stores richer metadata |
| Session continuity | (no equivalent) | session-continuity.ts (LLM) | intent-computer has more capability here |
| Config templates | Not in arscontexta | Deleted from working tree | Need to restore src/config/ |
| Presets | presets/{personal,research,experimental}/ | Not present | Need to create src/config/presets/ |
| Reference docs | reference/ directory | methodology/ (empty) | Need to populate methodology/ |
| Note templates | reference/templates/ | Not present | Need to create src/config/templates/ |

The hooks are in good shape with two substantive gaps (methodology injection, tensions condition). The main work is restoring and expanding the config infrastructure that was deleted from the working tree.
