# Asael memory architecture compared with Cognee

Date: 2026-09-10

The original request said “Congee.” No relevant agent-memory architecture is
published under that name; this comparison uses **Cognee**, the graph/vector
agent-memory project. Cognee's current v1.0 surface is `remember`, `recall`,
`improve`, and `forget`; `cognify` remains a lower-level legacy building block.

## Decision

Asael should not replace its memory system with Cognee or run Cognee as a second source of truth. Asael already has stronger ownership, evidence, review, temporal-claim, event, and deletion guarantees for this product's private-data model. The useful idea to adopt is Cognee's explicit semantic-processing stage: turn source material into structured proposals, then improve and evaluate those proposals over time.

In Asael this stage is called **cognification**. It is an asynchronous, actor-owned, evidence-bound proposal pipeline. Model output remains untrusted and does not enter active recall or either knowledge graph until the user confirms it.

## What exists today

| Capability | Asael today | Cognee pattern | Decision |
| --- | --- | --- | --- |
| Raw source truth | Canonical source items, immutable revisions, evidence units, text spans, hashes, retention and purpose bindings | Datasets and DataPoints linked across stores | Keep Asael |
| Storage | PostgreSQL, pgvector, memory records, typed entity/claim tables, append-only events | Relational provenance, vector similarity and graph stores connected by DataPoint identity | Keep Asael as the only authority; avoid synchronizing a second truth system |
| Retrieval | Hybrid knowledge, memory, heuristic graph and typed relation-path retrieval with authorization and lineage-aware packing | Multiple configurable search modes over graph/vector data | Keep Asael; add evaluated retrieval modes later |
| Semantic source understanding | Raw documents are searchable, but ordinary prose rarely produces useful typed concepts or relations | Permanent `remember` runs ingestion, graph building and enrichment; lower-level `cognify` pipelines remain available | Adopt the processing pattern as review-only cognification |
| Memory formation | Explicit user assertions, verified tool effects, inactive assistant candidates, governed tiers | `remember` and pipeline tasks ingest and transform data | Keep Asael's formation rules |
| Session memory | Governed run history, summaries and durable memory are separate; persistence requires an allowed formation path | Session `remember` returns quickly and can bridge to permanent graph memory through background `improve` | Keep the separation; do not silently bridge a conversation into durable truth |
| Agent integration | The main agent retrieves scoped context through Asael's compiler and every durable write follows governed application contracts | Agent-memory decorator recalls before an agent runs and records its output into session-backed trace memory | Borrow the ergonomic retrieval hook later, not automatic truth promotion |
| Truth governance | Candidate review, bitemporal claims, typed ontology, correction history | Fact validity and provenance support | Keep Asael's stricter gate |
| Improvement | Exact duplicate lifecycle, decay, archival, feedback and reviewed promotion | `improve` and evaluation operations | Add semantic evaluation and steward recommendations later |
| Forgetting | Governed deletion previews, lineage propagation and receipts | Dataset/system delete operations | Keep Asael |
| Multi-user safety | Tenant plus canonical actor scope, RLS and purpose-limited evidence | Permissions and multi-user mode | Keep Asael |

## Gaps found by the comparison

1. Ordinary documents and transcripts become searchable chunks, but not a practical typed concept, procedure, entity and relationship map.
2. Raw chunks are duplicated into semantic memory and the heuristic graph, creating noise instead of useful abstractions.
3. Assistant candidates are coarse response-sized blocks rather than atomic evidence-backed claims.
4. Exact-match lifecycle maintenance cannot group paraphrases, semantic duplicates or conflicting dated claims.
5. Conversation summaries preserve lineage but mostly truncate and concatenate text rather than semantically compress it.
6. Mnemosyne reports deterministic health heuristics; it is not yet an adaptive memory steward.
7. The strict private retrieval switch also suppressed canonical actor-owned knowledge, not just unsafe legacy data. This slice now keeps verified actor-owned canonical knowledge while still excluding unattributed legacy rows.

## Adopted cognification contract

The first implemented slice follows these rules:

