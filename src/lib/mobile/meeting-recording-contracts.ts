import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { MEETING_RECORDING_READ_CONTRACT, meetingRecordingAcceptanceSchema, meetingRecordingMeetingIdSchema, meetingRecordingProcessRequestSchema,
  meetingRecordingProcessingSchema, meetingRecordingReviewSchema, meetingRecordingScopeSchema, meetingRecordingWorkspaceIdSchema,
  buildMeetingRecordingIntent, type MeetingRecordingScope, type MeetingRecordingRequest } from "@/lib/capture/meeting-recording-native-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const base = { contract: z.literal(MEETING_RECORDING_READ_CONTRACT), scope: meetingRecordingScopeSchema };
const same = (a: unknown, b: unknown) => canonicalJsonSha256(a) === canonicalJsonSha256(b);
function issue(context: z.RefinementCtx, message: string) { context.addIssue({ code: "custom", message }); }
function receipt(value: { scope: MeetingRecordingScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx,
  operation: string, mutation: boolean, count: number) {
  const { serviceReceipt: proof, ...body } = value;
  if (proof.operation !== operation || proof.resourceType !== "capture_recording" || proof.action !== (mutation ? "write.memory" : "read") ||
    proof.accessMode !== (mutation ? "mutation" : "read") || proof.resourceCount !== count ||
    proof.eventContract !== (mutation ? "meeting-recording-processing-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body)) issue(context, "Service receipt does not bind the exact native recording result.");
}
export const nativeMeetingRecordingReviewResponseSchema = z.object({ ...base, review: meetingRecordingReviewSchema, serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((value, context) => receipt(value, context, "app.meetings.recordings.review", false, 1));
const result = { ...base, acceptance: meetingRecordingAcceptanceSchema.nullable(), processing: meetingRecordingProcessingSchema.nullable(), serviceReceipt: appServiceReceiptSchema };
function accepted(value: z.infer<z.ZodObject<typeof result>>, context: z.RefinementCtx) {
  if (value.acceptance && !same(value.scope, value.acceptance.scope) || Boolean(value.acceptance) !== Boolean(value.processing) ||
    value.processing?.media && !value.processing.media.mediaRevisionId.startsWith(`${value.scope.recordingId}:media:v`)) issue(context, "Accepted recording scope and current observation do not match.");
}
export const nativeMeetingRecordingReadResponseSchema = z.object(result).strict().superRefine((value, context) => {
  receipt(value, context, "app.meetings.recordings.processing.show", false, value.acceptance ? 1 : 0); accepted(value, context);
});
export const nativeMeetingRecordingProcessResponseSchema = z.object({ ...result, acceptance: meetingRecordingAcceptanceSchema,
  processing: meetingRecordingProcessingSchema, replayed: z.boolean() }).strict().superRefine((value, context) => {
  receipt(value, context, "app.meetings.recordings.process", true, 1); accepted(value, context);
  if (value.serviceReceipt.idempotencyKeySha256 !== value.acceptance.keySha256) issue(context, "Queue receipt names another accepted key.");
});
type Authority = { scope: MeetingRecordingScope; requestActorId: string; role: string; executionScope?: ExecutionScope };
function authority(value: { scope: MeetingRecordingScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, expected: Authority, context: z.RefinementCtx) {
  if (!same(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: expected.scope.tenantId, actorId: expected.requestActorId, role: expected.role, executionScope: expected.executionScope ?? null })) issue(context, "Recording response belongs to another authenticated authority.");
}
export function nativeMeetingRecordingReviewResponseForScopeSchema(expected: Authority) {
  return nativeMeetingRecordingReviewResponseSchema.superRefine((value, context) => authority(value, expected, context));
}
export function nativeMeetingRecordingReadResponseForScopeSchema(expected: Authority & { keySha256: string }) {
  return nativeMeetingRecordingReadResponseSchema.superRefine((value, context) => { authority(value, expected, context);
    if (value.acceptance && value.acceptance.keySha256 !== expected.keySha256) issue(context, "Recovery returned another exact accepted key."); });
}
export function nativeMeetingRecordingProcessResponseForScopeSchema(expected: Authority & { idempotencyKey: string; request: MeetingRecordingRequest }) {
  const intent = buildMeetingRecordingIntent(expected);
  return nativeMeetingRecordingProcessResponseSchema.superRefine((value, context) => { authority(value, expected, context);
    if (value.acceptance.requestSha256 !== canonicalJsonSha256(intent) || value.acceptance.keySha256 !== intent.keySha256 ||
      value.acceptance.reviewSha256 !== intent.request.review.reviewSha256 || value.acceptance.sourceAudioManifestSha256 !== intent.request.review.sourceAudioManifestSha256 ||
      value.acceptance.acceptedMediaGeneration !== intent.request.review.mediaGeneration + 1) issue(context, "Acceptance differs from the frozen processing request."); });
}
export const nativeMeetingRecordingSchemas = Object.freeze({
  NativeMeetingRecordingQuery: z.object({ workspaceId: meetingRecordingWorkspaceIdSchema, meetingId: meetingRecordingMeetingIdSchema }).strict(),
  NativeMeetingRecordingProcessRequest: meetingRecordingProcessRequestSchema, NativeMeetingRecordingReviewResponse: nativeMeetingRecordingReviewResponseSchema,
  NativeMeetingRecordingProcessResponse: nativeMeetingRecordingProcessResponseSchema, NativeMeetingRecordingReadResponse: nativeMeetingRecordingReadResponseSchema,
  NativeMeetingRecordingError: z.object({ error: z.string().min(1).max(4_000), code: z.string().min(1).max(200).optional(), message: z.string().max(4_000).optional() }).strict(),
});
