# ClaimEvidenceMap v1

**Status:** Active P1.5 serving contract

**Runtime effect:** Every completed agent answer is decomposed and checked

`ClaimEvidenceMapV1` binds each served answer to exact claims, authorized
canonical evidence, and honest support states. The complete private map is
stored inside the run's existing grounding projection. `run.done` carries only
a typed metadata summary, and the public run/stream projection exposes claim
spans, state, coverage, and opaque evidence-unit IDs without actor,
authorization, or source-binding internals.

The runtime deterministically segments prose, excluding Markdown headings and
fenced code. It resolves only tenant-scoped knowledge chunks with an exact
immutable `EvidenceUnitV1`, verifies the chunk content hash and byte length,
then applies the owner-and-scope authorization policy before claim text is
compared with evidence content. Strong runtime support currently requires a
normalized exact claim span in authorized evidence. A citation ID, model
assertion, memory/graph result, web result, or legacy chunk cannot establish
support. Such sources remain visible for compatibility while the associated
claim stays unsupported.

## Contract boundary

The map binds:

- one exact answer hash and UTF-16 length;
- non-empty claim spans, each re-hashed from the exact answer text by the
  verifier;
- canonical `EvidenceUnitV1` metadata snapshots, source revision coordinates,
  locators, permissions/purpose hashes, provenance, and retention boundary;
- one externally resolved authorization decision for every evidence unit,
  bound to the exact run, canonical purpose, execution scope, policy, evidence
  snapshot, and half-open validity window;
- semantic-assessment receipts bound to their exact claim, evidence snapshots,
  authorization decisions, common tenant/run/purpose/scope/policy, verifier
  identity/version, method, confidence, validity, lifecycle, and inference
  parents; and
- deterministic claim states, evidence-role lists, and declared-claim-set
  coverage.

Raw answer text, claim text, evidence content, arbitrary metadata, credentials,
private reasoning, and authorization narratives are not retained. Opaque IDs
and digests are coordinates, not instructions or authority.

## Time and authorization

`asOfTime` is the time the claim describes. `evaluatedAt` is when the map was
computed, and `recordedAt` is when it was recorded. V1 requires
`asOfTime <= evaluatedAt <= recordedAt`. Historical claims may therefore be
assessed later without being made artificially stale by recording time.

Authorization must be active both when evidence is semantically assessed and
when the map is evaluated. Evidence must already be captured and extracted at
those operations. A retention expiry is a privacy boundary, not a semantic
staleness signal: expired evidence is rejected even for a historical as-of
question. Semantic validity and authorization use half-open intervals, so the
opening instant is included and the closing instant is excluded.

Execution-scope context and capability grant IDs are canonicalized as sets.
They remain attribution and request binding only. A trusted authorization
resolver must separately decide whether the actor, purpose, scope, policy, and
evidence are permitted.

## Deterministic support states

Only `human_review`, `deterministic_entailment`,
`semantic_entailment_verifier`, and `verified_effect_postcondition` are strong
methods in v1, and support or contradiction requires non-zero confidence.
Citation-ID matching, model assertion, generated summaries, `none`, and
`unassessed` can be retained as considered evidence but cannot establish
support.

The state order is:

1. a current strong contradiction makes the claim `disputed`;
2. otherwise, current strong direct support makes it `supported`;
3. otherwise, current strong inference over a bounded acyclic graph whose
   parents are supported or inferred makes it `inferred`;
4. otherwise, expired or superseded strong support, including an inference
   with a stale admissible parent, makes it `stale`; and
5. everything else is `unsupported`.

The inference graph has bounded parents and maximum ancestry depth. Claim
results separate considered evidence from the evidence named by current or
stale support and contradiction assertions. The field names identify these as
assertion evidence rather than the final claim state, so conflicting assertions
remain visible without implying that an unsupported or disputed claim passed.

Coverage counts only declared material claims in the map and counts only
`supported` claims in its numerator. Zero material claims produce
`not_applicable` and a null percentage. This does not prove that decomposition
found every material claim in the answer.

## What structural verification does not prove

A successful structural receipt verifies canonical shape, hashes, exact
run/purpose/answer/scope bindings, receipt associations and windows, graph
structure, deterministic state/coverage derivation, and the explicit subject
and verifier execution scopes. It explicitly does not prove:

- semantic entailment or factual truth;
- trust in the evidence source, extractor, authorization authority, resolver,
  verifier, policy, or its current key/configuration;
- source-head currentness or independence between sources;
- completeness or materiality quality of claim decomposition.

Runtime adoption is additive: old grounding remains readable, but serving no
longer upgrades an answer merely because its citation markers resolve. Full
legacy or non-canonical evidence enrollment is not inferred or backfilled;
those claims remain explicitly unsupported until canonical evidence carrying
the answer-verification purpose is available.
