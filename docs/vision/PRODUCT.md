# Tenure — Product Vision

> Working name. Tagline: **"Autonomy the agent earns. Audit you can trust."**

## The one sentence

Most teams build *an agent that uses tools*. Tenure is **a trust-accruing system that runs projects, remembers opinionatedly, recovers surgically, and proves it is getting better** — so human supervision asymptotically approaches zero for routine work and stays high for novel or dangerous work.

## The thesis

The bottleneck for enterprise agents is not model intelligence. A frontier model can already do most knowledge work in a single step. What blocks deployment is three things:

1. **Trust** — I cannot let it act unsupervised, because failure is silent and sometimes irreversible.
2. **Context** — it does not know my world (my data, my procedures, my history).
3. **Recovery** — when it is wrong, it fails opaquely and I cannot replay, fork, or correct.

Tenure is built around closing those three gaps, not around adding more tools. The tool loop is a commodity; the trust system is the product.

## What makes it different: earned autonomy

Every other agent platform treats permission as **binary and static**: a human approves each action forever, or the agent is turned loose. Both are wrong. Humans don't supervise a new hire's every keystroke for life, and they don't hand a stranger the keys on day one. Trust **accrues**.

In Tenure every action class carries a trust profile that moves with track record:

```
approve_each  →  (clean track record)  →  auto_with_alert  →  (rare review)
     ▲                                                              │
     └──────────────  (any failure / rejection resets)  ◀──────────┘
```

- **Reversibility is first-class.** Undoable actions graduate; irreversible ones never auto-execute, no matter the track record.
- **Risk tiers are respected.** Risk 3 always needs a two-admin quorum; trust never overrides it.
- **Every graduation is audited.** When the agent acts on earned autonomy, it emits a signed event with the exact track-record evidence that justified it.

This is the actual product. Not "an agent that can do anything" — a system where the cost of supervision *falls over time* for work that proves safe, and stays high for work that doesn't.

## The six pillars

### 1. Event-log substrate (source of truth)
Everything — intent, plan, tool call, observation, approval, correction — is an immutable event in an append-only log. Current state is a projection. This makes **time travel free**: replay a run with a better prompt, fork from step 4 with a human correction, show every decision that touched a customer's data. Audit, debugging, evals, and recovery become one mechanism instead of four bolted-on subsystems.
*Status: spec'd (see `docs/vision/EVENT_LOG.md`), foundation present in the durable run/workflow ledgers.*

### 2. Self-rewriting plan graph (parallel)
Not a linear tool loop, not a static DAG. A live plan graph where independent branches run in parallel via sub-agents, fan back in, and any failure or new observation triggers a **bounded re-plan of just the affected subtree**. The model decides the *shape* of the work, not just the next action.
*Status: single-agent loop + single-shot workflow replanning shipped; parallel sub-agents on roadmap.*

### 3. Opinionated, self-maintaining memory
Typed stores — facts (with provenance + confidence), episodes, procedures, semantic graph — plus a continuous reconciliation pass that dedupes, resolves contradictions, decays unused facts, and promotes repeated episodes into procedures. Memory that gets *better* with use, not just bigger. Every retrieval is explainable.
*Status: hybrid RAG + graph memory + consolidation present; reconciliation/decay on roadmap.*

### 4. Graduated autonomy (the trust ledger) — **shipped**
The earned-autonomy engine above. Track record + reversibility + risk tier determine whether an action gates or flows. See `src/lib/trust/`.

### 5. Adversarial verification
A separate critic model verifies every consequential output against acceptance criteria, **veto-only** (it can fail a passing run, never rescue a failing one), feeding failures into both the replan loop and the eval suite.
*Status: model-backed workflow verification shipped; per-output critic on roadmap.*

### 6. Eval-driven development (culture, not harness)
A golden set of real tasks with gradeable outcomes, run on every change, tracking a quality score over time. Agents regress invisibly; without continuous evals you ship vibes. Evals come first, features second.
*Status: agent-task golden set + scorer + scoreboard shipped (`evals/`, `src/lib/evals2/`).*

## What we deliberately do NOT build

- Not 13 workspaces. Three surfaces: **give it work, watch it think, approve when asked.** Everything else is progressive disclosure.
- Not our own auth/SSO/billing primitives — integrate best-in-class.
- Not provider-agnostic LLM abstraction on day one. Pick the best model, wrap it in one module, move on.
- Not governance theater. We do not build approval-quorum-break-glass machinery for a product with three users. Governance depth is *earned by real usage*, the same way the agent earns autonomy.

## Why this wins

The hard, un-fakeable half of an agent platform is governance: audit, isolation, approvals, recovery. Most "impressive demo" agents have none of it and cannot add it without a rewrite. Tenure starts from that foundation and adds the loop on top — and then adds the one thing nobody else has: a trust model that makes the economics of supervision improve over time. That compounding supervision cost reduction is the moat (see `BUSINESS_MODEL.md`).
