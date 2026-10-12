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

const workPolicyBody = {
  schemaVersion: 1 as const, id: "responsibility-work-item-comparison:1", maximumSourceAgeSeconds: 3_600,
  firstObservation: "establish_baseline_without_notification", advancement: "complete_current_authorized_evidence_only",
  uncertainComparison: "insufficient_evidence",
  adapterCoverage: "One canonical owned work item and same-project dependencies readable by its owner. Local source freshness is checked at read time; source modification time is separate.",
  materialExamples: ["Status or priority changes.", "A deadline changes or an unfinished item becomes overdue.", "Owners, authorized dependency states, or linked output references change."],
  cosmeticExamples: ["An unchanged item is read again.", "A source revision or display text changes without changing monitored fields."],
  unsupportedExamples: ["Done or a linked artifact proves independently verified success.", "An unreadable dependency exposes another owner's work."],
};
export const RESPONSIBILITY_WORK_ITEM_COMPARISON_POLICY = Object.freeze({ ...workPolicyBody, policySha256: canonicalJsonSha256(workPolicyBody) });
export function responsibilityComparisonPolicy(sources: readonly { kind: string }[]) {
  return sources.length === 1 && sources[0].kind === "work_item" ? RESPONSIBILITY_WORK_ITEM_COMPARISON_POLICY : RESPONSIBILITY_MEETING_COMPARISON_POLICY;
}
const workItemProjectionSchema = z.object({
  key: z.string().min(1).max(240), canonicalStatus: z.string().min(1).max(160), sourceStatus: z.string().min(1).max(160),
  dueAt: z.string().datetime().nullable(), overdue: z.boolean(), priority: z.string().min(1).max(160),
  ownerActorIds: z.array(z.string().min(1).max(320)).max(128), dependencies: z.array(z.string().max(2_000)).max(256),
  outputReferences: z.array(z.string().max(8_000)).max(256), evidenceIds: z.array(z.string().min(1).max(240)).min(1).max(256),
}).strict();
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
  workItem: workItemProjectionSchema.optional(),
  facts: z.array(fact).max(250), commitments: z.array(fact).max(250),
  // Authoritative text may establish a provenance baseline, but a later
  // substantive text change is uncertainty rather than an invented fact.
  uninterpretedText: z.array(fact.extend({ value: z.string().max(8_000) })).max(1_000).default([]),
}).strict().superRefine((value, context) => {
  if (value.meeting && Date.parse(value.meeting.endsAt) < Date.parse(value.meeting.startsAt)) context.addIssue({ code: "custom", message: "Meeting end precedes its start." });
});
export type ComparisonProjection = z.infer<typeof comparisonProjectionSchema>;
export const comparisonCategorySchema = z.enum(["meeting_time", "meeting_state", "agenda", "participants", "facts", "commitments", "work_status", "work_deadline", "work_overdue", "work_priority", "work_owners", "work_dependencies", "work_outputs"]);
export type ComparisonCategory = z.infer<typeof comparisonCategorySchema>;
export const semanticDigestsSchema = z.object({
  meeting_time: z.string().regex(/^[a-f0-9]{64}$/), meeting_state: z.string().regex(/^[a-f0-9]{64}$/),
  agenda: z.string().regex(/^[a-f0-9]{64}$/), participants: z.string().regex(/^[a-f0-9]{64}$/),
  facts: z.string().regex(/^[a-f0-9]{64}$/), commitments: z.string().regex(/^[a-f0-9]{64}$/),
  uninterpretedText: z.string().regex(/^[a-f0-9]{64}$/),
  work_status: z.string().regex(/^[a-f0-9]{64}$/).optional(), work_deadline: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  work_overdue: z.string().regex(/^[a-f0-9]{64}$/).optional(), work_priority: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  work_owners: z.string().regex(/^[a-f0-9]{64}$/).optional(), work_dependencies: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  work_outputs: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  const work = parsed.flatMap((value) => value.workItem ? [value.workItem] : []);
  assertConsistent(work.map((item) => [item.key, canonicalJsonSha256(item)]));
  const fields = {
    ...(work.length ? {
      work_status: setDigest(work.map((item) => [item.key, item.canonicalStatus, item.sourceStatus])),
      work_deadline: setDigest(work.map((item) => [item.key, item.dueAt])),
      work_overdue: setDigest(work.map((item) => [item.key, item.overdue])),
      work_priority: setDigest(work.map((item) => [item.key, item.priority])),
      work_owners: setDigest(work.flatMap((item) => item.ownerActorIds.map((owner) => [item.key, owner]))),
      work_dependencies: setDigest(work.flatMap((item) => item.dependencies.map((dependency) => [item.key, dependency]))),
      work_outputs: setDigest(work.flatMap((item) => item.outputReferences.map((output) => [item.key, output]))),
    } : {}),
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
