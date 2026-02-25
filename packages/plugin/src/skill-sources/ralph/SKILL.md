---
name: ralph
description: Deprecated skill-source artifact for the `/process` queue contract. `/process` is the only user-facing orchestration command.
version: "1.2"
generated_from: "wave-1.2-contract-hardening"
user-invocable: true
context: fork
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
argument-hint: "N [--batch id] [--dry-run]"
---

## Status

This skill source is maintained as a compatibility artifact. Runtime orchestration is implemented directly in plugin code and invoked through `/process`.

## Contract

- Accept `/process` as the queue executor command.
- Process pending queue tasks one phase at a time.
- Persist queue status transitions after each task.
- Return explicit success/failure results.
- Never invoke nested Task-tool subagents from this skill source.

## Guidance

- If queue is empty: report `Queue is empty — nothing to process. Run /seed [file] to queue source material.`
- If tasks remain: recommend `Run /process`.
- If task execution fails: return failure and allow runtime repair policy to queue a repair task.

## Deprecated

`/pipeline` and `/ralph` are deprecated user-facing commands.
