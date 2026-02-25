# Viral Feature Proposal: Intent Capsules

## One-line pitch

Turn any high-value result in the vault into a shareable "Intent Capsule" that other people can import and run in their own intent-computer, with one-click fork behavior built in.

## Why this is high leverage

The product already creates useful private outputs (notes, decisions, workflows, memory updates), but those outputs do not currently carry an acquisition loop. Intent Capsules convert private outcomes into portable artifacts that:

1. Deliver standalone value when read.
2. Invite the reader to fork the workflow into their own vault.
3. Attribute the origin and show derivative reuse, creating social proof.

This makes every successful user session a potential distribution event.

## Core user flow

### Creator flow

1. User runs `/arscontexta:publish` on a note, map, or completed queue item.
2. Plugin generates a normalized capsule file with:
   - problem and intent
   - context snapshot
   - execution steps
   - outcome and evidence
   - "fork this" metadata
3. Capsule is saved to `ops/capsules/YYYYMMDD-slug.md`.
4. User gets a share URL (or local file for manual sharing).

### Recipient flow

1. Recipient opens capsule URL and sees concise value immediately.
2. Recipient clicks "Fork to my intent computer" (or runs `intent-computer import <url>`).
3. Plugin imports capsule into recipient `inbox/` and creates an aligned task in queue.
4. Recipient runs it with local vocabulary and context mapping.

## Viral mechanism

Each capsule embeds a reusable action, not just static content.

- Read value: people can benefit without installing.
- Action value: one command to execute/adapt.
- Identity loop: capsule records author + derivative count.
- Re-share loop: imported capsules can be improved and re-published.

This creates a content network where usage naturally emits more shareable artifacts.

## Proposed product surface

### New commands

- `/arscontexta:publish` - generate and optionally publish a capsule.
- `/arscontexta:import` - import a capsule URL/file into inbox + queue.
- `/arscontexta:capsules` - list local capsules and derivative stats.

### Capsule schema (markdown frontmatter)

```yaml
---
type: intent-capsule
title: "How I turned raw meeting notes into weekly decisions"
origin_author: "@user"
origin_vault_id: "vault_abc123"
created_at: "2026-02-20T16:00:00Z"
intent: "Convert unstructured notes into decision-ready artifacts"
inputs:
  - source_notes
  - weekly_goals
steps:
  - reduce
  - reflect
  - next
outcome:
  metric: "decision latency"
  before: "5 days"
  after: "1 day"
fork_command: "intent-computer import https://.../capsule.md"
---
```

## Architecture fit (current repo)

- Skill layer:
  - add `packages/plugin/src/plugin-skills/publish/SKILL.md`
  - add `packages/plugin/src/plugin-skills/import/SKILL.md`
- Runtime layer:
  - queue import task via existing queue contracts in `packages/architecture/src/queue.ts`
  - write imported artifacts into existing inbox path conventions
- Session loop:
  - use `sessionCapture` output to suggest publish candidates after high-signal sessions
- Policy:
  - apply redaction rules before publish (PII, secrets, private identifiers)

## MVP scope (first release)

1. Local capsule generation (`publish` writes file only).
2. URL import from raw markdown (`import` to inbox + queue task).
3. Manual publish to GitHub Gist or repo file (no new backend required).
4. Basic redaction pass (emails, phone numbers, API keys).
5. Derivative tracking via frontmatter lineage fields.

## Success metrics

Primary:
- `capsules_per_active_user_per_week`
- `share_to_import_rate`
- `import_to_activated_vault_rate` (recipient completes setup + first run)

Secondary:
- `time_to_first_value` for imported capsule
- `% imported capsules re-published`
- 4-week retained users who first arrived via capsule

## Risks and mitigations

- Privacy leakage in published capsules:
  - mitigation: mandatory redaction + preview confirmation before publish
- Low-quality spam capsules:
  - mitigation: require outcome/evidence fields and minimum structure checks
- Poor cross-vault portability:
  - mitigation: vocabulary normalization against `ops/derivation-manifest.md` on import

## Why this should be prioritized now

This feature reuses existing strengths (skills, queue, vault artifacts, session continuity) and adds the missing distribution primitive. It can ship as a mostly local-first workflow, then expand to hosted discovery later without architectural rework.
