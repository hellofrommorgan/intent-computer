---
name: intent-computer-write-validate
description: Validates vault thought schema after writes and auto-commits changes
events:
  - message:sent
priority: 20
---

# Write Validate

On `message:sent`, scans the agent's last message for vault file writes.
When a write to `thoughts/`, `inbox/`, or other note paths is detected:

1. **Validates** YAML frontmatter against the vault schema (description, topics, etc.)
2. **Auto-commits** the change to git with a descriptive message

This is the OpenClaw equivalent of the intent-computer's write-validate and
auto-commit hooks combined.

## Validation Checks

- YAML frontmatter delimiters present
- `description` field present and substantive (not just restating the title)
- `topics` field present with at least one map link
- Filename convention (prose-with-spaces, not kebab-case)

## Auto-Commit

After validation, stages the changed file plus key vault state directories
(`self/`, `ops/`, `inbox/`) and commits with message format:
`auto: update N note(s) -- [filenames]`

## Vault Detection

Same resolution order as session-orient. No-op if no vault is detected.