1. A durable `knowledge.cognify` job processes a bounded batch from one immutable source revision.
2. The model is resolved from Settings under the `memory` assignment and must support structured JSON. No provider or model name is hard-coded.
3. The output is limited to atomic summaries, topics, claims, procedures, entities and ontology-valid relationships.
4. Every proposed item must quote exact canonical evidence. The server independently resolves UTF-16 offsets and verifies quote hashes.
5. A proposal is stored in an actor-RLS review queue. Raw model output is not retained as canonical truth.
6. Pending and dismissed proposals are excluded from recall and all graph projections.
7. Confirmation creates one private reviewed memory with knowledge, evidence and review lineage. Only that reviewed memory may feed explicit entity and inferred-relation projection.
8. Reprocessing is idempotent for the immutable source plan: document, source revision, retention boundary, batch input and extractor contract. Each persisted generation freezes its resolved Settings-backed model attribution; changing the model does not silently rewrite an existing review generation.
9. Missing model configuration or a superseded source revision is visible and safe; it must not corrupt or block the source index.

## What is deliberately rejected

- A second graph/vector/relational truth backend.
- Direct model writes into canonical facts or temporal relationships.
- Automatic promotion based only on confidence scores.
- Proposals without exact evidence spans and source-revision identity.
- Cross-actor review, retrieval or background processing.
- Silent source-purpose broadening for older records.
- Calling deterministic maintenance an autonomous agent when it is not one.

## Delivery order

### Implemented in this slice

- Cognification source purpose and exact evidence contract.
- Configurable memory-model runtime with bounded batches.
- Durable actor-owned cognition records and review decisions.
- Background job integration and progress visibility.
- Human confirmation/dismissal API and reviewed memory projection.
- Memory UI review queue and backfill control.
- Separation of safe canonical knowledge retrieval from legacy unscoped memory.
- Fail-closed current-revision, owner, purpose, retention and evidence checks before model access.
- Earliest source/evidence retention inheritance for proposals and reviewed memories, with bounded PostgreSQL expiry purging. Bounded-local fallback hides expired records and deletes them with their source; physical TTL purging remains hardening work.
- Source deletion/supersession cleanup for proposals and their reviewed memory lineage.

### Next hardening slice

- Stop duplicating raw source chunks into semantic memory for newly cognified revisions.
- Add semantic duplicate and contradiction groups, still review-gated.
- Measure extraction support rate, review acceptance, retrieval usefulness and graph lag.
- Add explicit cognition-generation identity for intentional model/contract reprocessing and physical TTL purging for bounded-local storage.

### Later learning slice

- Evidence-linked hierarchical conversation summaries.
- Outcome-weighted retrieval tuning behind offline evaluation gates.
- Mnemosyne as a deterministic controller that detects gaps and proposes jobs, never silently rewrites truth.
- Domain-specific ontology extensions for ICT/trading only after the general memory pipeline is reliable.

## External references

- [Cognee architecture](https://docs.cognee.ai/core-concepts/architecture)
- [Cognee v1.0 core concepts](https://docs.cognee.ai/core-concepts/overview)
- [Cognee remember operation](https://docs.cognee.ai/core-concepts/main-operations/remember)
- [Cognee agent-memory decorator](https://docs.cognee.ai/core-concepts/further-concepts/agent-memory-decorator)
- [Cognee data flows](https://docs.cognee.ai/core-concepts/data-flows)
- [Cognee pipelines](https://docs.cognee.ai/core-concepts/building-blocks/pipelines)
- [Cognee cognify operation](https://docs.cognee.ai/core-concepts/main-operations/legacy-operations/cognify)
- [Cognee DataPoints](https://docs.cognee.ai/core-concepts/building-blocks/datapoints)
- [Cognee provenance](https://docs.cognee.ai/guides/memory-provenance)
- [Cognee fact validity](https://docs.cognee.ai/guides/fact-validity)
- [Cognee improve operation](https://docs.cognee.ai/core-concepts/main-operations/improve)
- [Cognee forget operation](https://docs.cognee.ai/core-concepts/main-operations/forget)
- [Cognee security](https://docs.cognee.ai/setup-configuration/security)
- [Cognee v1.5.4 release](https://github.com/topoteretes/cognee/releases/tag/v1.5.4)
