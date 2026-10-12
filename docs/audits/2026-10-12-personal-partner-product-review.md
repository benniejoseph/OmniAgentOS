# Asael: a personal partner that carries work through

Date: 12 October 2026. Source reviewed: `70b1522a`.

This review records the starting point. The owner subsequently authorized implementation; see the [implementation and validation record](2026-10-12-personal-partner-implementation.md) and [current product vision](../vision/PRODUCT.md) for the resulting changes.

This is a product proposal grounded in source inspection, not an accepted architecture decision or a production certification. The owner selected the direction: **a personal AI partner that runs real work across life and projects**. Three parallel reviews covered execution and learning, web/native experience, and architectural complexity. No application code was changed, no live integrations or paid model runs were invoked, and no tests were run. Dependencies were absent from this checkout. Implemented below means a code path exists; it does not establish activation or production reliability. There was no usage telemetry available to prove that a feature is unused.

**My judgment: Asael has a substantial execution foundation, but its product identity and its evidence of useful intelligence have not caught up with that foundation.** It is more mature at controlling and recording work than at establishing whether the user's intended outcome happened. Its most promising purpose is continuity: remembering what matters, carrying a commitment across days and applications, and returning with useful results or a precise decision.

The proposed promise is: **“Asael knows what matters to me, carries my work forward, and gets better at helping me.”** Treat each part as a measurable obligation. A warm personality can support this experience, but continuity must come from reliable behavior.

The older product vision centers enterprise trust infrastructure; the business-model document still calls the product Tenure and sells a control plane to operations/security teams. Those are different buyers and different daily experiences. Archive that commercial direction as an option and write one current personal-product brief. Also correct claims that imply trust scores independently authorize actions: current execution uses bounded grants, and trust profiles are advisory. Sources: [product vision](</Volumes/Extreme Pro/Projects/OmniAgent/docs/vision/PRODUCT.md:7>), [business model](</Volumes/Extreme Pro/Projects/OmniAgent/docs/vision/BUSINESS_MODEL.md:9>), [current trust endpoint](</Volumes/Extreme Pro/Projects/OmniAgent/src/app/api/trust/route.ts:68>), [executor](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/tools/executor.ts:1406>).

**What deserves to survive and become easier to use**

The model/tool loop is real. It discovers capabilities progressively, bounds work, streams events, and persists the conversation and scope when an approval pauses execution. The memory path distinguishes user assertions, assistant candidates, and verified effects. This provides the basis for dependable action and correctable memory. Preserve it. Sources: [agent continuation](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/orchestration/agent-runner.ts:2618>), [tool discovery](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/capabilities/toolbox.ts:76>), [memory formation](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/memory/evidence-formation.ts:69>).

The clearest existing product journey is already in Work: define a successful outcome, plan, start bounded execution, collect outputs/evidence, and record what to repeat or change. Meetings can already turn cited commitments into canonical WorkItems and optional unsent follow-up drafts. These are useful building blocks, not features that need to be invented again. Sources: [project outcome and planning](</Volumes/Extreme Pro/Projects/OmniAgent/src/components/projects-workspace.tsx:671>), [results and feedback](</Volumes/Extreme Pro/Projects/OmniAgent/src/components/projects-workspace.tsx:776>), [commitment conversion](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/app-services/meetings.ts:392>).

The Mac investment also has a purpose: quick capture, voice, keyboard access, and local computer actions are natural entry points for a personal partner. Keep platform-specific presentation with shared application contracts. Let mobile specialize in capture, updates, and decisions; let web provide convenient access, review, and setup. Avoid making every client reproduce every advanced workspace. Source: [native architecture](</Volumes/Extreme Pro/Projects/OmniAgent/apps/flutter/README.md:13>).

**Where the current capabilities stop**

| Area | Evidence in current source | Product implication |
|---|---|---|
| General outcome verification | Workflow criteria begin as `model_assertion`, with no verifier ID or required artifact/effect bindings; a positive review remains unverified. | Producing a plausible answer is not sufficient evidence that a task was completed. Add specific outcome verifiers. |
| Ongoing responsibilities | The executable pilot watches one native Meeting's structured metadata, daily/weekly, and stops at expiry, start, or cancellation. | It cannot yet serve as a general partner that follows all commitments or projects. Extend one useful adapter at a time. |
| Learning | Daily learning records evidence; a proposal's shadow-comparison hash binds baseline/proposal metadata and is followed by model review. | A recorded comparison is not an experiment showing better behavior. Run baseline and candidate on the same held-out tasks. |
| Local semantic retrieval | The local multilingual fallback uses feature hashing and concept aliases; the learned reranker uses four features and ten synthetic training examples. External embeddings also exist. | These fallbacks may be useful, but broad semantic competence must be measured on actual personal questions. |
| Evaluation | The checked-in live-model golden set has six tasks, mostly keyword/length/regex assertions. Unit, integration, and other evaluation lanes are much broader. | Framework correctness has more coverage than demonstrated everyday usefulness. Add representative outcome tasks. |

