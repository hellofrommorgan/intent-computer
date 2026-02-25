---
name: intent-computer-session-capture
description: Captures session artifacts and commits vault state on session end
events:
  - command:stop
  - command:reset
priority: 90
---

# Session Capture

On `command:stop` or `command:reset`, persists session state to the vault:

1. **Stages** session artifacts: observations, methodology notes, goals, working memory
2. **Commits** with a timestamped message: `session: capture YYYY-MM-DDTHH-MM-SS`

This is the OpenClaw equivalent of the intent-computer's session-capture hook.
It ensures no session work is lost even if the user forgets to commit.

## What Gets Committed

- `ops/sessions/` -- session metadata
- `ops/observations/` -- friction signals captured during the session
- `ops/methodology/` -- methodology updates
- `self/goals.md` -- current goals state
- `self/working-memory.md` -- working memory state

## Vault Detection

Same resolution order as session-orient. No-op if no vault is detected.
