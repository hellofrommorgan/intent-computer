---
name: intent-computer-session-orient
description: Injects vault context (identity, goals, working memory) into the agent bootstrap
events:
  - agent:bootstrap
priority: 10
---

# Session Orient

On `agent:bootstrap`, reads the vault's core context files and injects them
into the agent's bootstrap context via `event.context.bootstrapFiles`.

This is the OpenClaw equivalent of the intent-computer's session orient phase.
The agent starts each session already knowing who it is, what it's working on,
and what happened last time.

## Injected Files

- `self/identity.md` -- agent identity and personality
- `self/goals.md` -- current goals and active threads
- `self/working-memory.md` -- warm context from previous sessions
- `ops/morning-brief.md` -- daily briefing (if present)
- `ops/reminders.md` -- time-bound commitments (if present)

## Vault Detection

The vault path is resolved in order:

1. `INTENT_COMPUTER_VAULT` environment variable
2. `~/Mind/` (canonical location)
3. Common fallback paths (`~/mind/`, `~/Documents/Mind/`, `~/notes/`)

If no vault is detected, the hook is a no-op.
