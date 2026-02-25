# intent-computer Build Plan

**As of:** 2026-02-19
**Context:** Architect pass — read ~/Mind for design direction, fully audited arscontexta repo.

---

## 1. Architecture Summary

intent-computer is an `@opencode-ai/plugin` TypeScript package that ports the ars-contexta knowledge system from Claude Code to opencode. It implements two distinct layers:

### Layer 1: Hooks (Runtime Automation)

Four hooks wired to opencode's event system via the Plugin API. These are TypeScript functions called by `src/index.ts`:

| Hook | opencode Event | Role |
|------|---------------|------|
| `sessionOrient` | `experimental.chat.system.transform` | Injects vault context into system prompt at session start and after compaction |
| `writeValidate` | `tool.execute.after` on `write` | Schema enforcement on every vault note write |
| `autoCommit` | `tool.execute.after` on `write` (async) | Non-blocking git commit after writes |
| `sessionCapture` | `event` on `session.deleted` | Writes session metadata JSON to `ops/sessions/` |
| `sessionContinuity` | `event` on `session.deleted` (async) | Calls LLM to update `self/working-memory.md` |

The hooks are vault-scoped: `vaultguard.ts` detects whether the current worktree is an ars-contexta vault (`.arscontexta` marker, `ops/config.yaml`, or `.claude/hooks/session-orient.sh`). All hooks short-circuit if no vault is detected.

### Layer 2: Skills (SKILL.md files)

SKILL.md files contain structured instructions for the AI to follow when a skill is invoked. There are two categories:

