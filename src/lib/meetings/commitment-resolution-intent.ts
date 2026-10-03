import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const id = z.string().trim().min(1).max(240);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });
const communication = z.object({
  connectionId: z.string().uuid().nullable(),
  policyId: z.string().regex(/^contact_policy:[0-9a-f-]{36}$/),
  recipientParticipantId: id,
  subject: z.string().trim().min(1).max(998).refine((value) => !/[\r\n]/.test(value)),
  body: z.string().trim().min(1).max(50_000),
}).strict();
export const meetingResolutionDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("dismissed") }).strict(),
  z.object({
    decision: z.literal("confirmed"), ownerParticipantId: id,
    dueAt: time.nullable(), communication: communication.nullable(),
  }).strict(),
]);
const intentBody = z.object({
  schemaVersion: z.literal(1), contract: z.literal("meeting-commitment-resolution-intent:1"),
  tenantId: id, workspaceId: id, meetingId: id,
  proposalId: z.string().regex(/^meeting-commitment-proposal:[a-f0-9]{64}$/),
  proposalSha256: sha, ownerActorId: id,
  request: meetingResolutionDecisionSchema,
}).strict();
export const meetingResolutionIntentSchema = intentBody.extend({
  requestSha256: sha, createdAt: time,
}).strict().superRefine((value, context) => {
  const { requestSha256, createdAt, ...body } = value;
  void createdAt;
  if (canonicalJsonSha256(body) !== requestSha256) context.addIssue({ code: "custom", message: "Resolution request digest is inconsistent." });
});
export function meetingResolutionIntentBody(input: Omit<z.input<typeof intentBody>, "schemaVersion" | "contract">) {
  const body = intentBody.parse({ schemaVersion: 1, contract: "meeting-commitment-resolution-intent:1", ...input });
  return { ...body, requestSha256: canonicalJsonSha256(body) };
}
export const MEETING_RESOLUTION_PHASES = [
  "work_started", "work_completed", "draft_started", "draft_completed",
  "meeting_started", "meeting_completed", "resolution_started", "interrupted",
] as const;
export const meetingResolutionPhaseSchema = z.object({
  phase: z.enum(MEETING_RESOLUTION_PHASES), at: time,
  resourceId: id.nullable(), evidenceSha256: sha.nullable(),
}).strict().superRefine((value, context) => {
  const completed = value.phase.endsWith("_completed");
  if (completed !== (value.resourceId !== null && value.evidenceSha256 !== null) ||
    !completed && (value.resourceId !== null || value.evidenceSha256 !== null)) {
    context.addIssue({ code: "custom", message: "Only completed phases contain an exact effect receipt." });
  }
});
export const meetingResolutionReconciliationSchema = z.object({
  schemaVersion: z.literal(1), requestSha256: sha,
  decision: z.enum(["confirmed", "dismissed"]),
  state: z.enum(["pending", "partial", "uncertain", "resolved"]),
  automaticRetryAllowed: z.literal(false), createdAt: time,
  phases: z.array(meetingResolutionPhaseSchema).max(8),
}).strict().superRefine((value, context) => {
  if (new Set(value.phases.map((phase) => phase.phase)).size !== value.phases.length) context.addIssue({ code: "custom", message: "Duplicate resolution phases are invalid." });
  const names = value.phases.map((phase) => phase.phase);
  const plans: string[][] = value.decision === "dismissed" ? [["resolution_started"]] : [
    ["work_started", "work_completed", "meeting_started", "meeting_completed", "resolution_started"],
    ["work_started", "work_completed", "draft_started", "draft_completed", "meeting_started", "meeting_completed", "resolution_started"],
  ];
  const sequence = names.at(-1) === "interrupted" ? names.slice(0, -1) : names;
  if (!plans.some((plan) => sequence.every((phase, index) => plan[index] === phase))) context.addIssue({ code: "custom", message: "Phase history is outside the bounded decision sequence." });
  if (value.state === "resolved" ? names.at(-1) !== "resolution_started" : value.state !== unresolvedState(value.phases)) context.addIssue({ code: "custom", message: "Reconciliation state differs from its phase evidence." });
});
export type MeetingResolutionIntent = z.infer<typeof meetingResolutionIntentSchema>;
export type MeetingResolutionDecision = z.infer<typeof meetingResolutionDecisionSchema>;
export type MeetingResolutionPhase = z.infer<typeof meetingResolutionPhaseSchema>;
export type MeetingResolutionReconciliation = z.infer<typeof meetingResolutionReconciliationSchema>;

function unresolvedState(phases: readonly MeetingResolutionPhase[]) {
  const names = new Set(phases.map((phase) => phase.phase));
  const unconfirmed = phases.some((phase) => phase.phase.endsWith("_started") &&
    !names.has(phase.phase.replace("_started", "_completed") as MeetingResolutionPhase["phase"]));
  return names.has("interrupted") || unconfirmed
    ? "uncertain" : phases.some((phase) => phase.phase.endsWith("_completed")) ? "partial" : "pending";
}
export function meetingResolutionReconciliation(intent: MeetingResolutionIntent, phases: readonly MeetingResolutionPhase[], resolved: boolean) {
  const state = resolved ? "resolved" : unresolvedState(phases);
  return meetingResolutionReconciliationSchema.parse({
    schemaVersion: 1, requestSha256: intent.requestSha256, decision: intent.request.decision,
    state, automaticRetryAllowed: false, createdAt: intent.createdAt, phases,
  });
}

export function assertMeetingResolutionPhaseOrder(intent: MeetingResolutionIntent, previous: readonly MeetingResolutionPhase[], phase: MeetingResolutionPhase["phase"]) {
  const names = previous.map((item) => item.phase);
  if (names.includes("interrupted")) throw new Error("Interrupted resolution requires reconciliation; children cannot resume automatically.");
  if (phase === "interrupted") return;
  const plan: MeetingResolutionPhase["phase"][] = intent.request.decision === "dismissed"
    ? ["resolution_started"]
    : ["work_started", "work_completed", ...(intent.request.communication ? ["draft_started", "draft_completed"] as const : []), "meeting_started", "meeting_completed", "resolution_started"];
  if (plan[names.length] !== phase || names.some((name, index) => plan[index] !== name)) throw new Error("Resolution phases must follow the exact claimed decision.");
}
