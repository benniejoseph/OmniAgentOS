# Jev and Herd — Asael architecture assessment

Status: researched on 2026-09-18. The Stage 2 routing pilot is implemented as an opt-in, shadow-only integration; it remains inactive until an owner connects TypeSafe in Settings and assigns a discovered model to the Semantic decisions scope.

## Decision

Adopt Jev experimentally as a separate typed-decision provider. Do not replace Asael's generative model gateway, deterministic policy, approval system, or governed tool executor with it.

Borrow Herd's provider-harness and machine-readiness patterns, but do not embed Herd as a second control plane. Asael already owns durable Missions, delegated workers, approvals, retries, machine execution, memory, typed events, and tenant/actor-scoped authorization. A second owner for those states would introduce split-brain recovery and approval behavior.

"Herd" is ambiguous. This assessment assumes [NickGuAI/Herd](https://github.com/NickGuAI/Herd), the agent-fleet meta-harness most closely aligned with Asael. [herd-ag/herd-core](https://github.com/herd-ag/herd-core) is a materially different, execution-agnostic governance framework. Confirm the intended project before implementing an adapter.

## Jev

[TypeSafe AI's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is an early-access System One model for fast, typed probabilistic judgments rather than chat or free-form generation. A request supplies a state and one or more atomic questions. It returns constrained values that ordinary code composes:

- `Choice`: one value from a declared option set, with option probabilities and confidence.
- `Score`: a position on a declared ordered rubric, with probabilities and confidence.
- `Noul`: a probability from zero to one for a yes/no proposition.

TypeSafe's [introduction](https://docs.typesafe.ai/introduction) and [primitive contract](https://docs.typesafe.ai/primitives) explicitly recommend decomposing complex judgments into independent questions and combining their answers in code.

Jev's constrained output prevents out-of-schema text generation; it does not make the judgment automatically correct. Confidence and probability must be calibrated against Asael's own evaluation set. The provider is new and early access, and its published latency, cost, and quality comparisons are vendor results rather than Asael production evidence.

### Best initial Asael uses

1. **Semantic intent metadata.** Classify closed fields such as intent, execution shape, consequential action, clarification need, and bounded capability selection. Keep current deterministic safety policy authoritative. Retain an ordinary model or deterministic extractor for entity references and generated retrieval queries.
2. **Model and execution routing.** Recommend fast versus reasoning model, direct versus durable execution, and whether vision, retrieval, tools, or specialist review are likely needed. Explicit user settings and verified capability requirements always win.
3. **Authorized-candidate reranking.** Score or reorder a tenant/actor-authorized retrieval set. The evaluator may shrink or reorder the set but must never add inaccessible content.
4. **Verifier triage.** Decide whether a result warrants full Sentinel review, whether supplied evidence appears relevant, or whether an outcome is likely a no-op. It must not mark an external effect verified.
5. **Monotonic safety signals.** It may raise risk, request clarification, or require human/verifier review. It may never reduce registry risk, waive approval, create authority, or establish that a mutation succeeded.

### Required integration boundary

Do not add Jev to the existing generative provider interface. Introduce a distinct `SemanticDecisionProvider` contract whose typed receipt records:

- tenant, actor, purpose, provider, model, and version;
- input-state and question-schema digests, without retaining raw state by default;
- typed answers, bounded probabilities, confidence, thresholds, and policy version;
- latency, usage/cost, timeout, fallback, and evaluation outcome.

Credentials must remain server-side and vault-managed. The provider must be configurable from Settings, tenant opt-in, time-bounded, kill-switchable, and recorded in the canonical AI usage ledger. Retrieved or external state remains untrusted input.

## Herd

[NickGuAI/Herd](https://github.com/NickGuAI/Herd) is a self-hosted meta-harness above coding-agent providers such as Codex, Claude Code, Gemini CLI, and OpenCode. It owns commanders, workers, missions, provider sessions, machine routing, approvals, memory, and a command-room interface.

The useful concepts for Asael are boundary patterns:

- a normalized provider-harness adapter with readiness, start, steer, cancel, heartbeat, status, and artifact collection;
- explicit machine enrollment and readiness rather than inferring a target from an agent persona;
- durable mission state that outlives any provider CLI session;
- operator-visible fleet status, placement, cancellation, recovery, and bounded progress;
- proposal-versus-authorization separation for consequential actions.

Herd's own [security policy](https://github.com/NickGuAI/Herd/blob/main/SECURITY.md) targets self-hosted, single-operator, trusted infrastructure and states that its approval layer is not a multi-tenant sandbox. Asael must retain its stronger tenant/actor, RLS, governed-effect, and typed-receipt boundaries. Herd's current AGPL licensing also requires legal review before copying, modifying, linking, or deploying its code as part of a non-AGPL product.

### Asael-native incorporation

1. Define `AgentHarnessAdapter` independently of provider CLI details.
2. Extend Mission attempts with a normalized external-harness execution type while Asael remains the sole source of truth.
3. Add an execution-target registry containing tenant/owner, transport, capabilities, provider readiness, credential provenance, attestation revision, heartbeat, lease capacity, and revocation state.
4. Dispatch through the existing operation queue, lease/fence-token machinery, governed tools, and approval policies.
5. Treat provider transcripts, terminal output, repositories, patches, and artifacts as untrusted. Persist bounded metadata, digests, receipts, sanitized failures, and artifact references—not provider reasoning.
6. Use isolated worktrees or stronger sandboxes, explicit repository binding, cancellation, network policy, scoped provider credentials, and independent verification before integration.
7. Project fleet status into existing Mission and Conversation surfaces instead of creating a second command room.

Do not run Herd beside Asael as an equal orchestrator. Dual mission, retry, approval, and cancellation state would create ambiguous ownership and unsafe recovery.

## Staged delivery plan

### Stage 1 — Jev evaluation only

- Obtain early-access and data-handling details.
- Build a provider-neutral typed-decision adapter and an offline replay harness.
- Compare Jev with current deterministic and configured-model results on redacted intent, routing, relevance, and verification cases.
- Measure accuracy, calibration by confidence band, latency, cost, abstention, adversarial-content response, drift, and failure rate.

### Stage 2 — shadow production

- Run closed-field semantic and routing judgments without changing behavior.
- Persist content-minimized decision receipts and compare them with actual outcomes.
- Add per-tenant opt-in, strict timeouts, current-path fallback, and an instant kill switch.

Implemented boundary:

- `SemanticDecisionProvider` is separate from the generative model gateway and exposes no tools or mutation surface.
- TypeSafe credentials and the exact model come only from the actor-owned sealed Settings connection and validated catalog assignment. There is no environment or hardcoded-model fallback.
- The first pilot classifies `direct`, `durable_workflow`, or `clarify` after the live route is chosen. Its answer never changes that route, approval, risk, or authority.
- Calls are capped at 1.8 seconds and fall back to the existing deterministic route. The emergency switch is `OMNIAGENT_SEMANTIC_DECISION_SHADOW_DISABLED=true`.
- Typed `intent.semantic_decision_shadowed` events and `semantic_decision` usage receipts store assignment revision, configured and response model versions, probability/confidence, latency, outcome, and content digests rather than the raw request.

### Stage 3 — bounded activation

- Activate only low-risk, high-confidence model-tier selection and authorized-candidate ordering.
- Allow only monotonic safety escalation and verifier triage after calibration gates pass.
- Never give the decision model direct tool authority.

### Stage 4 — one external harness canary

- Implement one Asael-native provider adapter for one enrolled machine and one repository.
- Use isolated worktrees, existing Mission attempts, existing queue leases, and governed approvals.
- Exercise worker death, lease loss, duplicate completion, stale sessions, revocation, cancellation, worktree collision, credential rotation, and malicious output before expanding.

## Recommendation

Jev addresses a real gap: cheap, fast, typed decisions whose uncertainty can be evaluated. It is the higher-value experiment, provided it stays advisory until calibrated.

Herd validates Asael's direction and offers useful adapter, readiness, and fleet-observability patterns. Asael already contains the durable orchestration and governance core, so wholesale adoption would add licensing, security, and split-state risk without a proportional benefit.
