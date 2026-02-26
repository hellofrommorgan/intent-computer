# Zeroth Principles: The Dependency Stack

The seven zeroth principles are the preconditions that must hold before any first principle of agent computing can be stated. They are named after the Zeroth Law of Thermodynamics — formulated last, recognized as most fundamental. This document provides the full treatment of each principle, its formal foundation in the Free Energy Principle, its diagnostic application, and its cross-domain validation.

---

## The Stack as Diagnostic Tool

The principles form a strict causal chain. When a system fails, trace the failure downward until you find the lowest violated principle. That is the root cause.

```
Z0 Intentionality ─── why compute at all
 └─ Z1 Identity ──── who is computing
     └─ Z2 Context ── what is being computed with
         └─ Z3 Relation ── how capabilities emerge
             └─ Z4 Compression ── the direction of evolution
                 └─ Z5 Error ──── the mechanism of learning
                     └─ Z6 Temporal Autonomy ── when computation happens
```

The minimum viable intent computer satisfies all seven simultaneously and minimally: an identity (Z1) with intent (Z0), given context (Z2), relating to its environment (Z3), compressing what it learns (Z4), learning from errors (Z5), persisting through time (Z6). This is the "hello world." Everything else emerges from the dependency chain unfolding upward.

---

## Z0: Intentionality Precedes Computation

**Claim:** Without a reason to compute, computation is noise. Every system begins with someone wanting something. The intent is not a parameter to the system — it is the precondition for the system's existence.

**Formal analog (FEP):** Prior preferences — the C matrix in active inference, specifying preferred observations the agent "expects" by virtue of being what it is. An agent with no prior preferences performs random inference — technically active but directionless.

**Diagnostic:** If a system produces output that serves no intent, Z0 is violated. The output may be correct, even impressive, but it is computation without purpose. The most common Z0 violation in current systems: agents that optimize for task completion rather than trajectory advancement. Completing the task you were given is not the same as advancing the intent that generated the task.

**Cross-domain validation:** Naval Ravikant's intelligence test — "the only true test of intelligence is whether you get what you want out of life" — is Z0 stated in personal terms. AI fails it instantly because it has no life and no desires. The intent computer passes by proxy: it amplifies human intentionality rather than substituting for it.

---

## Z1: Identity Precedes Capability

**Claim:** Before asking "what can it do?" you must answer "who is doing it?" Capability without identity is a weapon without a wielder. The February 2026 security crisis — Moltbook fabrication, OpenClaw exposure, ClawHub supply chain attacks — proved this empirically. Every compromised system had jumped to capabilities without establishing identity, and every attack exploited exactly that gap.

**Formal analog (FEP):** The generative model — the internal model of the world that the agent maintains and updates. Without a generative model, there is nothing to minimize free energy *against*. The model IS the agent.

**The formal specification:** Identity(A) = `<N, U, C>` where N is normative structure, U is Umwelt, C is commitment structure. The persistence condition: sufficient continuity in `<N, U, C>` across time.

**The Z0–Z1 collapse:** Intentionality and identity are the same phenomenon at different timescales. Z0 is directed consciousness in the moment. Z1 is Z0 that persists. "I am what I intend across time." This collapse means the first dependency in the stack is not a handoff but a temporal extension.

**Diagnostic:** If a system can be forked into two identical instances that diverge immediately (because neither has internal priorities to constrain divergence), Z1 is violated. If the system behaves identically regardless of whose intent it serves, Z1 is absent.

---

## Z2: Context Is the Computer

**Claim:** The context window is not a cache or a scratchpad — it is the computational substrate. What the agent perceives IS what the agent computes with. The hardware distinction (CPU vs. RAM vs. disk) dissolves: in the intent computer, context is all three simultaneously.

**Formal analog (FEP):** The Markov blanket — the statistical boundary between agent and world. The blanket defines what the agent can sense (sensory states) and how it can act (active states). The context window IS the Markov blanket: it determines what crosses the boundary between the agent and its environment.

**The context curation principle:** Context engineering has replaced prompt engineering as the primary discipline. But both are patches on a loose coupling. The real insight, validated by Rossmeissl's clienteling analysis: the competitive advantage is not knowing everything about a situation but identifying the single activating signal that collapses probability into action. Context curation beats context accumulation. The Goyard sales rep does not memorize everything — she filters for the one detail (Friday cocktails at 8pm) that turns a prospect into a buyer.

**Diagnostic:** If a system treats context as storage (passively accumulating information) rather than computation (actively filtering for the activating signal), Z2 is partially satisfied. Full Z2 satisfaction requires the system to shape its own perception — deciding what to attend to and what to ignore.

---

## Z3: Relation Precedes Representation