Evidence: [outcome requirements](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/workflows/outcome-evaluator.ts:303>), [unverified results](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/workflows/outcome-evaluator.ts:588>), [responsibility pilot](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/responsibilities/runtime-contracts.ts:6>), [daily learning](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/agents/learning-service.ts:65>), [adaptation comparison](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/agents/adaptation-proposals.ts:413>), [local embeddings](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/rag/retrieval-embedding.ts:106>), [reranker](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/rag/learned-reranker.ts:53>), [live task corpus](</Volumes/Extreme Pro/Projects/OmniAgent/evals/golden-tasks.json:4>).

**The shape I would give the product**

One continuing relationship with Asael; four main destinations. Specialists, workflows, and model routing support the work without demanding that the owner understand the architecture first.

| Destination | Purpose | What moves into it |
|---|---|---|
| Today | What changed, what needs me, what is moving forward? | Relevant updates, decisions, overdue commitments, completed outcomes. |
| Assistant | Think, ask, delegate, correct, or continue. | Text, voice, quick entry, and a smooth transition into persistent work. |
| My work | Carry projects and recurring responsibilities through. | Plans, tasks, current execution, outputs, and history inside the relevant project or responsibility. |
| Library | Find what Asael knows and what we have made. | Sources, files, accepted outputs, decisions, preferences, and editable memories, clearly distinguished. |

Keep one persistent attention queue accessible from every surface. Move Connections, Skills, model settings, specialist setup, and administration into contextual setup or Settings. A conversation can become a Project without re-entering the goal or losing its sources.

The current web navigation has 21 entries; its primary set is Assistant, Work, Activity, Memory, and Capabilities. Today and Inbox sit outside those primaries. Today defaults to all nine sections. The proposal changes the emphasis from inspecting/configuring machinery to giving work, following progress, and making decisions. Sources: [navigation](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/navigation.ts:54>), [primary set](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/navigation.ts:197>), [Today defaults](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/today/sections.ts:1>).

First use should achieve one meaningful result using the minimum necessary context. Current Assistant starters emphasize producing documents, while `/onboarding` redirects to the app. A better first interaction is “What would you like me to take off your plate?” followed by one scoped outcome. Sources: [entry path](</Volumes/Extreme Pro/Projects/OmniAgent/src/app/onboarding/page.tsx:1>), [starter prompts](</Volumes/Extreme Pro/Projects/OmniAgent/src/components/agent-runs-workspace.tsx:3760>).

**The first feature I would finish: “Keep my important commitments from getting dropped.”**

Start with one real project and commitments that already become WorkItems. Add a Responsibility adapter for a canonical WorkItem, reusing the existing lifecycle, budgets, observations, and delivery machinery. This is a narrow extension of an existing system.

1. Bind the responsibility to the exact WorkItem, its owner, deadline, source, and relevant output.
2. Distinguish active work, waiting on someone, changed deadlines, overdue work, and claimed completion.
3. Read back authoritative state and run an appropriate verifier. A checked task box proves that a person marked it done; verifying the actual deliverable requires additional evidence.
4. Create a private update when something materially changes, with one useful next action. Reuse the existing follow-up draft path.
5. Close the responsibility when its specified outcome is verified, canceled, or reaches its explicit end condition.

The demonstration should continue across a restart and a later day. It should catch a changed deadline, avoid duplicate work, stay quiet while nothing changes, and explain why it thinks something is complete. Success means the owner spends less effort carrying commitments mentally.

**Four larger bets worth pursuing after that slice**

1. **A personal memory that can explain itself.** Make people, projects, commitments, preferences, and decisions understandable through existing memory and entity records. Show “where this came from,” “when it applied,” and “what replaced it.” Let a correction preview the affected plans or reminders. Separate explicit preferences, observed patterns, and tentative inferences. Do not create another independent graph store; improve the current evidence and retrieval path. Test questions like “What changed since last week?” and “Why did we decide this?” against known answers.

