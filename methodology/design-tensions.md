# Design Tensions: The Irreducible Conflicts

The intent computer is not a system that has resolved all its contradictions. It is a system that holds its contradictions explicitly. These tensions are not bugs to fix — they are the structural constraints that prevent the design from collapsing into something simpler but wrong. Any implementation that resolves one of these tensions by eliminating one side has lost something essential.

---

## 1. The Pilgrimage Problem: Compression vs. Constitutive Friction

**The tension:** The compression gradient says compress everything. The pilgrimage thesis says some gaps are load-bearing — compress them and the value collapses.

**Why it's irreducible:** Both sides are correct within their domain. Administrative overhead is pure friction — compress it. Creative struggle is constitutive — preserve it. The difficulty is that the same gap can be incidental for one person and constitutive for another. Commuting is friction for most people; for some, the drive home is where the ideas come. Exercise is constitutive by definition — an intent computer that "optimizes away" the workout has destroyed the outcome it was supposed to serve.

**How the architecture holds it:** The `GapClass` type (`incidental | constitutive`) forces explicit classification of every detected gap. The `CommitmentPlan` carries two separate lists: `protectedGaps` (constitutive — do not compress) and `compressedGaps` (incidental — eliminate). The classification requires a model of the user sophisticated enough to distinguish between the two, which is why identity (Z1) must resolve before commitment (Z0+Z3) can plan.

**The asymptotic warning:** When distance to consumption approaches zero, value evaporates — it does not maximize. The compression gradient has an asymptote, not a monotonic curve. The intent computer must know where the curve bends.

---

## 2. The Steerability Gap: Capability vs. Reachability

**The tension:** The industry scales capability (larger models, more training data, better benchmarks). Users experience steerability (can I get the model to do what I mean?). These are independent dimensions. Better models are not reliably more steerable.

**Why it's irreducible:** You cannot close the steerability gap by scaling capability alone. The gap is relational, not representational — it lives in the coupling between human intent and model output, not in the model's internal capacity. Making the haystack bigger does not make the needle easier to find.

**How the architecture holds it:** The intent loop is designed as a coupling mechanism, not a capability amplifier. Each cycle tightens the coupling: perception captures what is real, identity grounds who is asking, commitment filters what matters, memory provides the relevant compressed knowledge, execution proposes and acts. The loop's quality is measured by coupling tightness (how efficiently intent becomes outcome), not by model capability (how large the producible set is).

**The design implication:** The intent computer should work with any sufficiently capable model. If the architecture depends on a specific model's capabilities to function, the steerability gap has been papered over, not closed.

---

## 3. The Composability Failure: Integration vs. Specialization

**The tension:** Each of the five layers is being built well by someone. But the layers do not compose cleanly when built independently. Perception optimized for one context produces memory malformed for another. The integration surface — where composability failures accumulate — is the part nobody wants to own.

**Why it's irreducible:** Specialization produces better individual components. Integration produces a working whole. You cannot have both without designing the whole system from the first line. But designing the whole system means being wrong about every individual component compared to a specialist — accepting worse perception, worse memory, worse execution in isolation, in exchange for the only composed stack that works.

**How the architecture holds it:** Port-based boundaries. Each layer is an interface, not an implementation. The ports define the integration surface explicitly — the shape of data that crosses each boundary. This makes composability failures visible at the type level rather than at runtime. When a new perception adapter produces output that doesn't satisfy the `PerceptionSnapshot` type, the failure is caught at the boundary, not three layers later.

**The strategic consequence:** Building the intent computer means being the least legible player in the market. No named category, no clean benchmark, no specialized excellence. In exchange: the only player with a composed stack.

---

## 4. The Naming Problem: Capital vs. Convergence

**The tension:** You cannot fund what you cannot name. The intent computer has no product category. Named categories channel capital. The unnamed position accumulates by default.

**Why it's irreducible:** Naming the intent computer prematurely anchors it in the wrong category. "AI agent framework" attracts the wrong builders. "Personal AI" attracts the wrong users. "Agentic OS" attracts the wrong investors. The convergence point does not fit existing categories because existing categories are organized by the paradigm the intent computer dissolves.

**How the architecture holds it:** It doesn't — this tension is strategic, not architectural. The methodology acknowledges it explicitly: the position is available precisely because it is unfundable. When it becomes fundable, it will also become contested. The window is while the convergence remains unnamed.

---

## 5. The Mirror Problem: Memory Without Intent

**The tension:** Memory and identity are the visible, buildable parts of the system. Intent (the commitment engine) is the invisible, hard part. The temptation is to build N and U carefully while treating C as a passive field. The result: a system that knows you perfectly but does nothing with that knowledge unless prompted.

**Why it's irreducible:** Passive commitment is easier to build, easier to test, easier to explain. Active commitment — an engine that pursues trajectories between sessions, that changes its behavior when goals change, that declines to surface information that would have mattered under previous goals — requires judgment. Judgment is the hard problem.

**How the architecture holds it:** The `CommitmentPort` has two methods: `plan()` (active — produces the commitment plan that drives execution) and `recordOutcome()` (feedback — updates commitments based on what happened). The heartbeat evaluates commitments between sessions, not just conditions. The diagnostic is behavioral: if the system's between-session behavior is identical whether goals changed or not, commitment is a field, not an engine.

---

## 6. The Authority Escalation: Trust vs. Autonomy

**The tension:** Full autonomy is the goal (Z6). But trust must be earned, not assumed. Granting autonomous execution authority to a system that has not demonstrated judgment is the fastest path to catastrophic failure.

**Why it's irreducible:** The system cannot demonstrate judgment without authority to act. But granting authority before judgment is demonstrated is reckless. The chicken-and-egg is structural.

**How the architecture holds it:** Four authority levels (`none → advisory → delegated → autonomous`) with explicit escalation. The default is advisory. Each escalation is a commitment — the human deciding to trust the loop more. The heartbeat begins at advisory level (propose actions, don't execute). Delegation requires demonstrated judgment across multiple cycles. Autonomy is the asymptote, not the starting point.

**The capable silence principle:** The highest expression of earned trust is not dramatic action — it is restraint. The system that knows when NOT to act, when NOT to surface, when NOT to intervene, demonstrates the judgment that warrants autonomy. Capable silence is Z6's final exam.
