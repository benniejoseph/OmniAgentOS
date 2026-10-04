import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { MEETING_RECORDING_READ_CONTRACT, MeetingRecordingNativeError, meetingRecordingIdSchema,
  meetingRecordingProcessRequestSchema, meetingRecordingScopeSchema, meetingRecordingShaSchema } from "@/lib/capture/meeting-recording-native-contracts";
import { readNativeMeetingRecording, reviewNativeMeetingRecording, submitNativeMeetingRecording } from "@/lib/capture/meeting-recording-native-store";
import { nativeMeetingRecordingSchemas, nativeMeetingRecordingProcessResponseForScopeSchema,
  nativeMeetingRecordingReadResponseForScopeSchema, nativeMeetingRecordingReviewResponseForScopeSchema } from "@/lib/mobile/meeting-recording-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { deriveExecutionScope } from "@/lib/security/execution-scope";

function authority(caller: AppServiceCaller, recordingId: string, input: unknown, mutation = false) {
  const selection = nativeMeetingRecordingSchemas.NativeMeetingRecordingQuery.parse(input);
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  const execution = caller.executionScope;
  if (!canonical || (mutation ? !execution || !caller.idempotencyKey ||
    execution.tenantId !== caller.context.tenantId || execution.initiatingActorId !== caller.context.actorId ||
    execution.executingPrincipalType !== "user" || execution.executingPrincipalId !== caller.context.actorId ||
    execution.workspaceId !== selection.workspaceId || execution.projectId || execution.missionId || execution.delegationId ||
    execution.contextGrantIds.length || execution.capabilityGrantIds.length || execution.purpose !== "api.meeting-recording.process" ||
    execution.causationId !== recordingId : execution !== undefined || caller.idempotencyKey !== undefined)) {
    throw new MeetingRecordingNativeError("meeting_recording_authority", 403, "Current authenticated recording authority is required.");
  }
  const scope = meetingRecordingScopeSchema.parse({ ...selection, recordingId: meetingRecordingIdSchema.parse(recordingId),
    tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId });
  return { scope, ...(mutation && execution ? { executionScope: deriveExecutionScope(execution, { purpose: "capture.recording.media.queue" }) } : {}) };
}
function expected(caller: AppServiceCaller, scope: ReturnType<typeof authority>["scope"]) {
  return { scope, requestActorId: caller.context.actorId, role: caller.context.role, executionScope: caller.executionScope };
}
export async function reviewMeetingRecordingService(caller: AppServiceCaller, recordingId: string, input: unknown) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.meetings.recordings.review"));
  const owner = authority(caller, recordingId, input), review = await reviewNativeMeetingRecording(owner);
  const result = completeAppServiceCall(authorized, { contract: MEETING_RECORDING_READ_CONTRACT, scope: owner.scope, review }, { resourceCount: 1 });
  nativeMeetingRecordingReviewResponseForScopeSchema(expected(caller, owner.scope)).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
export async function inspectMeetingRecordingProcessingService(caller: AppServiceCaller, recordingId: string, keySha256: string, input: unknown) {
  meetingRecordingShaSchema.parse(keySha256);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.meetings.recordings.processing.show"));
  const owner = authority(caller, recordingId, input), current = await readNativeMeetingRecording(owner, keySha256);
  const result = completeAppServiceCall(authorized, { contract: MEETING_RECORDING_READ_CONTRACT, scope: owner.scope, ...current }, { resourceCount: current.acceptance ? 1 : 0 });
  nativeMeetingRecordingReadResponseForScopeSchema({ ...expected(caller, owner.scope), keySha256 }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
export async function processMeetingRecordingService(caller: AppServiceCaller, recordingId: string, input: unknown) {
  const request = meetingRecordingProcessRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.meetings.recordings.process"));
  const owner = authority(caller, recordingId, { workspaceId: request.workspaceId, meetingId: request.meetingId }, true);
  const accepted = await submitNativeMeetingRecording({ authority: owner, request, idempotencyKey: caller.idempotencyKey! });
  const result = completeAppServiceCall(authorized, { contract: MEETING_RECORDING_READ_CONTRACT, scope: owner.scope, ...accepted }, { resourceCount: 1 });
  nativeMeetingRecordingProcessResponseForScopeSchema({ ...expected(caller, owner.scope), request, idempotencyKey: caller.idempotencyKey! })
    .parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