2. **An apprenticeship loop that proves improvement.** After accepted work or a correction, propose a parameterized routine or guidance change. Reuse saved procedures, adaptation proposals, activation, and rollback. Replay the old and new versions on matched cases, including failures and held-out examples. Measure completed outcomes, corrections, cost, and time. Promote only a demonstrated improvement. This is learning procedures and preferences, not evidence that model weights are being trained. Successful skill reuse without weight updates has a research precedent in [Voyager](https://arxiv.org/abs/2305.16291); its Minecraft results are inspiration for this experiment, not evidence that Asael will achieve the same gains.

3. **Interfaces that appear for the current project.** A move can expose a comparison sheet and checklist; a launch can expose a research board and publishing plan; a software project can expose the existing builder. Generate small, disposable views over typed existing data and governed actions. Keep the first version to a few constrained templates. The goal is to remove manual navigation and form entry, not create an unrestricted second application platform. App Builder already supplies a separate sandbox and delivery foundation; it does not establish that general project-specific interface generation exists today. Source: [builder contracts](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/app-builder/contracts.ts:5>).

4. **A bounded personal research lab.** Allow Asael to investigate one hypothesis connected to an active goal: compare two project approaches, try a better research routine, or diagnose why its own task failed. Produce the experiment, observations, and recommendation. Reuse correction/forking and artifact infrastructure; do not add a parallel runtime. For harness changes, produce a reviewable patch and benchmark result with rollback. A daily research budget and explicit stop condition make the work useful rather than endless. Forking already exists: [fork store](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/runs/fork-store.ts:164>).

**What I would consolidate, park, or remove**

| Candidate | Decision | Reason and dependency |
|---|---|---|
| Separate Projects, Missions, and task mental models | Consolidate | Finish `Workspace → Project → WorkItem`; preserve existing records and history before retiring legacy projections. |
| Activity, Results, workflow views, and repeated configuration destinations | Consolidate | Put progress, artifacts, history, and configuration next to the work they describe. Useful views can remain without being global destinations. |
| Markets, Account 360, Meetings, and App Builder | Make contextual | Keep working specialist capabilities as project tools. Their existence does not justify making every user navigate separate products. |
| AP2 payments | Park expansion | Current readiness reports disabled modes, zero effect tools, and zero accepted adapters. Revisit for a concrete personal task and provider. |
| Moltbook autonomous social activity | Keep opt-in experiment | It is a bounded social-platform activity, not proof of useful independence across the owner's life. Give personal goals priority for autonomous effort. |
| Loop v2, checkpoint/memory shadows, overlapping receipt/compiler versions | Complete or retire transitions | Use the existing complexity registry and its exit evidence. A canary's existence does not prove promotion readiness. |
| Production-shaped JSON persistence fallback | Investigate retirement | New private-memory capabilities require the database; maintaining two incomplete implementations costs effort. Inventory local-demo and test dependencies first. |
| v1–v47 native contract construction in active source | Simplify after consumer audit | Current source advertises v47/v46 support. Preserve published frozen contracts and compatibility tests; do not infer deployed version from source. |
| Generic multi-stage planning for small known jobs | Remove unnecessary stages | Route a known routine directly; use specialist fan-out only where outcome or latency measurements justify it. |
| Historical claims and stale product copy | Replace with current capability matrix | Separate implemented, enabled, verified, experimental, and retired. Keep historical plans as history. |

Sources: [work-model compatibility](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/workspaces/legacy-projection.ts:23>), [payment readiness](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/payments/ap2-readiness.ts:320>), [Moltbook charter](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/moltbook/autonomy-runner.ts:26>), [complexity registry](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/architecture/complexity-registry.ts:1>), [dual workflow storage](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/workflows/store.ts:441>), [database-only private memory](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/memory/store.ts:1248>), [native versions](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/mobile/contracts.ts:74>), [historical native dispatch](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/mobile/contracts.ts:2602>), [fallback planning](</Volumes/Extreme Pro/Projects/OmniAgent/src/lib/workflows/planner.ts:1035>).

The registry gives retired routes an October 17, 2026 decision date and most other listed transitions a December 28 review date. These dates are approaching commitments, not permission to remove paths without checking their exit conditions. Consolidate the main loop's shared model-turn, tool-call, continuation, and finalization behavior incrementally; avoid a rewrite while several replacement paths are still being evaluated.

Keep actor/tenant scope, idempotency, cancellation, recoverable work, evidence, and bounded authority. For a personal partner, these support ordinary reliability: one action happens once, “stop” works, private context stays correctly scoped, and failures are explainable. Hide low-level IDs and receipts behind Details. Keep the model gateway; prefer one measured default route and an explicit fallback policy over a user-facing model-selection burden.

**How I would judge progress**

Build a benchmark from 20 actual recurring or representative personal jobs. This is a proposed starting corpus, not a claim about current usage. Include at least five multi-day jobs and repeat the hardest cases several times. Compare the database/artifact outcome with an annotated expected result and report consistency across trials. That evaluation approach is motivated by [τ-bench](https://arxiv.org/abs/2406.12045), which measures final state and repeated-run reliability; its older model scores do not describe current Asael performance.

Track accepted completed outcomes, human intervention minutes, correction rate, false completion claims, unnecessary interruptions, duplicate effects, and cost per accepted result. Start with a baseline before choosing numerical targets. For ambiguous creative work, use owner acceptance with a rubric; for mechanically checkable work, use readback or tests. Keep these two kinds of evidence distinct.

The next development cycle should have four deliverables, in order:

1. A current capability matrix, the four-destination product map, and a baseline from real personal tasks.
2. The WorkItem follow-through adapter, one concrete outcome verifier, and a useful Today/Assistant presentation.
3. One repeated task converted into a tested routine, with baseline/candidate comparison and visible rollback.
4. At least one measured transition completed and its superseded implementation removed; pause unrelated new subsystems during this cycle.

The thesis is testable: **if Asael remembers the right commitments, carries them through without repeated explanation, and demonstrably needs fewer corrections over time, it has earned a place in the owner's daily life.**
