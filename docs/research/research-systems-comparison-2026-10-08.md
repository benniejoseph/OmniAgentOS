# Gemini, Claude, and Asael research

Reviewed 8 October 2026 (Asia/Kolkata). Asael baseline: production revision
`5f06cf0f8e175ab29a9ffa14f8410ee7d09cc9b2`. This compares official product
documentation and published engineering descriptions with the current code and
one recorded Asael live run. It is not a controlled comparison of answer quality,
accuracy, speed, or cost. No paid Gemini or Claude product runs were performed.

Asael has a working research foundation, but its default investigation is less
adaptive than the documented Gemini and Claude workflows. The most valuable next
improvements are better question decomposition, passage selection, evidence-gap
handling, and resumable research. A larger word target alone will not fix missing
evidence.

## What the other products document

**Gemini Apps:** users can choose sources, edit the proposed plan, and start the
investigation. Supported evidence includes the web, uploads, and connected Google
sources, subject to account availability. Research can continue after leaving the
chat, with completion notification. Reports can be refined and exported to Docs;
the UI also offers other report treatments. Google describes typical waits of
5–10 minutes, with longer complex tasks. These are product expectations, not a
latency guarantee. [Google's current app instructions](https://support.google.com/gemini/answer/15719111?hl=en).

Google's overview describes repeated discovery, reading, gap detection, and
synthesis, with potentially hundreds of sites. Its account of the original
architecture discusses planning, asynchronous tasks, retrieval, and repeated
review. That historical description does not establish the exact current agent
topology or stopping algorithm. [Deep Research overview](https://gemini.google/overview/deep-research/).

**Gemini API:** the current preview provides a dedicated Deep Research agent and
a more extensive Max version through the Interactions API. Background execution
is required; clients can poll or stream. Collaborative plan review is optional.
The guide also documents MCP connections and document inputs. This is a separate
integration from an ordinary Gemini generation request; selecting Gemini as
Asael's answer model does not enable it. Preview lifecycle and storage requirements
need consideration before adoption. [Developer guide](https://ai.google.dev/gemini-api/docs/deep-research?hl=en).

**Claude Research:** current help describes successive searches, investigation
across different angles, citations, and access to connected Google context when
enabled. Research is offered on paid plans and consumes their existing allowance,
typically faster than ordinary chat. [Claude Research help](https://support.claude.com/en/articles/11088861-use-research-on-claude).

Anthropic's June 2025 engineering account describes a lead researcher that plans,
delegates independent questions to parallel subagents, combines their findings,
and investigates remaining gaps. A separate citation stage links findings to
sources. It discusses source judgment, clear subtask boundaries, recovery, and
effort scaled to complexity. Its reported quality gains and roughly 15-times-chat
token usage concern its historical internal workload; they are not current
comparisons with Asael. The present consumer product's exact internal configuration
is not fully public. [Published research architecture](https://www.anthropic.com/engineering/multi-agent-research-system).

Claude's developer web-search and fetch tools are separate building blocks. Fetch
can read HTML, text, and PDFs and does not render JavaScript; source-passage
citations require configuration. A developer must still implement the research
workflow. [Web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool),
[web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool).

Neither citation links nor the vendors' descriptions establish guaranteed factual
accuracy. Claude Cowork's documented background lifecycle belongs to a different
mode and should not be silently attributed to the Research toggle.

## What Asael actually does

| Stage | Current Asael behavior | Practical implication |
|---|---|---|
| Scope | Research uses the original question and authorized run context. There is no dedicated editable research-plan surface. | A broad brief may need decomposition into genuinely different questions. |
| Discovery | The initial pass generates three variants: the question, primary/background evidence, and limitations/independent checks. They run sequentially. | The investigation starts from a fixed pattern rather than a topic-specific evidence plan. |
| Further investigation | The ordinary bounded model loop can make additional permitted tool calls afterward. | Three initial searches is not a hard total-search limit. Follow-up work exists, but there is no dedicated durable gap queue. |
| Page selection | URLs are deduplicated and interleaved across searches, then selected round-robin by hostname, up to six initial reads. | Host diversity is not topic relevance, original-source quality, or publisher independence. |
| Reading | `web.read` accepts HTML and text, with a 1 MiB body limit, 15-second timeout, and 12,000-character extraction cap. It declines PDFs, access restrictions, and JavaScript-only shells. | Long documents and PDF-heavy research need other governed readers; a successful excerpt does not mean a whole document was read. |
| Evidence supplied to synthesis | Initial evidence fits a 48,000-character envelope; each included page contributes at most 8,000 characters, sometimes less. | Important passages late in a long page can be lost. Query-directed passage selection would help. |
| Report | Instructions request an executive summary, supported findings, comparison, implications, limitations, and references, normally around 1,200–2,000 words when warranted. | Report structure and depth now exist; evidence coverage remains the limiting factor. |
| Verification | Citation IDs are linked to known sources. Served grounding separately measures material-claim evidence coverage. | Valid citations must not be presented as proof that every material claim is supported. |
| Parallelism | The initial research pass is sequential, and the automatic sibling council is disabled in Research to preserve its evidence pack. | Generic multiagent infrastructure elsewhere in the app is not a specialized parallel Research system. |
| Lifecycle | Research defaults to the direct report runtime unless durable work is explicitly requested. Default run time is 240 seconds; initial collection caps at 110 seconds and protects synthesis time. Deployment/request overrides still apply. | There is no equivalent default, user-facing long-running Research job with pause, resume, and completion notification. |
| Models and tools | The writer uses normal model routing. Hosted web discovery currently requires the specialized OpenAI route. | Changing the writer to Claude or Gemini does not inherit those products' Research workflows. |

Code evidence: [research helpers](../../src/lib/orchestration/research.ts),
[agent runtime](../../src/lib/orchestration/agent-runner.ts),
[public page reader](../../src/lib/web-search/read.ts),
[search adapter](../../src/lib/web-search/search.ts),
[routing](../../src/lib/orchestration/supervisor.ts),
[budget defaults](../../src/lib/config.ts),
[claim grounding](../../src/lib/rag/citations.ts).

The latest baseline live verification completed five searches with zero search
failures, four successful reads and two failed reads, and a 1,158-word report with
eight valid citations across seven URLs. The failures were HTTP 404 and restricted
automated access. Coverage notes identified missing and truncated material;
grounding remained `missing`. This demonstrates functioning collection and
reporting, not full factual verification or equivalence to another product.

The repaired search adapter keeps a completed search when a subsequent page-open
attempt remains unfinished in the exact observed response shape. It discards
mixed answer prose and sources outside the completed search and records the read
limitation. That transport/adapter repair does not solve the planning and evidence
coverage gaps above.

## Recommended implementation order

1. **Plan and source relevance.** Build a compact research brief containing the
   actual subquestions, source constraints, dates, and required outputs. Let the
   user adjust it without requiring another approval for already-authorized
   public research. Rank sources against each question and original-source
   authority before spending read capacity. Exclude unrelated libraries or
   similarly named products from technical comparisons.
2. **Passage reading and evidence gaps.** Extract passages relevant to the
   question, preserve their locations, and support governed PDF reading. Maintain
   a coverage table: answered, partially supported, contradicted, or unresolved.
   Replace unavailable sources with appropriate alternatives within the original
   budget; never bypass publisher restrictions. Search again because a concrete
   gap remains, with a bounded stopping rule.
3. **Resumable Deep Research.** Add an explicit depth/budget choice and persist
   the plan, selected evidence, completed steps, and remaining allowance in the
   existing governed workflow system. Expose stage summaries, elapsed time,
   sources read, limitations, stop/resume, and completion notification. Parallelize
   only independent facets, with small fixed concurrency, per-child scope, and
   checkpoints; avoid duplicating an uncertain paid call after interruption.
4. **Report review and reuse.** Check important claims against cited passages,
   reconcile disagreements, and return partial status when required evidence is
   missing. Save a versioned report with a source appendix and optional document
   export through existing governed artifact tools. A report must never become
   verified merely because its references resolve.

For the CSM workflow, preserve distinct provenance for uploaded client material,
the owner's role context, public Salesforce guidance, and proposed next actions.
Research should explain what changed for a particular client, what is supported,
and what needs follow-up. Client scope must survive planning, delegation, retrieval,
and report storage; no Salesforce-org connection is required for that direction.

An optional Gemini Deep Research adapter is technically worth evaluating because
Google offers a dedicated agent API. It would require explicit provider support,
governed dispatch, background recovery, source/provenance mapping, usage accounting,
and validation of external-tool boundaries. Keep that separate from the current
navigation change. Claude's published architecture is useful design guidance;
the API tools reviewed here do not automatically reproduce its consumer workflow.

Before making comparative quality or cost claims, run an explicitly authorized
evaluation on the same bounded prompts, source conditions, and budgets. Measure
question coverage, claim support, source relevance, contradictions, useful actions,
latency, and actual billed usage. Automated evaluations remain deferred under the
owner's current instruction; this document proposes work, not completed features.