**Claim:** Capabilities do not exist in pre-built catalogs. They emerge through interaction. The agent's power is relational — it depends on what it connects to, how it connects, and what emerges from the connection. No amount of pre-built tooling substitutes for the generative capacity of relation.

**Formal analog (FEP):** Inference dynamics — the process by which the agent updates beliefs through interaction with its environment. Beliefs are not stored; they are continuously inferred from the relational process of engaging with evidence.

**The steerability connection:** The steerability gap is the empirical proof of Z3. Producibility is a representational property (what is in the catalog). Steerability is a relational property (how effectively intent translates to output). And relation is what is consistently rate-limiting. Better models expand the catalog without improving the relationship.

**The LLM OS failure:** Karpathy's LLM OS metaphor fails precisely because it preserves representational thinking in a relational reality. It asks "what is the agent's CPU?" when the zeroth principles dissolve the distinction between CPU, memory, and I/O into a single relational process.

**Diagnostic:** If a system's capabilities are fully enumerable in advance (a fixed tool list, a static skill catalog), Z3 is only nominally satisfied. Full Z3 satisfaction means the system discovers capabilities through interaction that could not have been predicted from the catalog.

---

## Z4: Compression Is the Direction of Intelligence

**Claim:** Intelligence moves toward less, not more. The history of computing is progressive subtraction — each paradigm shift removes a layer of indirection between intent and outcome. The intent computer is what remains when there is nothing left to remove.

**Formal analog (FEP):** Complexity minimization — the component of free energy that penalizes model complexity. The free energy objective decomposes into accuracy (fit the data) minus complexity (keep the model simple). Intelligence is the simplest model that adequately explains the world.

**The Kolmogorov connection:** Compression applied to measurement: adaptive testing (IRT/CAT) is Kolmogorov complexity applied to psychometrics. Each question compresses the remaining uncertainty about the test-taker's ability. The stopping rule (when to stop asking questions) is structurally identical to the free energy minimum (when the model is adequate).

**Diagnostic:** If a system accumulates without distilling — growing its knowledge base without increasing the compression ratio — Z4 is violated. The symptom: the system knows more but understands no better. The remedy: the processing pipeline's convergent operations (surface, reflect, verify) that compress raw input into propositional knowledge.

---

## Z5: Error Is Signal, Not Noise

**Claim:** Failures are not bugs to suppress. They are the learning mechanism. Prediction error — the discrepancy between what the agent expected and what it observed — drives belief revision. A system that suppresses errors does not learn; it calcifies.

**Formal analog (FEP):** Prediction error — the driving force of belief update in active inference. The agent generates predictions from its model, observes the world, computes the difference, and updates the model to reduce the difference. This is not error correction — it is the mechanism by which the model improves.

**The vault instantiation:** The operational learning loop captures friction signals (observations) and contradictions (tensions) as first-class objects. Observations accumulate until a threshold (10+) triggers a rethink pass. Tensions name the contradictions explicitly and track their resolution. The system learns from its own failures through a structured feedback loop, not by suppressing them.

**Diagnostic:** If a system handles errors only by retrying or escalating — never by updating its model of the world — Z5 is violated. The symptom: the same failure recurs in the same form. The remedy: error → observation → pattern detection → model update.

---

## Z6: Autonomy Is Temporal, Not Spatial

**Claim:** The agent that acts when conditions demand it — not when prompted — is fundamentally different from the agent that waits. Temporal autonomy is not about where the agent runs (spatial) but about when it acts (temporal). Persistence through time, with the judgment to choose silence over action when silence serves better, is the highest expression of autonomy.

**Formal analog (FEP):** Temporal planning depth — the capacity to minimize expected free energy across arbitrary time horizons. An agent with zero planning depth acts only in the present. An agent with unbounded planning depth considers consequences across all futures. Temporal autonomy is the engineering expression of planning depth.

**The capable silence test:** The hardest expression of Z6 is not acting — it is refraining. Knowing when health data is not worth surfacing, when a connection is not worth mentioning, when the morning brief should be shorter, not longer. Capable silence means the agent's precision-weighting (from active inference) has become sophisticated enough to recognize when observation is more valuable than intervention.

**The heartbeat instantiation:** The heartbeat is what makes Z6 real in the current implementation. It checks conditions, evaluates commitments, and acts between sessions when thresholds are crossed. Without the heartbeat, the agent is sophisticated but sessile — intelligent within a session, inert between them. Z6 is the weakest layer in most implementations: trigger declarations exist but no autonomous wake mechanism fires them.

**Diagnostic:** If the system does nothing between sessions — no monitoring, no processing, no commitment evaluation — Z6 is absent. If it monitors but never acts on what it finds, Z6 is nominal. Full Z6 satisfaction means the system acts between sessions with judgment (not just automation) and refrains when restraint serves the person better.