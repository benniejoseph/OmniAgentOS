# Tenure — Business Model

## The problem we sell against

Enterprises have piloted agents and stalled at production. The blocker is never "the model isn't smart enough" — it's "legal/security/ops won't let it run unsupervised, and supervising every action defeats the point." Companies are paying for agent *potential* and getting agent *demos*. The gap is trust infrastructure.

## What we sell

**Tenure is the trust and control plane for autonomous AI work.** Bring your own models and tools (MCP/OpenAPI/HTTP); Tenure governs them: risk-tiered execution, human approvals that get cheaper as the agent proves itself, immutable audit, tenant isolation, durable recovery, and continuous quality evals.

The unit of value is **supervised-action-cost reduction**: we measurably lower the human minutes required per unit of autonomous work, while raising the auditability bar. That is a CFO-legible and a CISO-legible pitch at the same time — rare.

## Who buys

| Segment | Buyer | Wedge use case |
|---|---|---|
| Mid-market ops teams | Head of Ops / RevOps | Back-office automation (billing, onboarding, data hygiene) that *must* be auditable |
| Regulated industries | CISO / Compliance | Agents in fintech, healthcare, legal where every action needs provenance |
| Platform/eng teams | Staff eng / Platform lead | "We have 40 internal agents and no governance" — Tenure as the control plane |

Land with one auditable workflow; expand as trust graduates more action classes to autonomy (expansion is built into the product mechanic — that is the point).

## Pricing

Three levers, deliberately aligned with value delivered, not tokens consumed:

1. **Platform fee** (per workspace/month) — control plane, audit, RBAC, SSO.
2. **Governed-action metering** — priced per *governed action* (a tool call that passed through policy/audit), not per token. Buyers understand "actions"; tokens are noise. Read-only/dry-run actions are free; side-effecting and approval-gated actions meter.
3. **Autonomy seats** — per action class graduated to `auto_with_alert`. This is the magic: *the more the customer trusts the agent, the more they pay, and they only trust it because it earned it.* Expansion revenue is mechanically coupled to delivered value.

| Tier | Price (indicative) | For |
|---|---|---|
| **Builder** | Free / OSS core | Solo devs, prototypes, local |
| **Team** | $499/mo + metering | Shared workspace, connectors, evals, 5 autonomy seats |
| **Enterprise** | from $4k/mo | Tenant isolation, SSO, signed evidence, unlimited seats, SLA |
| **Platform** | custom | Self-hosted control plane, dedicated support, custom risk policy |

Open-source the core engine (loop + governed tools + trust ledger); monetize the hosted control plane, SSO/compliance, and managed evals. OSS is the top of funnel and the trust signal — security buyers want to read the code that gates their agents.

## Moat

1. **Compounding trust data.** Every governed action makes the trust profiles smarter and the autonomy graduations safer. A competitor starting fresh has no track record; the customer's accumulated trust ledger is switching-cost gravity.
2. **Audit as lock-in (the good kind).** Once compliance signs off on Tenure's evidence model, ripping it out means re-certifying. We make that painless to stay and painful to leave by being genuinely better at evidence.
3. **The governance-first foundation.** Forced RLS, signed eval reports, SSRF guards, quorum approvals — competitors who led with demos cannot retrofit these without a rewrite. We start where they have to end up.
4. **Eval culture as a product surface.** "Prove your agent got better this quarter" is a board-level question with no good answer today. Our scoreboard is that answer.

## Unit economics (illustrative)

- COGS per governed action is dominated by one model call + storage of one event. At frontier-model prices that is cents; metered well above cost.
- The expensive actions (model-heavy planning, verification) are exactly the high-value ones buyers will pay for; cheap read-only actions are free and drive usage/habit.
- Gross margin target 75–85% at scale (standard infra-SaaS), with the autonomy-seat line carrying near-100% margin since graduation is a policy state change, not added compute.

## Go to market

1. **OSS launch** of the core (Show HN / r/LocalLLaMA / r/devops): "An agent control plane that makes approvals cheaper as the agent earns trust." Ship the trust-ledger demo as the hook.
2. **Design-partner program**: 3–5 regulated-industry teams, free Enterprise for 6 months in exchange for case studies on supervision-cost reduction.
3. **Content moat**: publish the evidence model, the trust-graduation math, and quarterly "agent quality scoreboard" methodology. Be the canonical reference for "how do you safely let an agent act."
4. **Bottoms-up to top-down**: devs adopt OSS → ops teams hit the governance wall → security blesses Enterprise.

## Roadmap to scale (engineering)

| Milestone | Capability | Scale unlock |
|---|---|---|
| **M-now** | Trust ledger + graduated autonomy + eval scoreboard (this build) | The differentiator exists and is testable |
| **M1** | Event-log substrate as source of truth | Time-travel debugging, replay-based evals, one audit mechanism |
| **M2** | Parallel sub-agents + self-rewriting plan graph | "Run a project," not "do a task" |
| **M3** | Self-maintaining memory (reconcile/decay/promote) | Quality holds as data grows |
| **M4** | Per-output adversarial critic + sandbox-first simulation | Safe autonomy for higher-stakes action classes |
| **M5** | Multi-region, SOC2/HIPAA evidence automation | Enterprise/regulated at scale |

## The bet in one line

We are betting that the winning agent company is not the one with the smartest loop, but the one that makes **trust auditable and supervision cheap over time** — and that the foundation for that is governance, which we already have.
