# [intent-computer](https://github.com/hellofrommorgan/intent-computer)

**The intent computer -- a protocol for intent realization.**

A five-layer cognitive architecture that gives AI agents persistent identity, memory, and autonomy. You bring the intent. The system closes the loop between knowing and doing -- vault context injected at session start, notes validated on write, sessions captured on exit, working memory updated so the next session starts knowing who you are and what you were doing.

## What is this?

Most agent tooling treats the human as a prompt engineer and the agent as a stateless function. The intent computer inverts this.

- **Intent is the primitive, not instructions.** The system does not execute commands. It receives intent -- a statement of what you want to be true -- and routes it through perception, identity, commitment, memory, and execution. Every computation traces back to a human reason.
- **Persistent identity and memory across sessions.** The agent reads its identity before loading capabilities. Working memory, goals, and context survive session boundaries. Session N+1 starts where session N left off.
- **Files are the canonical state.** Markdown, YAML frontmatter, wiki links, git history. Human-readable, version-controlled, portable. No database. No proprietary format. The filesystem is the database; ripgrep is the query engine.
- **Amplifies intent without generating it.** The system never invents its own reasons to act. It is a bicycle for the mind -- it makes your thinking faster and more connected, but the direction is always yours.

## Architecture

The intent computer implements a five-layer loop:

```
Perception --> Identity --> Commitment --> Memory --> Execution
    ^                                                    |
    +----------------------------------------------------+
```

**Perception** ingests signals from the environment (session context, vault state, maintenance conditions). **Identity** loads the agent's normative structure, determining what matters and what doesn't. **Commitment** evaluates intent against identity and decides what to act on. **Memory** reads and writes durable state (thoughts, maps, working memory). **Execution** dispatches actions through policy-gated skill invocation.

The loop runs continuously. The heartbeat keeps it running between sessions.

### Packages

| Package | Purpose |
|---------|---------|
| `@intent-computer/architecture` | Canonical domain types, port interfaces, and contract definitions |
| `@intent-computer/plugin` | Runtime hooks, skills, and vocabulary resolution for coding agents |
| `@intent-computer/heartbeat` | Between-session autonomy engine -- evaluates commitments, processes queues, updates the morning brief |
| `@intent-computer/mcp-server` | MCP server implementing the storage and retrieval boundary |

## Platform Support

| Platform | Install | Status |
|----------|---------|--------|
| [OpenCode](https://opencode.ai) | Add `"intent-computer"` to `opencode.json` plugins | Native |
| [Claude Code](https://claude.ai/code) | `npx intent-computer install --claude-code` | Supported |
| [pi.dev](https://pi.dev) | `npx intent-computer install --pi` | Supported |
| [OpenClaw](https://openclaw.ai) | `openclaw plugins install intent-computer` | Supported |

## Quick Start

```bash
# Install
npm install intent-computer

# Run setup (interactive -- creates your vault)
# Then use /setup in your coding agent
```

The `/setup` command walks you through a derivation conversation, generates your vault structure, wires hooks, and deploys skills. The vault is yours -- plain files in a git repo.

## Hooks (Always-On)

Hooks run automatically. No invocation needed. They short-circuit immediately in non-vault projects.

| Hook | Trigger | What it does |
|------|---------|--------------|
| **Session Orient** | Every LLM call + context compaction | Injects identity, working memory, goals, and morning brief into the system prompt. Surfaces maintenance conditions. |
| **Write Validate** | After every write to a vault note | Validates YAML frontmatter: required fields, description quality, schema compliance. Warnings surface inline. |
| **Auto Commit** | After every write to a vault note | Stages and commits the change. Vault history stays clean without manual git. |
| **Session Capture** | On session end | Writes session metadata to `ops/sessions/` and commits the artifact. |
| **Session Continuity** | On session end | Updates `self/working-memory.md` so the next session starts warm. |

## Skills (On Demand)

Skills are structured instruction files (`SKILL.md`) the agent follows when you invoke a command. Vocabulary placeholders make them portable across vaults with different naming conventions.

**Operational skills** -- working with your vault:

`reduce` `reflect` `reweave` `verify` `validate` `seed` `ralph` `pipeline` `tasks` `stats` `graph` `next` `learn` `remember` `rethink` `refactor` `reanalyze`

**Plugin skills** -- system management:

`setup` `help` `health` `ask` `recommend` `architect` `add-domain` `reseed` `tutorial` `upgrade`

## The Intent Loop

The loop is not a pipeline that runs once. It is a continuous cycle.

During a session, the plugin drives the loop: orient loads context (perception + identity), skills execute within policy gates (commitment + execution), hooks persist state (memory). Between sessions, the heartbeat takes over -- evaluating pending commitments, processing queued work, and preparing the morning brief for the next session.

**Authority levels** govern what the system can do autonomously: `none`, `advisory`, `delegated`, `autonomous`. Authority is earned through demonstrated judgment, not granted by default. The heartbeat starts advisory and escalates only when configured.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

The test suite covers architecture contracts, runtime integration, regression cases, and fork compatibility.

## Principles

Seven zeroth principles define the structural commitments of the intent computer. These are not aspirational -- they are load-bearing. A system that violates one is a different system.

- **Z0: Intentionality precedes computation.** Without a reason to compute, computation is noise.
- **Z1: Identity precedes capability.** Before "what can it do?" answer "who is doing it?"
- **Z2: Context is the computer.** The context window is the computational substrate, not a cache.
- **Z3: Relation precedes representation.** Capabilities emerge through interaction, not from pre-built catalogs.
- **Z4: Compression is the direction of intelligence.** Intelligence moves toward less, not more.
- **Z5: Error is signal, not noise.** Failures are the learning mechanism, not bugs to suppress.
- **Z6: Autonomy is temporal, not spatial.** The agent that acts when conditions demand it is fundamentally different from one that waits.

Full treatment with formal anchors and diagnostics: [`docs/vision/PRINCIPLES.md`](docs/vision/PRINCIPLES.md)

## Acknowledgments

The knowledge architecture -- atomic thoughts, wiki-link graphs, structured processing pipelines, condition-based maintenance, and the vault-as-filesystem pattern -- is built on [Ars Contexta](https://github.com/agenticnotetaking/arscontexta). The intent computer extends that foundation with the five-layer intent loop, commitment tracking, between-session autonomy, and multi-platform hook adapters.

## License

MIT
