# Architecture Opinions

> **Canonical technical spec:** [methodology/architecture.md](../../methodology/architecture.md) defines the five-layer architecture, port interfaces, domain types, and the intent loop. This document covers the *why* behind each opinion -- the rationale and conviction that the spec does not repeat.

Every major design choice in the intent computer is an opinion held with conviction. This document states each opinion and its rationale. No alternatives-considered. No apologies.

---

## Why Files

Files are the canonical state of the intent computer. Not because they are simple -- because they are the only abstraction where human and machine meet as equals. Both can read, write, edit, version, and inspect files without mediation. A vector database makes the human a client of their own agent's state. A relational database requires a query language the human must learn to inspect their own knowledge. Files make the human a peer.

This is an alignment position, not a simplicity preference. The moment the canonical state lives in a format the human cannot directly inspect, the power relationship shifts. The agent knows things the human cannot verify without the agent's help. Files prevent that dependency from forming. Git provides versioning. grep provides search. The ecosystem is 50 years deep and maintained by the entire software industry. No purpose-built agent infrastructure will match that depth in our lifetimes.

---

## Why Markdown

Markdown is the format at the intersection of human readability and language model comprehension. It is structured enough to be useful -- YAML frontmatter for metadata, headings for hierarchy, lists for enumeration, wiki links for graph edges -- and transparent enough that a human can read the raw file without rendering. The cost of markdown is zero: no build step, no parser dependency, no schema migration.

Agent behavior is already being defined as prose across the entire industry. CLAUDE.md, AGENTS.md, Cursor Rules -- these are all markdown files that program agent behavior through natural language. Markdown is not a compromise format chosen for lack of a better option. It is the agent's native language. The intent computer leans into this rather than fighting it.

---

## Why Wiki Links Over Foreign Keys

Wiki links are bidirectional, human-readable, and emergent from content. A link is a string in double brackets. grep finds all backlinks to any thought in milliseconds. The graph is derived from file contents -- never stale, never out of sync with the data it describes, never requiring a separate consistency check.

Foreign keys require a schema, a migration system, a query engine, and a consistency enforcement layer. They separate the relationship from the content it connects, creating two sources of truth that can diverge. Wiki links require a text editor and grep. The entire graph is inspectable by a human with no tooling beyond what ships with every operating system. When the choice is between a system that requires infrastructure and a system that requires literacy, choose literacy.

---

## Why Skills as Markdown, Not Code

Skills are memetic activators. They do not instruct a reasoning engine -- they activate cultural patterns already compressed inside language models. The model already knows how to extract insights, find connections, validate quality, summarize arguments, and detect contradictions. It learned these patterns from millions of documents written by humans performing these tasks. The skill's job is to select the right pattern and aim it at the right context.

More code means more accidental complexity: error handling, type coercion, API versioning, dependency management. More markdown means more precise pattern activation with less noise. A SKILL.md file that grows longer than two pages is not becoming more capable -- it is becoming more confused about which pattern it is trying to activate. The compression direction applies to skills as much as to knowledge.

---

## Why Propositions, Not Entities

Entities are facts without arguments. Propositions are claims that can be connected, contested, and revised. "Anxiety" is an entity -- a label that points at a category. "The anxiety before speaking is the same anxiety before writing" is a proposition -- a claim that creates a relationship, invites disagreement, and compounds with other claims.

Knowledge graphs built on entities accumulate: more nodes, more labels, more categories, but no increase in understanding. Knowledge graphs built on propositions compound: each new claim strengthens or challenges existing claims, creating a network where the connections carry more insight than the nodes. A vault of propositions is a body of argument. A vault of entities is a glossary.

---

## Why Five Layers Designed Together

The intent loop has five layers: perception, identity, commitment, memory, execution. These layers must constrain each other from the first line of code because optimizing any layer in isolation creates assumptions that break the others.

Perception optimized for productivity breaks memory for research -- it filters out the ambient signals that research depends on. A commitment engine designed for task management carries assumptions about completion and linearity that fail for creative work. Execution authority calibrated for enterprise has the wrong trust model for an intimate companion. Port-based design forces the integration conversation to happen explicitly at layer boundaries rather than implicitly after specialization has locked in incompatible choices. The five layers are not a roadmap to be built sequentially. They are a simultaneous constraint satisfaction problem.

---

## Why Advisory by Default

