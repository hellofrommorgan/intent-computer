---
name: pipeline
description: DEPRECATED. `/pipeline` is replaced by queue-first orchestration: `/seed` then `/process`.
version: "1.2"
generated_from: "wave-1.2-contract-hardening"
user-invocable: false
context: fork
allowed-tools: Read
argument-hint: "(deprecated)"
---

## Deprecated

`/pipeline` is no longer a user-facing command.

Use:
1. `/seed [file]` to enqueue source material.
2. `/process [N]` to advance queued tasks.

## Rationale

Queue-first orchestration provides one runtime path, consistent telemetry, and consistent failure/repair behavior.
