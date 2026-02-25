# Zeroth Principles: Z0-Z6

> **Canonical specification:** [methodology/zeroth-principles.md](../../methodology/zeroth-principles.md) contains the full treatment with formal foundations, cross-domain validation, and diagnostic applications. This document is the concise reference.

The zeroth principles are the foundational commitments of the intent computer. They are not aspirational -- they are structural. A system that violates a zeroth principle is not "imperfect"; it is a different system.

These principles form a strict dependency chain: each requires the ones below it. To diagnose a failure, trace downward until you find the lowest violated principle. That is the root cause.

---

## The Seven Principles

| Layer | Principle | Claim | Formal Analog (FEP) |
|-------|-----------|-------|---------------------|
| **Z0** | Intentionality precedes computation | Without a reason to compute, computation is noise. | Prior preferences (C matrix) |
| **Z1** | Identity precedes capability | Before "what can it do?" answer "who is doing it?" | Generative model |
| **Z2** | Context is the computer | The context window is the computational substrate, not a cache. | Markov blanket |
| **Z3** | Relation precedes representation | Capabilities emerge through interaction, not from pre-built catalogs. | Inference dynamics |
| **Z4** | Compression is the direction of intelligence | Intelligence moves toward less, not more. | Complexity minimization |
| **Z5** | Error is signal, not noise | Failures are the learning mechanism, not bugs to suppress. | Prediction error |
| **Z6** | Autonomy is temporal, not spatial | The agent that acts when conditions demand it is fundamentally different from one that waits. | Temporal planning depth |

Each principle has a diagnostic test, a formal anchor in the Free Energy Principle, and cross-domain validation. See the [canonical specification](../../methodology/zeroth-principles.md) for the complete treatment.

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

---

## Mathematical Foundation

The zeroth principles are not engineering metaphors. They are derivations from a single mathematical principle: the Free Energy Principle (FEP). The dependency chain maps to the mathematical structure of active inference: prior preferences (Z0) define the generative model (Z1), which defines the Markov blanket (Z2), which defines inference dynamics (Z3), which minimizes complexity (Z4), through prediction error (Z5), over temporal horizons (Z6).

This is structural isomorphism -- results proved in one domain transfer to the other. For the full formal treatment, see [methodology/zeroth-principles.md](../../methodology/zeroth-principles.md).
