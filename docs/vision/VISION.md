# Vision

The intent computer is a protocol for intent realization. It is what remains when you remove everything between wanting and having that does not need to be there.

It is not a chatbot, an LLM OS, an agent framework, a hypervisor, a GUI for agents, or an automation tool.

## The Core Claim

Intent is the fundamental computing primitive. Not instructions. Not prompts. The system resolves intents through skill graphs and context graphs on a filesystem. The human provides direction; the system provides structure.

## The Bicycle Principle

The bicycle does not pedal itself.

A more intentional person gets more from the system. A less intentional person gets less. The system amplifies intent — it never generates or substitutes for it. This is non-negotiable. Features that erode this property are bugs, regardless of how useful they appear.

## Zeroth Principles

- **Z0: Intentionality precedes computation.** The system does nothing without a reason to act.
- **Z1: Identity precedes capability.** Who you are determines what you can do, not the reverse.
- **Z2: Context is the computer.** CLAUDE.md programs the agent. SKILL.md is the executable. The compiler is the language model.
- **Z3: Relation precedes representation.** A thought without connections is a thought that will never be found. Links are first-class.
- **Z4: Compression is the direction of intelligence.** Each evolution simplifies while expanding capability. The next step is always less, not more.
- **Z5: Error is signal, not noise.** Failures carry information. The system learns from friction, not just success.
- **Z6: Autonomy is temporal, not spatial.** An agent earns the right to act over time, not by occupying a privileged position in a hierarchy.

## Priority Stack

1. The intent loop works end-to-end (five layers compose correctly)
2. The commitment engine is an engine, not a field
3. The heartbeat demonstrates temporal autonomy with judgment
4. Skills compress without quality loss
5. Trust architecture makes computer use auditable
6. Multi-agent coordination via filesystem

If priorities conflict, the lower number wins. Always.

## Architectural Opinions

These are non-negotiable unless explicitly overridden by the priority stack.

**Files over databases.** Markdown files, YAML frontmatter, wiki links, git. The canonical state is human-readable files under version control. Everything else is a derivative cache.

**Skills are markdown, not code.** SKILL.md files activate cultural patterns in language models. They do not instruct reasoning engines. A skill that requires a specific model has failed at compression.

**Context IS computation.** There is no separate "program" and "data." CLAUDE.md is the program. The vault is the memory. The filesystem is the runtime. The language model is the compiler.

**Proposition-native memory.** The unit of knowledge is the titled claim, not the entity or fact. "Morning routine breaks the inertia" is a proposition. "Morning routine" is a label. Labels are not knowledge.

**The five-layer loop.** Perception, Identity, Commitment, Memory, Execution. Designed together, not sequentially. A system missing any layer compensates with hacks in the others.

**Authority escalation.** None, advisory, delegated, autonomous. Default is advisory. Trust is earned through demonstrated judgment, never assumed. Escalation is always revocable.

## The Steerability Bet

We bet on steerability over capability. Making the haystack bigger does not make the needle easier to find.

The intent computer should work with any sufficiently capable model. If the architecture depends on specific model capabilities, we have papered over the steerability gap, not closed it. Capability scaling (bigger models, more tools) is never preferred over steerability (tighter coupling between intent and outcome).

## The Simplification Direction

Each evolution simplifies while expanding capability. Skill graphs simplified prompt engineering. Agentic CLIs simplified tool integration. agents.md simplified multi-agent reasoning. The theoretical minimum is CLAUDE.md + vault.

If a proposed change adds complexity, it must remove more complexity than it introduces. If it cannot, it waits until it can.

## What We Will Not Build

- **Vector databases as primary storage.** Files are canonical. Vector search is a read-only cache over them.
- **Complex orchestration frameworks.** Skills compose via filesystem, not message buses.
- **Multi-tenant SaaS that compromises local-first.** Cloud adapters exist for distribution, not as the default.
- **Agent hierarchy frameworks.** No manager-of-managers. No nested planner trees. Coordination is peer-to-peer on the filesystem.
- **GUI wrappers that hide the filesystem.** The filesystem IS the interface. GUIs that surface the filesystem are fine. GUIs that replace it are not.
- **Capability scaling over steerability.** Never trade coupling quality for raw power.
- **Features that compress constitutive friction.** Some gaps between intent and outcome are load-bearing. The pilgrimage is not a bug in the transportation system.

This list is a design guardrail, not a law of physics. Strong user demand and strong evidence can change it. But the burden of proof is on the proposer.
