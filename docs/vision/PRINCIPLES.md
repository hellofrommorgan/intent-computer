# Zeroth Principles: Z0-Z6

The zeroth principles are the foundational commitments of the intent computer. They are not aspirational -- they are structural. A system that violates a zeroth principle is not "imperfect"; it is a different system.

These principles form a strict dependency chain: each requires the ones below it. To diagnose a failure, trace downward until you find the lowest violated principle. That is the root cause.

---

## Z0: Intentionality Precedes Computation

**Statement.** Without a reason to compute, computation is noise.

**In practice.** Every system begins with someone wanting something. The intent loop starts with an `IntentRequest` carrying a statement and a source. No intent, no loop. The system never generates its own reasons to act -- it amplifies the human's reasons. Intent is not a parameter passed to the system; it is the precondition for the system's existence. A system running without intent is not idle -- it is broken.

**Diagnostic.** If the system is doing work that cannot be traced to a human intent, Z0 is violated. Audit by following any active computation backward: it must terminate at an `IntentRequest` with a human source. If the chain terminates at a system-generated trigger with no human antecedent, the system has begun acting on its own behalf.

**Formal anchor.** Prior preferences in the Free Energy Principle. The generative model requires preferences to define what counts as a good outcome. Without prior preferences, free energy is undefined -- there is nothing to minimize toward. Z0 is the claim that these preferences originate outside the system, in the human.

---

## Z1: Identity Precedes Capability

**Statement.** Before "what can it do?" answer "who is doing it?"

**In practice.** Identity is the triple `<N, U, C>`: normative structure (what the agent values), Umwelt (what the agent can perceive), and commitment structure (what the agent has promised). Session orientation loads identity before capabilities. The agent reads `self/identity.md` before loading any skills. Identity constrains which capabilities are appropriate -- not all tools should be available to all agents in all contexts.

**Diagnostic.** If swapping the identity file changes nothing about behavior, Z1 is not implemented -- it is decorative. The test is substitution: replace the identity with a contradictory one and observe whether skill selection, tone, and constraint enforcement change accordingly. If they do not, identity is not load-bearing.

**Formal anchor.** The generative model in active inference. The generative model defines what the agent expects to perceive and how it expects actions to produce outcomes. Identity IS the generative model -- it determines what the agent treats as surprising and what it treats as expected. An agent without identity has no basis for prediction error.

---

## Z2: Context Is the Computer

**Statement.** The context window is the computational substrate, not a cache.

**In practice.** What the agent perceives IS what it computes with. `CLAUDE.md` programs the agent. `SKILL.md` is the executable. The language model is the compiler. Session orient injects vault context into the system prompt. Skills are loaded on-demand to preserve context budget. The quality of context determines the quality of output more than model capability does. Perception must be bounded: maximum 3 signals per channel to prevent context dilution.

**Diagnostic.** If expanding the context window without changing content quality improves output, Z2 is being wasted -- context is functioning as storage, not computation. The test: does curating context (removing noise, improving signal density) improve output more than adding context? If not, the system is hoarding rather than computing.

**Formal anchor.** The Markov blanket. In active inference, the Markov blanket separates internal states from external states -- it defines what the agent can sense and act on. The context window IS the Markov blanket of a language-model agent. What falls outside the context window does not exist for the agent. Managing the blanket is managing the computation.

---

## Z3: Relation Precedes Representation

**Statement.** Capabilities emerge through interaction, not from pre-built catalogs.

**In practice.** Skills use vocabulary placeholders resolved at runtime against the active vault. The same skill works across different vaults because capability is relational (skill + context), not representational (hardcoded behavior). MCP provides the relational surface -- tools exist at the boundary between agent and environment. A thought without connections is a thought that will never be found. Links are first-class because they ARE the knowledge; the nodes they connect are inert without them.

**Diagnostic.** If a skill fails when moved to a different vault with different vocabulary, Z3 is violated -- the skill has hardcoded representations where it should have relational bindings. The test: take any skill, drop it into a foreign vault with a valid vocabulary file, and run it. If it breaks on assumptions about file paths, map names, or specific thought titles, representation has leaked where relation should govern.

**Formal anchor.** Inference dynamics in active inference. Beliefs are not static representations -- they are updated through the dynamics of inference, shaped by the interaction between prior expectations and sensory evidence. Capability is a property of the agent-environment coupling, not of the agent alone.

