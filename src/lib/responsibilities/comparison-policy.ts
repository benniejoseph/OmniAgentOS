import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

/** Closed, reviewable rules. Altering a rule creates a new policy identity. */
const policyBody = {
  schemaVersion: 1 as const, id: "responsibility-meeting-comparison:1",
  maximumSourceAgeSeconds: 3_600,
  firstObservation: "establish_baseline_without_notification",
  advancement: "complete_current_authorized_evidence_only",
  uncertainComparison: "insufficient_evidence",
  adapterCoverage: "Native owner-private Meeting metadata only. No agenda extraction from title/summary; linked sources, shared meetings and free-form thread/capture interpretation are unsupported.",
  materialExamples: [
    "A meeting start/end instant or cancellation changes.",
    "A normalized agenda item is added, removed, or changed.",
    "A participant identity joins or leaves the meeting.",
    "A cited structured commitment or relevant fact changes.",
  ],
  cosmeticExamples: [
    "Whitespace, line endings, Unicode canonical composition, or supported display markup changes.",
    "Equivalent agenda items, participants, commitments, or facts are reordered or duplicated.",
    "A fetch timestamp, source revision, citation identity, or display label changes without changing the compared values.",
  ],
  unsupportedExamples: [
    "A source is missing, stale, denied, or only partially retrieved.",
    "Changed title/summary or other uninterpreted prose requires semantic interpretation beyond these deterministic fields.",
    "An Agent response or a caller-authored JSON value has no authoritative stored evidence.",
  ],
};
export const RESPONSIBILITY_MEETING_COMPARISON_POLICY = Object.freeze({ ...policyBody,
  materialExamples: Object.freeze(policyBody.materialExamples), cosmeticExamples: Object.freeze(policyBody.cosmeticExamples),
  unsupportedExamples: Object.freeze(policyBody.unsupportedExamples), policySha256: canonicalJsonSha256(policyBody) });

const text = z.string().max(2_000);
const fact = z.object({ key: z.string().min(1).max(240), value: z.union([text, z.number().finite(), z.boolean(), z.null()]), evidenceIds: z.array(z.string().min(1).max(240)).min(1).max(16) }).strict();
export const comparisonProjectionSchema = z.object({
  // The adapter declares unsupported free-form comparisons as unresolved.
  comparisonState: z.enum(["deterministic", "unresolved"]),
  meeting: z.object({
    key: z.string().min(1).max(240),
    status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]),
    startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }),
    agenda: z.array(text).max(100), participantKeys: z.array(z.string().min(1).max(240)).max(250),
    evidenceIds: z.array(z.string().min(1).max(240)).min(1).max(16),
  }).strict().nullable(),
  facts: z.array(fact).max(250), commitments: z.array(fact).max(250),
  // Authoritative text may establish a provenance baseline, but a later
  // substantive text change is uncertainty rather than an invented fact.
  uninterpretedText: z.array(fact.extend({ value: z.string().max(8_000) })).max(1_000).default([]),
}).strict().superRefine((value, context) => {
  if (value.meeting && Date.parse(value.meeting.endsAt) < Date.parse(value.meeting.startsAt)) context.addIssue({ code: "custom", message: "Meeting end precedes its start." });
});
export type ComparisonProjection = z.infer<typeof comparisonProjectionSchema>;
export const comparisonCategorySchema = z.enum(["meeting_time", "meeting_state", "agenda", "participants", "facts", "commitments"]);
export type ComparisonCategory = z.infer<typeof comparisonCategorySchema>;
export const semanticDigestsSchema = z.object({
  meeting_time: z.string().regex(/^[a-f0-9]{64}$/), meeting_state: z.string().regex(/^[a-f0-9]{64}$/),
  agenda: z.string().regex(/^[a-f0-9]{64}$/), participants: z.string().regex(/^[a-f0-9]{64}$/),
  facts: z.string().regex(/^[a-f0-9]{64}$/), commitments: z.string().regex(/^[a-f0-9]{64}$/),
  uninterpretedText: z.string().regex(/^[a-f0-9]{64}$/),
  semanticSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SemanticDigests = z.infer<typeof semanticDigestsSchema>;

/** Conservative display normalization, not language understanding or case folding. */
export function normalizeComparisonText(value: string) {
  return value.normalize("NFC").replace(/\r\n?/g, "\n")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1")
    .replace(/\s+/g, " ").trim();
}
export function comparisonDigests(projections: readonly ComparisonProjection[]): SemanticDigests {
  const parsed = projections.map((value) => comparisonProjectionSchema.parse(value));
  if (parsed.some((value) => value.comparisonState !== "deterministic")) throw new Error("Comparison requires authoritative deterministic fields.");
  const meetings = parsed.flatMap((value) => value.meeting ? [value.meeting] : []);
  assertConsistent(meetings.map((meeting) => [meeting.key, canonicalJsonSha256({
    status: meeting.status, startsAt: new Date(meeting.startsAt).toISOString(), endsAt: new Date(meeting.endsAt).toISOString(),
    agenda: setDigest(meeting.agenda.map(normalizeComparisonText)), participants: setDigest(meeting.participantKeys),
  })]));
  assertConsistent(parsed.flatMap((value) => value.facts.map((item) => [item.key, canonicalJsonSha256(normalizedFact(item)[1])])));
  assertConsistent(parsed.flatMap((value) => value.commitments.map((item) => [item.key, canonicalJsonSha256(normalizedFact(item)[1])])));
  assertConsistent(parsed.flatMap((value) => value.uninterpretedText.map((item) => [item.key, canonicalJsonSha256(normalizedFact(item)[1])])));
  const fields = {
    meeting_time: setDigest(meetings.map((meeting) => [meeting.key, new Date(meeting.startsAt).toISOString(), new Date(meeting.endsAt).toISOString()])),
    meeting_state: setDigest(meetings.map((meeting) => [meeting.key, meeting.status])),
    agenda: setDigest(meetings.flatMap((meeting) => meeting.agenda.map(normalizeComparisonText).filter(Boolean).map((item) => [meeting.key, item]))),
    participants: setDigest(meetings.flatMap((meeting) => meeting.participantKeys.map((key) => [meeting.key, key]))),
    facts: setDigest(parsed.flatMap((value) => value.facts.map(normalizedFact))),
    commitments: setDigest(parsed.flatMap((value) => value.commitments.map(normalizedFact))),
    uninterpretedText: setDigest(parsed.flatMap((value) => value.uninterpretedText.map(normalizedFact))),
  };
  return { ...fields, semanticSha256: canonicalJsonSha256(fields) };
}
export function changedComparisonCategories(before: SemanticDigests, after: SemanticDigests): ComparisonCategory[] {
  return comparisonCategorySchema.options.filter((category) => before[category] !== after[category]);
}
function normalizedFact(value: ComparisonProjection["facts"][number]) { return [value.key, typeof value.value === "string" ? normalizeComparisonText(value.value) : value.value]; }
function setDigest(values: readonly unknown[]) { return canonicalJsonSha256([...new Set(values.map((value) => canonicalJsonSha256(value)))].sort()); }
function assertConsistent(values: string[][]) {
  const seen = new Map<string, string>();
  for (const [key, value] of values) {
    if (seen.has(key) && seen.get(key) !== value) throw new Error("Authoritative evidence contains conflicting values.");
    seen.set(key, value);
  }
}
