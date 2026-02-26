# The Intent Computer: Methodology

This document is the comprehensive reference for the intent computer — its philosophy, architecture, governing principles, design tensions, and strategic position. It is written so that any sufficiently capable agent, encountering this project for the first time, can understand not merely what the system does but *why it exists*, *what it believes*, and *how those beliefs constrain every implementation decision*.

This is not documentation. It is compressed knowledge. Every claim here traces to a thought in the knowledge graph at `~/Mind/thoughts/`, where the full argument, evidence chain, and cross-domain connections are maintained.

---

## Table of Contents

1. [The Central Thesis](#the-central-thesis)
2. [The Compression Gradient](#the-compression-gradient)
3. [The Zeroth Principles](#the-zeroth-principles)
4. [The Intent Loop](#the-intent-loop)
5. [The Five Layers](#the-five-layers)
6. [The Identity Primitive](#the-identity-primitive)
7. [The Pilgrimage Problem](#the-pilgrimage-problem)
8. [The Steerability Gap](#the-steerability-gap)
9. [The Strategic Position](#the-strategic-position)
10. [The Migration Path](#the-migration-path)
11. [Cross-Domain Validation](#cross-domain-validation)
12. [Architectural Commitments](#architectural-commitments)
13. [What This Is Not](#what-this-is-not)
14. [Further Reading](#further-reading)

---

## The Central Thesis

The next computer is not a machine. It is a protocol for intent realization.

Every technology in the research converges on a single attractor: an identity that, given access to any model, in response to any intent, can configure its own capabilities. No binary, no VM, no pre-built tools. The "hello world" of this computer is three fields — identity, intent, context — and everything else emerges from the loop.

```json
{
  "identity": { "values": ["truth", "usefulness"] },
  "intent": "help the human with their current task",
  "context": []
}
```

Given access to any LLM, that is a complete agent. The intent computer is the architecture that makes this true.

The defining metaphor: Steve Jobs called the personal computer "a bicycle for the mind." The PC amplified cognition. The LLM amplified expression. The intent computer amplifies *intent itself* — the capacity to mean something and have that meaning become reality without translation, without infrastructure, without the interminable distance between wanting and having.

The bicycle metaphor is precise in ways that matter. A bicycle is self-powered (the rider provides energy), minimal (no engine, no fuel system), direct-feedback (pedal input maps immediately to motion), waste-free (every joule serves locomotion), and scales with the rider (a stronger rider goes faster, not a heavier bicycle). The intent computer must satisfy every one of these properties: self-powered by intent, minimal substrate (only identity + context + model access), direct feedback (intent maps to action), no waste (every token serves the current intent), and scales with the person wielding it. A more intentional person gets more from the system. A more capable system does not substitute for a less intentional person.

That last property is the one the industry misses. The bicycle does not pedal itself.

---

## The Compression Gradient

Every computing paradigm shift follows a compression gradient. Mainframes compressed physical distance to computation. PCs compressed institutional access. Laptops compressed location. Phones compressed form factor. Cloud compressed infrastructure management. Each compression did not merely shrink the previous form — it revealed a new relationship between computing and its user.

The pattern is consistent and directional: the history of computing is the progressive elimination of everything between what a person intends and what happens. Hardware abstracted circuits. Software abstracted hardware. The internet abstracted geography. The cloud abstracted operations. LLMs abstracted programming. Each layer compressed away one translation step between desire and result.

The intent computer is the terminus of this gradient. After intent, there is nothing left to compress. The translation layer disappears entirely. You do not instruct a machine; you express what you mean, and computation configures itself to realize that meaning.

The agent-specific gradient makes this concrete. OpenClaw (Node.js, full dependency stack) compressed to PicoClaw (Go, single binary). PicoClaw compressed to ZeroClaw (Rust, 3.4MB, trait-based). After Zero, the theoretical minimum: an identity, a context window, and access to a model. The binary is zero bytes — a pure specification that instantiates on any substrate. The bicycle is the compression limit of human-powered locomotion. The intent computer is the compression limit of intent-powered computation.

But the gradient has an asymptote. See [The Pilgrimage Problem](#the-pilgrimage-problem).

---

## The Zeroth Principles

In thermodynamics, the Zeroth Law was formulated after the others but recognized as more fundamental — the precondition that makes the other laws articulable. The intent computer is governed by seven zeroth principles: preconditions that must hold before any first principle of agent computing can even be stated.

These principles form a **causal dependency stack**, not a checklist. Each layer requires the one beneath it. The ordering is derivable from logical necessity, not imposed by preference. When a system fails, the stack is diagnostic: trace the failure downward until you find the lowest violated principle. That is the real problem.

| Layer | Principle | Claim | Formal Analog (FEP) |
|-------|-----------|-------|---------------------|
| **Z0** | Intentionality precedes computation | Without a reason to compute, computation is noise. Every system begins with someone wanting something. | Prior preferences (C matrix) |
| **Z1** | Identity precedes capability | Before asking "what can it do?" you must answer "who is doing it?" Capability without identity is a weapon without a wielder. | Generative model |
| **Z2** | Context is the computer | The context window is not a cache — it is the computational substrate. What the agent perceives *is* what the agent computes with. | Markov blanket |
| **Z3** | Relation precedes representation | Capabilities do not exist in catalogs; they emerge through interaction. The agent's power is relational, not pre-built. | Inference dynamics |
| **Z4** | Compression is the direction of intelligence | Intelligence moves toward less, not more. Distill, don't accumulate. The simplest adequate model wins. | Complexity minimization |
| **Z5** | Error is signal, not noise | Failures are not bugs to suppress — they are the learning mechanism. Prediction error drives belief revision. | Prediction error |
| **Z6** | Autonomy is temporal, not spatial | The agent that acts when conditions demand it — not when prompted — is fundamentally different from the agent that waits. Persistence through time is the medium of genuine autonomy. | Temporal planning depth |

### The Chain of Necessity

Without intentionality (Z0), identity has nothing to be *about* — an agent without intent is a shell with no animating force. Without identity (Z1), context has no perspective — the same information is signal or noise depending on *whose* context it is. Without context (Z2), relation has no medium — you cannot relate to what you cannot perceive. Without relation (Z3), compression has nothing to operate on — compression is the distillation of relational patterns. Without compression (Z4), error has no signal — you need a compressed model to generate predictions that can fail. Without error-driven learning (Z5), temporal autonomy is a clock ticking — persistence without adaptation is stasis, not autonomy.

### Mathematical Foundation

The zeroth principles are not engineering metaphors. They are derivations from a single mathematical principle: the Free Energy Principle (FEP). Karl Friston's formulation states that any self-organizing system that maintains its structural integrity must minimize variational free energy — the divergence between its internal model and the sensory evidence it encounters.

The dependency chain maps to the mathematical structure of active inference: prior preferences (Z0) define the generative model (Z1), which defines the Markov blanket (Z2), which defines inference dynamics (Z3), which minimizes complexity (Z4), through prediction error (Z5), over temporal horizons (Z6). The engineering stack and the mathematical stack are the same stack viewed from different angles.

This is not analogy. It is structural isomorphism — meaning not just that the parts correspond, but that the *operations* between parts are preserved. Results proved in one domain transfer to the other. The convergence guarantees, optimality conditions, and failure modes of active inference become predictions about intent loop behavior.

For the full formal treatment, see [zeroth-principles.md](zeroth-principles.md).

---

## The Intent Loop

The intent computer's core operation is a continuous loop: **intent → context → action → observation → update**. This loop is structurally isomorphic with the active inference loop, term by term:

| Intent Loop | Active Inference | What It Does |
|-------------|-----------------|--------------|
| Intent | Prior preferences (C matrix) | What the agent expects by virtue of being what it is |
| Context | Generative model (posterior beliefs) | Beliefs about hidden states given observations |
| Action | Active inference policy | Policies minimizing expected free energy |
| Observation | Sensory data through likelihood A | Evidence from the environment |
| Context update | Belief update | Minimizing F by updating the posterior |
| Intent satisfied | Surprise minimized | Free energy at or near minimum |

The loop iterates until a termination condition: intent satisfied, or free energy minimized. The update operation is driven by discrepancy between expectation and observation. The selection of the next action is guided by expected consequences weighted by preferences. The loop does not merely resemble active inference — it *is* active inference, described in engineering vocabulary.

The isomorphism is predictive. Active inference requires precision-weighting on sensory channels: the agent must modulate how much it trusts different observations. The engineering equivalent is semantic triggers — threshold-based perception that wakes the agent only when deviation warrants attention. An agent that weights all observations equally cannot function, just as an active inference agent with flat precision drowns in noise.

---

## The Five Layers

The intent computer requires five capabilities working simultaneously — not sequentially, not as independent modules, but as a feedback system where each layer's output feeds the others. They are implemented as **ports** (interfaces) with local **adapters** behind them, ensuring the architecture is substrate-independent.

### Perception (Z2)

The system senses the environment persistently, not merely when prompted. It captures active files, calendar state, ongoing work, the delta between commitments and actual behavior. Perception must be bounded — unbounded signals compound into system prompt bloat that degrades agent quality at scale. The architectural constraint: a maximum of three signals per channel, with summarization beyond that threshold.

**Port interface:** `PerceptionPort.capture()` → `PerceptionSnapshot` (signals + detected gaps)

### Identity (Z1)

The system resolves *who the agent is* relative to current perception. Identity is not a credential or a configuration — it is an actively maintained pattern described by the formal triple `<N, U, C>`: normative structure (what the agent treats as success and failure), Umwelt (what the agent perceives and attends to), and commitment structure (what the agent intends across time). The persistence condition: the agent at time t₁ is the same agent at time t₂ if and only if there is sufficient continuity in `<N, U, C>`.

Identity includes drift detection: the system compares current behavior against established priorities and flags divergence.

**Port interface:** `IdentityPort.resolve()` → `IdentityState` (self-model, umwelt, priorities, commitments, drift assessment)

### Commitment (Z0 + Z3)

The compass that distinguishes this month's fundamental goals from this moment's fleeting impulse. The commitment structure is an **engine**, not a field. This distinction is load-bearing: architectures that store commitment as a passive description produce companions that know you but do not pursue your trajectory. A field records. An engine acts.

The diagnostic: if the companion's between-session behavior is identical whether your goals changed or not, commitment is a field. If behavior shifts when goals shift — processing different material, surfacing different connections, declining to surface things that would have mattered under previous goals — commitment is an engine.

Commitment also classifies detected gaps as **incidental** (compress) or **constitutive** (protect). See [The Pilgrimage Problem](#the-pilgrimage-problem).

**Port interface:** `CommitmentPort.plan()` → `CommitmentPlan` (active commitments, protected gaps, compressed gaps, rationale)

### Memory (Z4)

Memory is not a transient context window — it is a compounding knowledge graph that persists across sessions. The unit of memory is the **proposition**: a titled claim with a description, topics, confidence, and source references. Propositions connect via typed links with contextual annotations. Memory hydration loads the compressed knowledge relevant to current commitments; memory recording writes new propositions and links after execution.

This is proposition-native memory, not entity-extraction or fact-storage. The epistemological bet: knowledge is propositional (claims that can be argued, connected, and revised), not factual (isolated data points that can only be accumulated).

**Port interface:** `MemoryPort.hydrate()` → `MemoryContext` (propositions, links); `MemoryPort.record()` writes the execution outcome back

### Execution (Z5 + Z6)

The system proposes actions and, given sufficient authority, executes them. Execution has four authority levels: `none` (observation only), `advisory` (suggest but don't act), `delegated` (act within defined boundaries), `autonomous` (act on own judgment). The authority level is itself a commitment — how much the human trusts the loop.

Between sessions, the **heartbeat** extends execution into temporal autonomy (Z6). The heartbeat checks vault conditions, evaluates commitments, and acts when conditions demand it — processing inbox items, connecting orphan thoughts, mining session transcripts, advancing commitments. The agent that acts when conditions demand it, not when prompted, is a fundamentally different kind of system.

**Port interface:** `ExecutionPort.propose()` → `ExecutionPlan`; `ExecutionPort.execute()` → `ExecutionOutcome`

### Why the Layers Must Be Designed Together

The five layers fail when built sequentially because they do not compose cleanly. Perception optimized for a productivity context produces memory that is malformed for a research companion context. A commitment structure designed for task management carries the wrong assumptions for creative work. Execution authority designed for enterprise workflow has the wrong trust model for an intimate companion.

Every specialized player optimizes their piece and leaves the integration surface to someone else. The integration surface is where composability failures accumulate. Building the intent computer means owning the cross-layer integration problem — designing all five layers as a whole system from the first line of code.

---

## The Identity Primitive

Identity is the deepest unsolved problem in agent computing. Two research communities work on identity and they do not talk to each other: the security track (cryptographic attestation, ERC-8004, Entra Agent ID) and the behavioral track (personality persistence, self-models, value alignment). The intent computer requires both.

The formal specification: **Identity(A) = `<N, U, C>`** where:
- **N** = normative structure — what the agent treats as success and failure
- **U** = Umwelt — what the agent perceives and attends to (its sensory envelope)
- **C** = commitment structure — what the agent intends across time

The negative claim matters as much as the positive. Identity is not:
- A UUID (a label — rename it, same agent)
- An API key (authentication — revoke it, same agent)
- A system prompt (instruction — deploy on two instances, two agents, not one)
- Model weights (substrate — swap them with the triple preserved, arguably same agent)

Configuration describes what an agent *has*. The `<N, U, C>` triple describes what an agent *is*.

Z0 and Z1 are not merely sequential principles. They are the same phenomenon at different timescales. Intentionality is directed consciousness in the moment. Identity is intentionality that persists. "I am what I intend across time."

---

## The Pilgrimage Problem

The compression gradient assumes all gaps between intent and outcome are friction to eliminate. The pilgrimage thesis reveals a class of gaps that are load-bearing. Compress them and the structure collapses.

Two kinds of gaps:

**Incidental gaps (thin desires):** The goal is the outcome; the path is substitutable. Booking a flight, filling a form, scheduling an appointment. The difficulty adds no value. The system's job is pure compression. An intent computer that fails to compress these gaps is simply slow.

**Constitutive gaps (thick desires):** The goal is inseparable from the path. Writing a novel, learning a complex concept, walking the Camino de Santiago. The difficulty is the point. The distance produces the pilgrim. An intent computer that compresses these gaps destroys the value it was meant to amplify.

The distinction is grounded in multiple independent theoretical traditions:
- **Michelin's three-star system** does not measure food quality — it measures warranted sacrifice. "Worth a special journey" means the distance is part of the experience.
- **Bataille's non-productive expenditure:** The surplus destroyed without return IS the mechanism that produces the sacred. Eliminate the expenditure, eliminate the sacred.
- **Benjamin's aura:** The irreproducibility of the original IS the aura. Mechanical reproduction collapses the distance, and the aura evaporates.
- **Bourdieu's habitus:** Years of cultivation ARE the cultural capital. Compress the cultivation, and what remains is not capital but pretension.

The resolution: the compression gradient operates on incidental gaps but must not operate on constitutive gaps. Past a threshold, compression destroys value rather than creating it. The intent computer needs a model of the user sophisticated enough to know which kind of gap it is looking at.

This connects directly to Naval Ravikant's intelligence test: "The only true test of intelligence is whether you get what you want out of life." AI fails this test instantly — it has no life and no desires. The intent computer passes by proxy: it amplifies human desires rather than substituting for them. But if it routes efficiently toward thin desires (the mimetically generated, scroll-shaped wants), it is just a better scroll. It must route toward thick desires — the genuine, values-rooted intentions that survive examination.

The domain types encode this directly: `DesireClass = "thick" | "thin" | "unknown"` and `FrictionClass = "constitutive" | "incidental" | "unknown"`. Every detected gap is classified. Protected gaps are preserved; compressed gaps are eliminated. The commitment plan carries both lists.

---

## The Steerability Gap

Capability and steerability are independent dimensions. This is the most counterintuitive finding in the research, and the most consequential for the intent computer's design.

The producible set of any modern LLM is vast — it can generate virtually anything in its training distribution. But the reachable set — what a human can actually guide the model to produce through text prompts — is dramatically smaller. MIT research quantifies this: annotators rate attempted reproductions as unsatisfactory 60% of the time. More attempts do not reliably close the gap. And critically, better models are not reliably more steerable.

The industry bets on scaling: make the model smarter, and users will get better results. But steerability is orthogonal to capability. A more capable model has a larger producible set — it *can* generate more things — but the reachable set does not grow proportionally. The gap widens. You are making the haystack bigger without making the needle easier to find.

This is the empirical proof of Z3: relation precedes representation. Producibility is a representational property (what is in the catalog). Steerability is a relational property (how effectively intent translates to output). And relation is consistently rate-limiting.

The steerability gap explains why the convergence point is unoccupied. Closing it requires architectural change — richer feedback channels, tighter interaction loops, modalities beyond text — not better models. The bicycle was not built by making the engine stronger. It was built by making the pedals responsive.

---

## The Strategic Position

The intent computer is the unoccupied convergence point that nobody is building directly. This is not an oversight — it is a structural consequence of how the industry is organized.

Every major player has pieces:
- **Anthropic** has protocols (MCP) and compression proof (Claude Code) but no explicit intent architecture
- **VERSES** has the deepest theoretical alignment (active inference IS intent) but limited ecosystem
- **Google** has interoperability (A2A) and economic agency but enterprise orientation
- **OpenAI** has raw capability but is automating the old paradigm (agents using virtual computers with browsers)
- **Microsoft** has the strongest Z1 implementation (Entra Agent ID) but is protecting incumbency
- **Conway** maps the zeroth stack more completely than any prior player (identity + sandbox + economic agency + self-modification + temporal autonomy) but approaches from infrastructure, not theory

Five pieces need to converge: active inference architecture, MCP/A2A protocol layer, meaning-native memory, temporal autonomy infrastructure, and economic agency. Nobody combines all five. Most combine one or two.

The gap maps directly to the zeroth principles. Satisfying only some layers while ignoring others produces systems that fail predictably at the lowest violated principle. The February 2026 security crisis validated this empirically: every compromised system had jumped to capabilities (Z3+) without establishing identity (Z1), and every attack exploited exactly that gap.

The position is also unfundable: you cannot fund what you cannot name, and the intent computer has no product category yet. Named categories channel capital. The unnamed position accumulates by default. This is a feature, not a bug — it means the convergence point is available for those who recognize the pattern before it has a name.

---

## The Migration Path

The transition to the intent computer will be invisible, not revolutionary. Legacy systems, stable APIs, and human habits anchor the status quo. The migration follows the same pattern as every prior paradigm shift:

**Phase 1 (current):** Agents as apps. Each agent is a discrete tool invoked for a specific task. No persistence, no identity, no between-session behavior.

**Phase 2 (emerging):** Agentic layer as sidecar. The agent wraps the legacy OS, intercepting user intent and translating it into legacy commands. The user interacts with intent; the agentic layer handles translation. MCP and A2A serve as "agentic drivers" — the analog of hardware drivers in the sidecar architecture.

**Phase 3 (future):** Agentic OS as kernel. The legacy OS is relegated to a compatibility VM inside the agentic kernel. The desktop metaphor (files, folders, windows) dissolves into episodic UI — interfaces that appear when a decision is needed and dissolve afterward.

The tipping point: when maintaining the legacy interface costs more than the agentic automation saves. This is the same economics that drove every prior migration. The PC became a terminal to the mainframe, then the mainframe became a server for the PC. The browser became an app on the desktop, then the desktop became a launcher for the browser. Each time: sidecar first, substrate later.

---

## Cross-Domain Validation

The intent computer thesis is not validated by internal consistency alone. It is validated by independent convergence from domains that were not consulted during its formulation.

**Health:** The health action gap is the intent computer thesis stated in one sentence. Everyone has the data (WHOOP, Apple Watch, Function Health). Nobody has the loop that turns knowing into doing. The gap is not informational — it is architectural. Health is the cleanest test domain because the intent is clear, the data exists, and the hardest constraint (knowing when NOT to act) directly tests Z6.

**Education:** The means of learning are abundant; the desire to learn is scarce. AI as tutor solves the supply problem while exposing that motivation was always the binding constraint. The intent computer addresses this: it does not supply capability (which is abundant) but amplifies intent (which is scarce).

**Economics:** The agentic economy prices outcomes, not seats. When computation configures itself around intent, the unit of value shifts from access (how many seats?) to realization (did the intent become reality?). This is already visible: outcome-based pricing models outperform seat-based models in every category where intent can be measured.

**Art and Taste:** The patron exercised will — arguing, specifying, being present in the generative relationship. Mass production stripped that relationship, leaving only taste (the residue of patronage). The intent computer restores the patron's interface at technological scale. The GAN metaphor clarifies why this matters: positioning humans as discriminators (evaluators of generated output) makes them architecturally redundant. The intent computer positions humans as patrons (directors of generated output), which is architecturally irreplaceable.

**Biology:** HRV baseline deviation is biological active inference operating through the vagus nerve. The body implements the free energy principle through autonomic regulation — the same loop, the same math, a different substrate. This is the strongest empirical anchor in biology.

---

## Architectural Commitments

The methodology constrains implementation through specific architectural commitments:

### Port-Based Boundaries

The five layers are encoded as TypeScript interfaces (`PerceptionPort`, `IdentityPort`, `CommitmentPort`, `MemoryPort`, `ExecutionPort`). Adapters implement these ports for specific substrates (local vault, cloud API, etc.). The runtime instantiates the loop; the adapters handle specifics. This separation is what makes the architecture substrate-independent.

### Proposition-Native Memory

The unit of memory is the proposition — a titled claim, not a fact. Propositions connect via typed, contextual links. This is an epistemological commitment: knowledge is argumentative structure (claims that relate to other claims), not a database of entities and attributes.

### The Heartbeat

Between sessions, the heartbeat extends the intent loop into temporal autonomy. It checks vault conditions against thresholds, evaluates commitments, and acts when conditions demand it. The heartbeat is what makes Z6 real — without it, the agent is sophisticated but sessile.

### Desire and Friction Classification

Every detected gap between intent and outcome is classified along two dimensions: `DesireClass` (thick, thin, unknown) and `FrictionClass` (constitutive, incidental, unknown). The commitment plan separates protected gaps from compressed gaps. This is the pilgrimage problem encoded in the type system.

### Authority Escalation

Execution authority follows a four-level model: `none → advisory → delegated → autonomous`. The authority level is itself a commitment that can be adjusted. The default is advisory — propose, don't act. Autonomy is earned through demonstrated judgment.

### Processing Pipeline

Raw input enters through an inbox and passes through a four-phase pipeline: **surface** (extract meaning, name what's there), **reflect** (find connections, update maps), **revisit** (update older thoughts with new connections), **verify** (check quality gates). The pipeline exists because direct writes skip quality gates. Every phase enforces discovery-first design: the thought must be findable by a future agent who does not know it exists.

---

## What This Is Not

Precision about what the intent computer is requires equal precision about what it is not.

- **Not a chatbot.** A chatbot responds to queries. The intent computer pursues trajectories.
- **Not an LLM OS.** The LLM OS metaphor maps old ontology (CPU, RAM, disk) onto new reality and obscures what actually changed. There are no components — only relations.
- **Not another agent framework.** Agent frameworks provide scaffolding for building agents. The intent computer is the agent — the protocol that makes frameworks unnecessary.
- **Not a hypervisor.** A hypervisor manages VMs. The intent computer makes VMs unnecessary by eliminating the need for pre-built infrastructure.
- **Not a GUI for agents.** Wrapping agents in interfaces does not close the steerability gap. The coupling must be architectural, not cosmetic.
- **Not an automation tool.** Automation compresses incidental friction. The intent computer must also *preserve* constitutive friction. It knows when to act and when to refrain.

---

## Further Reading

The methodology is maintained across several companion documents:

| Document | Contents |
|----------|----------|
| [zeroth-principles.md](zeroth-principles.md) | Full treatment of Z0–Z6 with formal foundations, cross-domain validation, and diagnostic applications |
| [architecture.md](architecture.md) | The five-layer architecture, port interfaces, domain types, the intent loop, and the heartbeat |
| [design-tensions.md](design-tensions.md) | Irreducible tensions in the design: pilgrimage problem, steerability gap, composability failure, naming problem |
| [strategic-position.md](strategic-position.md) | The convergence thesis, competitive landscape, migration path, and why the position is unoccupied |

The living knowledge graph at `~/Mind/thoughts/` contains the full argument chain with all evidence, connections, and cross-domain validation. Key entry points:
- `the intent computer.md` — the domain map clustering the convergence thesis
- `zeroth principles.md` — the Z0–Z6 map with all theoretical foundations
- `nobody is building the intent computer.md` — the strategic assessment
- `the next computer is not a machine but a protocol for intent realization.md` — the central claim