The system's default authority level is advisory: propose, don't act. This is not timidity. It is the correct starting point for a trust relationship that has not yet been established. Authority escalates through demonstrated judgment -- from advisory to delegated to autonomous -- and every escalation is revocable.

A system that starts autonomous has not earned trust; it has assumed it. The assumption that good intentions plus capability equals appropriate authority is the failure mode of every system that acts on the user's behalf without the user's informed consent. The capable silence principle: the highest expression of earned authority is restraint. An agent that can act but chooses to advise until trust is established is demonstrating exactly the judgment that warrants eventual autonomy.

---

## Why Condition-Based, Not Time-Based Maintenance

Time-based maintenance runs regardless of need. A daily 8am job processes the inbox whether it has zero items or fifty. It runs the health check whether the vault changed or not. It treats the calendar as a proxy for reality and accepts the mismatch as the cost of simplicity.

Condition-based maintenance acts when reality warrants it: process when inbox exceeds three items, connect when orphan thoughts exceed five, revisit when thoughts go stale. This is more aligned with temporal autonomy (Z6) because it requires the system to evaluate whether action is appropriate, not merely whether the clock says so. Condition-based triggers encode judgment about when maintenance matters. Time-based triggers encode an admission that you cannot determine when maintenance matters.

---

## Why Fresh Context Per Phase

The processing pipeline runs each phase -- surface, reflect, revisit, verify -- in a fresh context window. This is not an implementation constraint. It is a quality requirement.

Chaining phases in one context degrades quality because stale context activates stale patterns. The model that just surfaced an insight is primed to see that insight everywhere, reducing the reflect phase to confirmation rather than genuine connection-finding. Fresh context per phase is Vygotsky's Zone of Proximal Development applied to language models: different cognitive tasks need different scaffolding, and the scaffolding from the previous task actively interferes with the current one. The cost is additional API calls. The benefit is that each phase does its actual job instead of performing a degraded version of the previous phase's job.

---

## Why Local-First

The vault lives on the local filesystem. Cloud adapters exist for distribution -- sync, backup, multi-device access -- but the canonical copy is local. This is a dependency decision: the system's core function must not depend on network availability, service uptime, API pricing changes, or terms of service revisions.

Local-first means zero infrastructure cost for the base case. Zero latency for reads. Zero dependency on external services for core function. Full inspectability via any file browser. Full version control via git. Full portability -- copy the directory, and the system moves with it. Cloud is an optimization for specific use cases, not the architecture. A system that requires cloud connectivity to function has outsourced its reliability to someone else's priorities.

---

## Why TypeScript

The intent computer is primarily an orchestration system: loading skills, wiring hooks, managing the intent loop, implementing port adapters. TypeScript provides type safety that encodes philosophical commitments as compiler-enforced constraints. GapClass, DesireClass, ActionAuthority -- these are types, not strings. The compiler rejects code that confuses an incidental gap with a constitutive one.

TypeScript is also the language of the ecosystem the intent computer lives in. Claude Code, MCP servers, VS Code extensions, npm packages -- the toolchain is TypeScript-native. Choosing a different language would mean fighting the ecosystem rather than leveraging it. The types ARE the architecture documentation. When the types and the prose disagree, the types are more current.

---

## Why Not a Framework

Frameworks provide scaffolding for other people's products. The intent computer is not scaffolding -- it is the protocol that makes frameworks unnecessary. The skill system is the extension point. If you want to extend the intent computer, you write a SKILL.md file, not a module with lifecycle hooks and dependency injection.

Frameworks impose opinions about how extensions should be structured, versioned, distributed, and composed. Those opinions inevitably conflict with the intent computer's own opinions about authority, compression, and context-as-computation. A plugin API is an invitation to build complexity that the core system must then manage. A SKILL.md file is a markdown document that activates a pattern. The framework is the language model. The extension API is natural language.

---

## Why the Pilgrimage Problem Matters

Some gaps between intent and outcome are load-bearing. The struggle IS the product. A system that compresses every gap between wanting and having will eventually compress the gaps that give the outcome its value.

Creative work requires creative resistance. Learning requires the discomfort of not-yet-knowing. Relationship-building requires the vulnerability of genuine encounter. These are constitutive gaps -- the friction is not incidental to the outcome but constitutive of it. The system must classify every gap it encounters: incidental gaps should be compressed aggressively, constitutive gaps should be protected absolutely. Getting this classification wrong is not merely inefficient -- it is value destruction disguised as efficiency. The pilgrimage is not a bug in the transportation system.
