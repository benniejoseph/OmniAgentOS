# Gemini, Claude, Perplexity, and Asael research

Reviewed 8 October 2026 (Asia/Kolkata). This separates official product documentation, disclosed engineering designs, and the implementation in the `codex/deep-research-workflow` working tree. The earlier live-run baseline used production revision `5f06cf0f8e175ab29a9ffa14f8410ee7d09cc9b2`; its measurements do not validate the new implementation. This is not a controlled comparison of answer quality, accuracy, speed, or cost. No paid competitor product runs were performed.

Asael now has separate Quick and durable Deep research paths in the implementation. The changes apply useful patterns from the documented systems through Asael's own governed tools and workflows. They do not integrate a paid competitor agent or establish parity with a vendor's research quality.

## What the other products document

**Gemini Apps:** users can choose sources, edit the proposed plan, and start the investigation. Supported evidence includes the web, uploads, and connected Google sources, subject to account availability. Research can continue after leaving the chat, with completion notification. Reports can be refined and exported to Docs. Google describes typical waits of 5–10 minutes, with longer complex tasks; this is a product expectation, not a latency guarantee. [Google's app instructions](https://support.google.com/gemini/answer/15719111?hl=en).

Google's overview describes repeated discovery, reading, gap detection, and synthesis, with potentially hundreds of sites. Its account of the original architecture discusses planning, asynchronous tasks, retrieval, and repeated review. That historical description does not establish the exact current agent topology or stopping algorithm. [Deep Research overview](https://gemini.google/overview/deep-research/).

**Gemini API:** the current preview provides a dedicated Deep Research agent and a more extensive Max version through the Interactions API. Background execution is required; clients can poll or stream. Collaborative plan review is optional. The guide documents MCP connections and document inputs. This is a separate integration from ordinary generation: selecting Gemini as Asael's writer does not enable it. Preview lifecycle and storage requirements need separate consideration. [Developer guide](https://ai.google.dev/gemini-api/docs/deep-research?hl=en).

**Claude Research:** current help describes successive searches, investigation across different angles, citations, and connected Google context when enabled. Research is offered on paid plans and consumes their allowance. [Claude Research help](https://support.claude.com/en/articles/11088861-use-research-on-claude).

Anthropic's June 2025 engineering account describes a lead researcher that plans, delegates independent questions to parallel subagents, combines findings, and investigates gaps. A separate citation stage links findings to sources. It discusses source judgment, clear subtask boundaries, recovery, and effort scaled to complexity. Its reported quality gains and roughly 15-times-chat token usage concern its historical internal workload, not current comparisons with Asael. The present consumer product's exact configuration is not fully public. [Published research architecture](https://www.anthropic.com/engineering/multi-agent-research-system).

Claude's developer web-search and fetch tools are separate building blocks. Fetch reads HTML, text, and PDFs without rendering JavaScript; passage citations require configuration. A developer still implements the research workflow. [Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool).

**Perplexity app:** its current product page presents Deep Research inside Computer: a research plan, subtask routing across models, uploaded files alongside live web evidence, cited reports, and subsequent slides, spreadsheets, or dashboards. Statements about thousands of retrieval steps, hundreds of sources, optimal model routing, and verification are vendor claims. The page does not disclose enough to reproduce the complete planner, source scoring, stopping rule, or verification algorithm. Illustrated timings are not comparative benchmarks. [Deep Research in Computer](https://www.perplexity.ai/en-GB/hub/products/deep-research).

**Perplexity developer products:** the Agent API is distinct from the app. Current presets expose depth through model, tool, reasoning, and step settings, with configurable retrieval and per-page context allowances. Research presets include inline source-ID citation instructions. Names and defaults are configuration choices, not guarantees of exhaustive evidence or correct conclusions. [Agent API presets](https://docs.perplexity.ai/docs/agent-api/presets).

Background Agent API calls return an ID and continue after a client disconnects. Clients poll or reconnect to streamed events and handle completed, failed, canceled, and incomplete results separately. This lifecycle pattern is useful without adopting that API. [Background mode](https://docs.perplexity.ai/docs/agent-api/background-mode).

Perplexity's Search SDK documents composable retrieval, ranking, filtering, and concurrent queries, with intermediate state held in the runtime and explicit provenance and checkpoints. These are disclosed SDK capabilities, not proof that the consumer app uses an identical execution graph for every request. [Search SDK](https://docs.perplexity.ai/docs/search-sdk/overview).

Older Sonar Deep Research tutorials require care: the migration guide says Sonar Chat Completions support ended on 27 September 2026. Synchronous and streamed requests are being reformulated through the Agent API; old asynchronous Sonar requests require background-mode migration. [Sonar migration guide](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).

Citations and vendor descriptions do not establish guaranteed factual accuracy. An SDK feature, API preset, and consumer Research mode are separate surfaces. Claude Cowork's background lifecycle should not be silently attributed to the Research toggle.

## What the Asael implementation now does

| Stage | Implemented behavior | Practical limitation |
|---|---|---|
| Scope and plan | Both depths accept focus questions, source guidance, and allowed domains. Quick has up to three questions; Deep up to six and generates a structured topic plan when none were supplied. | The brief is editable before starting. The generated Deep plan is visible, but has no in-flight collaborative editor. |
| Discovery | Quick permits four searches and one gap round. Deep permits ten searches and two gap rounds. Shared run allowances can stop earlier. | These are ceilings, not promised call counts. Source restrictions remain authoritative. |
| Source selection | URLs are deduplicated, ranked against question facets, and spread across hosts. Quick permits eight reads; Deep eighteen. | Lexical relevance and different hostnames do not prove primary-source authority or independent corroboration. |
| Reading | Governed public HTML, text, and text-based PDF reading, with query-relevant passages, source hashes, offsets, and PDF pages where available. Domains are checked before every redirect. | No authentication bypass, JavaScript rendering, scanned-PDF OCR, or guarantee of whole-document reading. Byte, text, page, and timeout bounds still apply. |
| Evidence | Quick has a 48,000-character synthesis envelope; Deep has 72,000. Retained passages stay exact instead of being rewritten by an extraction model. | The writer may see only a subset of retained text. Truncation and gaps are disclosed. |
| Iteration | Per-question coverage schedules distinct bounded gap searches and replacement reads. | Coverage is a relevance heuristic, not factual verification. |
| Parallelism | Deep admits at most two independent retrievals per delivery, charges fan-out, and becomes sequential when that allowance is exhausted. Quick remains sequential. | No uncontrolled child-agent expansion or unmetered research pool. |
| Reports | Detailed prose, adjacent citations, comparisons, limitations, and source appendix. Deep targets 1,800–3,000 words when supported. | User format preferences and evidence quality take precedence over length. |
| Claim review | Deep models review selected material claims; deterministic checks bind exact claim text, quote text, citation IDs, passage IDs, and hashes to the saved draft. | Receipts explicitly say `method: model_review` and `truthVerified: false`. This neither activates generic verified grounding nor establishes exhaustive review. Quick does not gain this separate stage. |
| Lifecycle | Deep reuses the queue, step fences, budget events, pause/resume/cancel controls, and persisted evidence journal. Completed model receipts are reused; uncertain model calls pause for explicit resume. | Disconnection is not a new research request. Uncertain paid searches are not automatically replayed. Worker availability and invocation time matter. |
| Storage and context | Deep saves a versioned report in the workflow result and a linked assistant turn. Selected client, owner role, files, and model boundaries are revalidated using existing Command context. | Changed scope/revisions cannot silently widen resumed work. Private retrieved context is excluded from discovery-plan inputs; personal-context mode disables external web. |
| Providers | Writing/review use configured structured-model routes or the pinned Command model. Hosted discovery retains its separate OpenAI route. | Selecting Claude or Gemini does not invoke their consumer research agents. Unavailable tools/providers produce limitations or an uncertain-call pause. |

Code evidence: [contracts](../../src/lib/research/contracts.ts), [plan](../../src/lib/research/plan.ts), [passage coverage and review](../../src/lib/research/evidence.ts), [research helpers](../../src/lib/orchestration/research.ts), [durable research](../../src/lib/research/workflow.ts), [workflow integration](../../src/lib/workflows/runner.ts), [Quick runtime](../../src/lib/orchestration/agent-runner.ts), [reader](../../src/lib/web-search/read.ts), [search adapter](../../src/lib/web-search/search.ts), [request routing](../../src/app/api/agent/route.ts), [budgets](../../src/lib/config.ts), [grounding](../../src/lib/rag/citations.ts).

The earlier baseline live verification completed five searches with zero search failures, four successful reads and two failed reads, and a 1,158-word report with eight valid citations across seven URLs. Failures were HTTP 404 and restricted automated access. Coverage notes identified missing and truncated material; grounding remained `missing`. This demonstrates functioning collection/reporting in that earlier revision, not full verification or equivalence to another product.

The repaired search adapter preserves a completed search when a subsequent page-open attempt remains unfinished in the exact observed response shape. It discards mixed answer prose and sources outside that completed search and records the limitation. That transport repair does not solve planning and evidence coverage by itself.

## Adapted patterns and remaining limits

1. **Separate discovery, reading, and synthesis.** The Search SDK's composable retrieval pattern informed a persisted evidence phase. Asael uses fixed governed operations rather than arbitrary generated search code, reserving budget for the report and review.
2. **Spend depth on a missing question.** Gemini's iterative investigation and Perplexity's configurable depth informed bounded gap rounds and question-directed passages. Current source scoring is deterministic lexical relevance, not a learned quality model.
3. **Make progress and incomplete outcomes durable.** Background API lifecycles informed resumable progress and partial-report status. Asael retains its owner checks, model journal, leases, and idempotent tool receipts instead of delegating to a paid external agent.

The implementation does not add unrestricted connected-app searches, subscription research databases, browser rendering, OCR, automatic truth certification, or competitor-sized source volume. Source restrictions and ordinary run budgets remain authoritative. Realistic quality evaluation is still needed before claiming better research outcomes.

For CSM work, distinguish uploaded client material, the owner's role context, public Salesforce guidance, and proposed actions. Explain what changed for the selected client, what is supported, and what needs follow-up. Client scope survives planning, retrieval, and storage; no Salesforce-org connection is required.

No Gemini Deep Research, Perplexity Agent API, or Claude consumer Research adapter was added. Future integration requires its own reviewed disclosure, provenance, usage, and recovery contracts; changing the answer model does not supply those capabilities.

Before comparative quality or cost claims, use an explicitly authorized evaluation with the same bounded prompts, source conditions, and budgets. Measure question coverage, claim support, relevance, contradictions, useful actions, latency, and billed usage. Automated evaluations remain deferred under the owner's instruction. The new behavior above is implementation evidence, not a new live quality, latency, cost, or production-readiness measurement.
