# Asael: a personal AI partner

Asael helps one owner carry real work across life and projects: understand an outcome, use relevant context, act through connected tools, follow progress, and show what actually happened. The relationship should become more useful with experience without making the owner operate an agent platform.

The owner selected this direction on 2026-10-12. The earlier enterprise business hypothesis is retained in [BUSINESS_MODEL.md](BUSINESS_MODEL.md) as historical context.

## The product promise

“Tell me what matters. I will help you move it forward, remember useful context, and bring back the decisions that need you.”

This is a direction, not a claim of unrestricted autonomy. Every visible state must distinguish planned work, attempted work, confirmed effects and verified outcomes. A task marked done or a linked file is evidence to examine; neither proves that the intended outcome was achieved.

## Four primary places

| Place | Owner's question | Main content |
| --- | --- | --- |
| Today | What needs my attention? | Focus, agenda, decisions and active work; other sections remain optional |
| Assistant | Can you help me think or do this? | Conversation, context, tool activity, decisions and results |
| My work | What are we moving forward? | Projects, tasks, progress and the existing work surfaces |
| Library | What do we know, and where did it come from? | Source documents, saved material and memory with provenance |

Specialist and operational tools remain available through secondary navigation and direct routes. Payments are absent from general navigation while the existing disabled capability and historical records remain intact. There is no reason to show every subsystem as an equally important destination.

## The first complete increment

The implementation on `codex/personal-partner` makes these concrete changes. Deployment remains subject to the existing release gates.

- Four primary destinations on web and native. Today defaults to its essential sections and preserves existing saved preferences.
- Work-item tracking through Responsibilities. A preset creates a reviewable inactive draft using a built-in read-only routine. The owner saves, reviews and activates the exact bounded configuration, and separately enables inbox delivery.
- Tracking observes one currently owned canonical work item, including status, deadline, overdue state, priority, owners, readable dependencies and linked outputs. The first observation establishes a baseline quietly. An unchanged observation stays quiet. Completion and reopening remain observable until expiry; completion is not labelled independently verified.
- Real paired text comparisons for proposed custom-agent guidance. The owner provides 3–10 different examples and literal assertions. Current and candidate guidance run on the same examples, model and definition without tools, retrieval or memory. Candidate activation requires more passing cases with no individual regression, fresh results and unchanged identity/model/guidance pins.
- Immutable comparison history and same-request recovery prevent retries from silently starting a new set of paid model calls. Incomplete, tied and regressed comparisons cannot activate new guidance. Existing active guidance remains reversible.
- Unused dashboard code is removed. Deep capability code is retained where current usage and migration evidence do not justify deletion.

## What remains experimental or deliberately narrow

Work-item tracking currently observes state; it does not autonomously finish the task, negotiate deadlines, change owners or send messages. The schedule and notification budgets are finite. Revoked access or changed authority blocks further checks rather than using stale permissions.

Text comparison tests output behavior on the supplied examples. Literal assertions do not measure general intelligence, factual correctness, tool reliability or statistical significance. A small winning suite is permission to consider this specific guidance change, not evidence of universal improvement. Model calls cost money, and the result records measured or unknown cost honestly.

The existing outcome evaluator still has limits. A model's own assertion must not be promoted to independently verified success. Adding domain-specific verifiers is a separate project that needs concrete deliverables and failure cases.

Trust history, confidence scores and past approvals do not replace current permission. Authority remains explicit, scoped, bounded and revocable. The interface should explain the decision in everyday terms and keep exact technical evidence available when needed.

## Next investments, earned by actual use

1. Make one recurring personal workflow excellent end to end: preparation, artifact, owner decision, confirmed action and follow-through. Select it from the owner's real work rather than inventing another subsystem.
2. Attach independent verifiers where outcomes are testable: a passing test suite, an expected document section, a confirmed calendar change or an acknowledged external receipt.
3. Improve memory by measuring whether retrieved context helped. Preserve source, scope, freshness, correction and deletion paths; do not collect context merely because it is accessible.
4. Offer useful next actions at the point of work. A suggestion should name the evidence, the action and its consequence. Avoid proactive messages without meaningful change.
5. Test guidance on examples withheld from its creation and track performance over repeated runs before making broader claims.

## What we will remove or refuse to expand

- Unused components with no callers and no retained-history role.
- Navigation that reflects implementation modules rather than the owner's questions.
- Confidence displays that imply successful execution or verified learning.
- Parallel state models without a clear current authority, compatibility need or retirement plan.
- New agent identities, dashboards or frameworks that cannot show a specific completed-work benefit.

Do not delete durable receipts, recovery mechanisms, actor boundaries or approval history to make the code count smaller. Simplicity means fewer concepts the owner has to manage and fewer competing implementations to maintain.

## How to judge progress

Use real weekly examples. Count completed outcomes with evidence, commitments caught before they are missed, useful corrections retained, unnecessary interruptions and recovery time after failures. Track model/tool cost alongside these outcomes. Do not use agent count, tool count, generated text volume or trust-score growth as product success metrics.

The architecture and execution rules remain in [architecture.md](../architecture.md) and [harness-engineering.md](../harness-engineering.md). This document defines the product direction; it does not override runtime authorization or release evidence.