---

## Z4: Compression Is the Direction of Intelligence

**Statement.** Intelligence moves toward less, not more.

**In practice.** The processing pipeline compresses raw input into propositions. The vault should get denser, not larger. Skills should get shorter, not longer. Every abstraction layer that is not load-bearing should be removed. Each evolution of the system simplifies while expanding capability. Skill graphs simplified prompt engineering. Agentic CLIs simplified tool integration. The theoretical minimum is `CLAUDE.md` + vault.

**Diagnostic.** If the vault grows without the compression ratio (connections per thought) increasing, Z4 is violated. Additional metrics: if skills get longer over time, if new abstraction layers appear without removing old ones, if the system knows more but understands no better. The test is the ratio of capability to complexity -- it must increase monotonically.

**Formal anchor.** Complexity minimization in the free energy functional. Free energy decomposes into accuracy (fit the data) and complexity (divergence from priors). Minimizing free energy requires minimizing complexity -- the simplest model that adequately explains observations wins. A system that accumulates without compressing is increasing its complexity term without proportional accuracy gains.

---

## Z5: Error Is Signal, Not Noise

**Statement.** Failures are the learning mechanism, not bugs to suppress.

**In practice.** Observations and tensions are first-class objects in the vault. Write-validate warnings are surfaced, not auto-fixed. The heartbeat records action outcomes and learns from failures. When a skill produces unexpected results, the system captures the prediction error as an observation, not a retry. Friction is information about the gap between the agent's model and reality.

**Diagnostic.** If the system handles an error by retrying the same action without updating its model, Z5 is violated -- error should trigger belief update, not repetition. The test: observe the system's response to a repeated failure. Does it change strategy, or does it increase retry count? The former is learning; the latter is suppression.

**Formal anchor.** Prediction error in active inference. The agent maintains beliefs about the world and generates predictions. When predictions fail, prediction error drives belief revision -- this is the sole mechanism of learning. Suppressing prediction error (by ignoring failures or retrying blindly) prevents the belief update that would improve future predictions.

---

## Z6: Autonomy Is Temporal, Not Spatial

**Statement.** The agent that acts when conditions demand it -- not when prompted -- is fundamentally different from one that waits.

**In practice.** The heartbeat runs between sessions. It evaluates commitments, processes queue items, and updates the morning brief. But it also exercises restraint -- not every threshold crossing warrants action. The capable silence principle: the highest expression of autonomy is knowing when NOT to act. Autonomy is earned through demonstrated judgment over time, not granted by occupying a privileged position in a hierarchy. Authority escalation (none, advisory, delegated, autonomous) governs the envelope of permitted action.

**Diagnostic.** If the system behaves identically between sessions regardless of commitment state, Z6 is not implemented -- it is a cron job, not autonomy. The test: introduce a pending commitment with a deadline, and observe whether the system's between-session behavior changes. If it does not, temporal reasoning is absent. Conversely, if the system acts on every signal without restraint, it has temporal reactivity, not temporal autonomy.

**Formal anchor.** Temporal planning depth in active inference. An agent with deep temporal models can evaluate the consequences of acting now versus later. Autonomy requires this depth -- the ability to reason about when to act, not merely whether to act. Shallow temporal models produce reactive behavior; deep temporal models produce judgment.

---

## The Dependency Chain

```
Z6  Autonomy is temporal, not spatial
 |  requires temporal reasoning, which requires...
Z5  Error is signal, not noise
 |  requires a learning mechanism, which requires...
Z4  Compression is the direction of intelligence
 |  requires a model to compress into, which requires...
Z3  Relation precedes representation
 |  requires relational context, which requires...
Z2  Context is the computer
 |  requires a computational substrate, which requires...
Z1  Identity precedes capability
 |  requires a generative model, which requires...
Z0  Intentionality precedes computation
    requires prior preferences (human intent)
```

The dependency is strict and causal. You cannot fix Z4 (compression) if Z2 (context) is broken. You cannot fix Z2 if Z1 (identity) is missing. You cannot fix Z1 if Z0 (intent) is absent.

When diagnosing a system failure: start at the observed symptom, identify which principle is violated, then trace downward. The lowest violated principle is the root cause. Fix from the bottom up.