**skill-sources/** — 16 generated/operational skills that users invoke directly (reduce, reflect, etc.). These are templates that use `{vocabulary.*}` placeholders resolved from `ops/derivation-manifest.md`. They are designed to work in any vault regardless of domain vocabulary.

**plugin-skills/** — 10 plugin-level skills that bootstrap and manage the system (setup, help, health, etc.). These are plugin-native, not vocabulary-dependent.

Skills are distributed to the user's vault via `scripts/sync-skills.js`, which copies SKILL.md files to `~/.opencode/skills/` and generates command stub files at `~/.opencode/commands/` and `~/.config/opencode/commands/`.

---

## 2. Skill Inventory

### skill-sources/ (16 generated command templates — all need SKILL.md)

These are ports of ars-contexta's `skill-sources/` directory. The SKILL.md content should be copied from arscontexta with minimal modification (strip Claude Code-specific bash patterns where opencode equivalents exist, otherwise keep verbatim — the instructions are model-addressed, not platform-addressed).

| Skill | Purpose | Status in working tree |
|-------|---------|----------------------|
| `reduce` | Extract insights from source material | Present (M — modified/stubbed) |
| `reflect` | Find connections, update MOCs | Present (M — modified/stubbed) |
| `reweave` | Backward pass — update older notes with new context | DELETED (D) |
| `verify` | Combined quality check: description + schema + health | DELETED (D) |
| `validate` | Schema compliance batch checking | DELETED (D) |
| `seed` | Create extraction task with duplicate detection | DELETED (D) |
| `ralph` | Queue-based orchestration with fresh context per phase | Present (M — modified/stubbed) |
| `pipeline` | End-to-end source processing orchestration | Present (M — modified/stubbed) |
| `tasks` | Queue management | DELETED (D) |
| `stats` | Vault metrics and progress reporting | DELETED (D) |
| `graph` | Graph analysis and queries | Present (M — modified/stubbed) |
| `next` | Next-action recommendation | Present (M — modified/stubbed) |
| `learn` | Research a topic and grow the graph | Present (M — modified/stubbed) |
| `remember` | Capture friction as methodology notes | DELETED (D) |
| `rethink` | Challenge system assumptions against accumulated evidence | DELETED (D) |
| `refactor` | Structural improvements and vault reorganization | Present (M — modified/stubbed) |

**8 DELETED skill-sources that need to be restored:** reweave, verify, validate, seed, tasks, stats, remember, rethink.

### plugin-skills/ (10 plugin-level commands)

These are ports of ars-contexta's `skills/` directory.

| Skill | Purpose | Status in working tree |
|-------|---------|----------------------|
| `setup` | Conversational onboarding — generates full system | Present (M — stubbed, Phase 6 TODO) |
| `help` | Contextual guidance and command discovery | Present (M — modified/stubbed) |
| `health` | Diagnostic checks on vault | Present (M — modified/stubbed) |
| `ask` | Query the research graph for methodology answers | Present (M — modified/stubbed) |
| `recommend` | Architecture advice | Present (M — modified/stubbed) |
| `architect` | Research-backed evolution guidance | Present (M — modified/stubbed) |
| `add-domain` | Add a new knowledge domain to an existing system | Present (M — modified/stubbed) |
| `reseed` | Re-derive from first principles when drift accumulates | Present (M — modified/stubbed) |
| `tutorial` | Interactive walkthrough | DELETED (D) |
| `upgrade` | Apply knowledge base updates to existing system | DELETED (D) |

**2 DELETED plugin-skills that need to be restored:** tutorial, upgrade.

---

## 3. What's Already Built

### Hooks — COMPLETE (5/5)

All five hooks are fully implemented in TypeScript:

- **`src/hooks/session-orient.ts`** — Complete. Injects workspace structure (via `find`), working-memory.md, morning-brief.md, goals.md, identity.md, and maintenance conditions (inbox pressure, observations backlog, orphan count, session backlog). Also handles session compaction via `experimental.session.compacting`.
- **`src/hooks/write-validate.ts`** — Complete. Validates YAML frontmatter presence, `description` field, `topics` field, description length, and description-not-identical-to-title check.
- **`src/hooks/auto-commit.ts`** — Complete. Non-blocking git commit after note writes, staging the changed file plus `self/`, `ops/`, `inbox/`.
- **`src/hooks/session-capture.ts`** — Complete. Writes session metadata JSON to `ops/sessions/`, commits session artifacts.
- **`src/hooks/session-continuity.ts`** — Complete (new, not yet committed). LLM-powered working memory update on session end. Scans changed .md files since session start, builds a prompt, calls opencode's `client.session` API, writes updated `self/working-memory.md`.

### Plugin Entry Point — COMPLETE

- **`src/index.ts`** — Complete. Wires all hooks to opencode events. Handles `experimental.chat.system.transform`, `experimental.session.compacting`, `tool.execute.after`, and `event` (session.deleted). Session start time tracking for continuity hook.

### Vault Detection — COMPLETE

- **`src/tools/vaultguard.ts`** — Complete. Detects vault via `.arscontexta` marker, `ops/config.yaml` (auto-migration), or `.claude/hooks/session-orient.sh` (legacy). Provides `isNotePath()` for multi-vocabulary note path detection (`/thoughts/`, `/notes/`, `/thinking/`, `/claims/`).

### Sync Script — COMPLETE (skeleton)

- **`scripts/sync-skills.js`** — Complete skeleton. Reads both `src/skill-sources/` and `src/plugin-skills/`, copies SKILL.md to `~/Mind/.opencode/skills/`, generates command stubs at `~/Mind/.opencode/commands/` and `~/.config/opencode/commands/`.

### Package Config — COMPLETE

- **`package.json`** — Complete. TypeScript ESM module, peer dependency on `@opencode-ai/plugin`.

---

## 4. What Needs Building

### Priority 1: Restore deleted SKILL.md files

The working tree shows 10 deleted SKILL.md files (8 skill-sources + 2 plugin-skills). These were present in the last commit as stubs and need to be either restored from git history or populated with content fetched from arscontexta.

**Approach:** Fetch SKILL.md content from `agenticnotetaking/arscontexta` via `gh api` for each deleted skill, adapt minimally for opencode context, and write to the correct path.

Files to create/restore:

```
src/skill-sources/reweave/SKILL.md       — fetch from arscontexta skill-sources/reweave/SKILL.md
src/skill-sources/verify/SKILL.md        — fetch from arscontexta skill-sources/verify/SKILL.md
src/skill-sources/validate/SKILL.md      — fetch from arscontexta skill-sources/validate/SKILL.md
src/skill-sources/seed/SKILL.md          — fetch from arscontexta skill-sources/seed/SKILL.md
src/skill-sources/tasks/SKILL.md         — fetch from arscontexta skill-sources/tasks/SKILL.md
src/skill-sources/stats/SKILL.md         — fetch from arscontexta skill-sources/stats/SKILL.md
src/skill-sources/remember/SKILL.md      — fetch from arscontexta skill-sources/remember/SKILL.md
src/skill-sources/rethink/SKILL.md       — fetch from arscontexta skill-sources/rethink/SKILL.md
src/plugin-skills/tutorial/SKILL.md      — fetch from arscontexta skills/tutorial/SKILL.md
src/plugin-skills/upgrade/SKILL.md       — fetch from arscontexta skills/upgrade/SKILL.md
```

### Priority 2: Populate stubbed SKILL.md files

The modified (M) SKILL.md files were scaffolded as stubs with TODOs. Each needs its body populated from the corresponding arscontexta source. The frontmatter may already be correct; the instruction body needs to be filled in.

Files to update (all should pull from arscontexta as source of truth):

```
src/skill-sources/reduce/SKILL.md
src/skill-sources/reflect/SKILL.md
src/skill-sources/ralph/SKILL.md
src/skill-sources/pipeline/SKILL.md
src/skill-sources/graph/SKILL.md
src/skill-sources/next/SKILL.md
src/skill-sources/learn/SKILL.md
src/skill-sources/refactor/SKILL.md
src/plugin-skills/setup/SKILL.md         — most complex; see Priority 3
src/plugin-skills/help/SKILL.md
src/plugin-skills/health/SKILL.md
src/plugin-skills/ask/SKILL.md
src/plugin-skills/recommend/SKILL.md
src/plugin-skills/architect/SKILL.md
src/plugin-skills/add-domain/SKILL.md
src/plugin-skills/reseed/SKILL.md
```

### Priority 3: Setup skill (complex — needs dedicated pass)

`src/plugin-skills/setup/SKILL.md` is the derivation engine — the most complex skill in the system (~800 lines in arscontexta). It drives a 6-phase process:
1. Platform detection (detect opencode, check qmd, check git)
2. Derivation conversation (2-4 turns asking about domain/workflow/vocabulary)
3. Dimension derivation (8 dimensions with confidence scoring)
4. System proposal (show configuration before generating)
5. File generation (directory structure, config files, templates, opencode.json, derivation-manifest.md)
6. Validation (check 15 kernel primitives, run pipeline smoke test)

The opencode port differs from ars-contexta in one key way: ars-contexta uses `AskUserQuestion` tool for interactive turns; opencode uses inline chat turns (the skill's instructions direct the AI to ask questions as regular responses and wait for replies). The setup SKILL.md needs to encode this conversational flow as instructions.

After setup completes, it should:
- Generate `ops/derivation-manifest.md` from `src/config/derivation-manifest-template.md`
- Generate `opencode.json` from `src/config/opencode-template.json`
- Generate `.mcp.json` from `src/config/mcp-template.json` (if qmd enabled)
- Create the vault directory structure
- Write thought-note, map, and observation templates

### Priority 4: Restore config templates

Three config templates were deleted from the working tree. They exist in the last commit and need to be restored:

```
src/config/derivation-manifest-template.md   — template for ops/derivation-manifest.md
src/config/mcp-template.json                 — template for .mcp.json (qmd config)
src/config/opencode-template.json            — template for opencode.json
```

These were previously scaffolded with `{{placeholder}}` syntax. They need to be complete enough for the setup skill to use as generation sources. Restore from `git show HEAD:src/config/...` and verify completeness.

### Priority 5: Restore deleted TypeScript skill infrastructure

The last commit included TypeScript scaffolding files that have since been deleted:

```
src/skills/fork.ts         — subagent spawning (approximates ars-contexta context: fork)
src/skills/help.ts         — help skill TypeScript logic
src/skills/injector.ts     — system prompt injection with vocabulary substitution
src/skills/model-router.ts — model selection (sonnet vs opus) based on skill requirements
src/skills/pipeline.ts     — pipeline orchestration logic
src/skills/ralph.ts        — ralph queue-based orchestration logic
src/skills/router.ts       — command detection and dispatch from slash commands
src/skills/setup.ts        — scaffoldVault() function called by setup skill
```

**Decision point:** These files were present as stubs with TODOs in the last commit. Their primary role is supporting the setup skill and skill injection. Whether they are needed depends on the skill injection strategy — see Section 6 (Key Decisions).

### Priority 6: Restore deleted docs

```
README.md                    — project README
docs/DECISIONS.md            — architectural decisions log
docs/PORTING-ANALYSIS.md     — analysis of ars-contexta → opencode porting
docs/ROADMAP.md              — development roadmap
```

These are documentation. Low priority for runtime functionality but restore if the docs are referenced by other agents.

---

## 5. Config Templates Needed

Three templates live in `src/config/` and are used by the setup skill to generate vault configuration files:

### `src/config/derivation-manifest-template.md`

Template for `ops/derivation-manifest.md` — the vocabulary mapping file that every skill reads at runtime to get domain-specific names. Must contain:

- The 8 configuration dimensions with `{{placeholder}}` values
- Active feature blocks list
- Complete vocabulary map (all 26 skills, all folder names, all type names)
- Processing config (depth, chaining, selectivity)
- Cognitive grounding section (why each dimension was chosen)

The template was previously scaffolded. Restore from `git show HEAD:src/config/derivation-manifest-template.md` and ensure all vocabulary keys match what the SKILL.md files read (`vocabulary.notes`, `vocabulary.note`, `vocabulary.reduce`, `vocabulary.cmd_reflect`, etc.).

### `src/config/mcp-template.json`

Template for `.mcp.json` at vault root. Configures qmd MCP server for semantic search. Written only when `automation` dimension includes semantic search. Must use same format as arscontexta's generated `.mcp.json`.

### `src/config/opencode-template.json`

Template for `opencode.json` at vault root. Configures the intent-computer plugin and qmd MCP server. Should include:
- `"plugin": ["intent-computer"]`
- `"mcp"` block for qmd (conditional on qmd enabled)
- `"permission"` block with sensible defaults

---

## 6. Sync Strategy

`scripts/sync-skills.js` distributes skills from the package to the user's opencode installation. Current behavior:

1. Iterates `src/skill-sources/` and `src/plugin-skills/`
2. Copies each `SKILL.md` to `~/Mind/.opencode/skills/{name}/SKILL.md`
3. Generates a command stub at `~/Mind/.opencode/commands/{name}.md` and `~/.config/opencode/commands/{name}.md`

The command stub format:
```markdown
---
description: {extracted from SKILL.md frontmatter}
---
Call skill("{name}") and execute it. Arguments: $ARGUMENTS
```

**Issues with the current sync script:**

1. **Hard-coded vault path** — `~/Mind/.opencode/skills` assumes the vault is always at `~/Mind/`. This should be configurable, either via an argument or by reading from a config file. For initial implementation, hard-coding `~/Mind` is acceptable but should be documented.

2. **Two command destinations** — The script writes to both `~/Mind/.opencode/commands/` and `~/.config/opencode/commands/`. The vault-local path (`~/Mind/.opencode/commands/`) is the right place for vault-scoped skills; the global config path (`~/.config/opencode/commands/`) makes skills available in all projects. This is intentional dual-installation.

3. **Skill injection mechanism** — In ars-contexta, Claude Code's `context: fork` in SKILL.md frontmatter causes the plugin to inject skill content into a fresh context window. In opencode, there is no native `context: fork` — the skill injection is handled by `src/skills/injector.ts` (which loads the SKILL.md and injects it into `experimental.chat.system.transform`). The injector reads `ops/derivation-manifest.md` to substitute `{vocabulary.*}` placeholders.

**Recommended sync strategy enhancements:**

- Accept vault path as CLI argument: `node sync-skills.js [vault-path]`
- Skip SKILL.md files that are stubs (contain `status: TODO` in frontmatter) to avoid syncing incomplete skills
- Log which skills were synced vs skipped

---

## 7. Key Architectural Decisions

### Decision 1: Skill injection approach

**Problem:** ars-contexta uses Claude Code's native `context: fork` mechanism to inject SKILL.md content into a fresh context per skill invocation. opencode has no equivalent native mechanism.

**Options:**
A. Inject via `experimental.chat.system.transform` — detect which skill is being invoked (via router.ts), load the SKILL.md, inject it as a system prompt prefix. The current `src/skills/injector.ts` stub implements this approach.
B. Use opencode command stubs that pass instructions inline — the command stub file contains the full instructions rather than a `Call skill(...)` delegation. This avoids the injection infrastructure entirely but means instruction content lives in two places.
C. Hybrid — command stubs stay as delegation stubs, but injection happens at the SKILL.md level by encoding instructions as self-contained (AI reads the command stub, fetches the referenced skill file, follows it).

**Current direction:** Option A (injector). The router detects slash commands and sets `activeSkill`, the injector loads and substitutes vocabulary, the system transform hook prepends the skill instructions to the system prompt. This is the right approach but requires `src/skills/router.ts` and `src/skills/injector.ts` to be fully implemented.

**Recommendation for immediate work:** Defer Option A injection complexity. Use Option C (self-contained command stubs that reference skill content) until the injection infrastructure is needed. The command stub can say: "Read `.opencode/skills/{name}/SKILL.md` and execute the instructions there." This is simpler and works today.

### Decision 2: Setup skill conversation model

**Problem:** ars-contexta's setup skill uses `AskUserQuestion` tool for interactive multi-turn conversation. This tool does not exist in opencode.

**Solution:** The setup SKILL.md instructions direct the model to ask questions as regular conversational responses and wait for the user to reply. Each phase transition is an instruction to the AI: "Present the findings and ask for confirmation before proceeding." This is already the intended design per the Phase 6 stub in the last commit.

**Implication:** The setup SKILL.md must be structured as a conversational flowchart rather than a sequential execution script. Each phase is a conditional: "If user confirmed X, proceed to Y."

### Decision 3: Vocabulary substitution at sync vs at runtime

**Problem:** Skills reference `{vocabulary.notes}` placeholders that need to be resolved to domain-specific names (e.g., `thoughts/`, `claims/`, `reflections/`).

**Options:**
A. Resolve at runtime — injector reads `ops/derivation-manifest.md` and substitutes when loading the SKILL.md for injection.
B. Resolve at sync time — sync-skills.js reads the vault's `ops/derivation-manifest.md` and substitutes placeholders when generating the command stubs.

**Current direction:** Runtime resolution (Option A), implemented in `src/skills/injector.ts`. This is correct because the same skill package serves multiple vaults with different vocabularies.

**If injection is deferred:** Self-contained command stubs should instruct the AI to read `ops/derivation-manifest.md` first (Step 0, which all SKILL.md files already include). This fallback works without the injector.

### Decision 4: Note path detection

**Current state:** `vaultguard.ts` `isNotePath()` checks for `/thoughts/`, `/notes/`, `/thinking/`, `/claims/` path segments. This covers the most common vocabulary choices.

**Gap:** After setup with a custom vocabulary (e.g., `reflections/`), the note path detection won't recognize vault-specific paths. The fix is to read `ops/derivation-manifest.md` at startup and dynamically build the path filter. This is a Phase 2 enhancement — implement when custom vocabularies are in use.

### Decision 5: session-continuity LLM call pattern

**Current state:** `session-continuity.ts` creates a fresh opencode session, sends a prompt, reads the response, then deletes the session. This uses `client.session.create`, `client.session.prompt`, `client.session.delete`.

**Risk:** This fires async on every `session.deleted` event. If the opencode client API changes or the session.prompt endpoint behaves differently than expected, this will fail silently (all errors are swallowed). The current implementation is correct per the `@opencode-ai/plugin` API as understood, but needs integration testing against a real opencode instance.

---

## 8. Recommended Build Sequence

Given the above, here is the recommended execution order for other agents:

**Phase 1 — Restore deleted content (unblocks everything)**
1. Restore config templates from git history (`src/config/`)
2. Fetch and write the 8 deleted skill-sources SKILL.md files from arscontexta
3. Fetch and write the 2 deleted plugin-skills SKILL.md files from arscontexta
4. Restore deleted TypeScript skill stubs from git history (`src/skills/`)

**Phase 2 — Populate stubbed SKILL.md files**
5. For each stubbed SKILL.md (status: TODO or minimal body), fetch full content from arscontexta and replace
6. Verify vocab placeholders match `derivation-manifest-template.md` keys

**Phase 3 — Setup skill (complex pass)**
7. Port setup SKILL.md from arscontexta — adapt for conversational flow without AskUserQuestion
8. Implement `src/skills/setup.ts` `scaffoldVault()` function (directory creation, config file generation from templates)
9. Test setup flow end-to-end

**Phase 4 — Injection infrastructure**
10. Implement `src/skills/router.ts` fully (command detection regex patterns)
11. Implement `src/skills/injector.ts` fully (vocabulary substitution)
12. Wire router + injector into `src/index.ts` system transform hook
13. Test skill invocation with vocabulary substitution

**Phase 5 — Sync and distribution**
14. Enhance `scripts/sync-skills.js` with vault path argument and stub-skipping
15. Run sync against ~/Mind vault
16. Verify skills appear in opencode command picker

**Phase 6 — Integration testing**
17. Test all 5 hooks against ~/Mind vault in opencode
18. Verify session continuity updates working-memory.md correctly
19. Run `/setup` on a test vault

---

## 9. File Map (complete picture)

```
intent-computer/
├── src/
│   ├── index.ts                          COMPLETE — plugin entry point
│   ├── hooks/
│   │   ├── session-orient.ts             COMPLETE
│   │   ├── write-validate.ts             COMPLETE
│   │   ├── auto-commit.ts                COMPLETE
│   │   ├── session-capture.ts            COMPLETE
│   │   └── session-continuity.ts         COMPLETE (untracked, needs commit)
│   ├── tools/
│   │   └── vaultguard.ts                 COMPLETE
│   ├── skills/                           ALL DELETED — restore from git
│   │   ├── fork.ts                       RESTORE (stub)
│   │   ├── help.ts                       RESTORE (stub)
│   │   ├── injector.ts                   RESTORE (stub) → Phase 4: implement fully
│   │   ├── model-router.ts               RESTORE (stub)
│   │   ├── pipeline.ts                   RESTORE (stub)
│   │   ├── ralph.ts                      RESTORE (stub)
│   │   ├── router.ts                     RESTORE (stub) → Phase 4: implement fully
│   │   └── setup.ts                      RESTORE (stub) → Phase 3: implement fully
│   ├── skill-sources/                    16 SKILL.md files — 8 deleted, 8 stubbed
│   │   ├── reduce/SKILL.md               STUB → populate from arscontexta
│   │   ├── reflect/SKILL.md              STUB → populate from arscontexta
│   │   ├── reweave/SKILL.md              DELETED → restore from arscontexta
│   │   ├── verify/SKILL.md               DELETED → restore from arscontexta
│   │   ├── validate/SKILL.md             DELETED → restore from arscontexta
│   │   ├── seed/SKILL.md                 DELETED → restore from arscontexta
│   │   ├── ralph/SKILL.md                STUB → populate from arscontexta
│   │   ├── pipeline/SKILL.md             STUB → populate from arscontexta
│   │   ├── tasks/SKILL.md                DELETED → restore from arscontexta
│   │   ├── stats/SKILL.md                DELETED → restore from arscontexta
│   │   ├── graph/SKILL.md                STUB → populate from arscontexta
│   │   ├── next/SKILL.md                 STUB → populate from arscontexta
│   │   ├── learn/SKILL.md                STUB → populate from arscontexta
│   │   ├── remember/SKILL.md             DELETED → restore from arscontexta
│   │   ├── rethink/SKILL.md              DELETED → restore from arscontexta
│   │   └── refactor/SKILL.md             STUB → populate from arscontexta
│   ├── plugin-skills/                    10 SKILL.md files — 2 deleted, 8 stubbed
│   │   ├── setup/SKILL.md                STUB → Phase 3: full port (complex)
│   │   ├── help/SKILL.md                 STUB → populate from arscontexta
│   │   ├── health/SKILL.md               STUB → populate from arscontexta
│   │   ├── ask/SKILL.md                  STUB → populate from arscontexta
│   │   ├── recommend/SKILL.md            STUB → populate from arscontexta
│   │   ├── architect/SKILL.md            STUB → populate from arscontexta
│   │   ├── add-domain/SKILL.md           STUB → populate from arscontexta
│   │   ├── reseed/SKILL.md               STUB → populate from arscontexta
│   │   ├── tutorial/SKILL.md             DELETED → restore from arscontexta
│   │   └── upgrade/SKILL.md              DELETED → restore from arscontexta
│   └── config/                           ALL DELETED — restore from git
│       ├── derivation-manifest-template.md  RESTORE + verify completeness
│       ├── mcp-template.json                RESTORE
│       └── opencode-template.json           RESTORE
├── scripts/
│   └── sync-skills.js                    COMPLETE (needs vault-path arg enhancement)
├── package.json                          COMPLETE
└── docs/
    └── PLAN.md                           THIS FILE
```

---

## 10. Source of Truth References

When populating SKILL.md files, always fetch from arscontexta as the canonical source:

```bash
# Fetch a skill-source SKILL.md
gh api /repos/agenticnotetaking/arscontexta/contents/skill-sources/{name}/SKILL.md \
  | python3 -c "import json,sys,base64; d=json.load(sys.stdin); print(base64.b64decode(d['content']).decode())"

# Fetch a plugin-skill SKILL.md (note: in arscontexta these live under skills/, not plugin-skills/)
gh api /repos/agenticnotetaking/arscontexta/contents/skills/{name}/SKILL.md \
  | python3 -c "import json,sys,base64; d=json.load(sys.stdin); print(base64.b64decode(d['content']).decode())"
```

The arscontexta skill-sources directory name → intent-computer skill-sources directory name mapping is 1:1.

The arscontexta skills directory → intent-computer plugin-skills directory mapping:
- `arscontexta/skills/{name}/SKILL.md` → `intent-computer/src/plugin-skills/{name}/SKILL.md`

Config templates should be restored from git history:
```bash
git show HEAD:src/config/derivation-manifest-template.md
git show HEAD:src/config/mcp-template.json
git show HEAD:src/config/opencode-template.json
```

Deleted TypeScript skill stubs:
```bash
git show HEAD:src/skills/fork.ts
git show HEAD:src/skills/injector.ts
# etc.
```
