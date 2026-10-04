import { describe, expect, it } from "vitest";
import { authorizeAppServiceCall, completeAppServiceCall } from "@/lib/app-services/contracts";
import { nativeMeetingRecordingProcessResponseForScopeSchema, nativeMeetingRecordingReadResponseForScopeSchema } from "@/lib/mobile/meeting-recording-contracts";
import { recordingCaller, recordingContext, recordingFixture, recordingRequest, recordingScope, recordingKey } from "@/lib/capture/meeting-recording-native.test-fixtures";
describe("native recording public receipt binding", () => {
  it("binds owner, original request, key namespace and service authority", () => {
    const fixture = recordingFixture(), caller = recordingCaller();
    const data = { contract: "asael-meeting-recording-read:1" as const, scope: recordingScope, acceptance: fixture.acceptance, processing: fixture.processing, replayed: false };
    const completed = completeAppServiceCall(authorizeAppServiceCall(caller, { operation: "app.meetings.recordings.process", action: "write.memory", resourceType: "capture_recording",
      accessMode: "mutation", eventContract: "meeting-recording-processing-events.v1" }), data, { resourceCount: 1 });
    const expected = { scope: recordingScope, requestActorId: recordingContext.actorId, role: recordingContext.role, executionScope: caller.executionScope, request: recordingRequest, idempotencyKey: recordingKey };
    const response = { ...data, serviceReceipt: completed.receipt };
    expect(nativeMeetingRecordingProcessResponseForScopeSchema(expected).safeParse(response).success).toBe(true);
    expect(nativeMeetingRecordingProcessResponseForScopeSchema({ ...expected, idempotencyKey: "another-key" }).safeParse(response).success).toBe(false);
    expect(nativeMeetingRecordingProcessResponseForScopeSchema({ ...expected, role: "viewer" }).safeParse(response).success).toBe(false);
    expect(nativeMeetingRecordingProcessResponseForScopeSchema(expected).safeParse({ ...response, transcript: "private" }).success).toBe(false);
  });
  it("keeps exact absence nullable and rejects unrelated recovery evidence", () => {
    const fixture = recordingFixture(), caller = recordingCaller(false);
    const data = { contract: "asael-meeting-recording-read:1" as const, scope: recordingScope, acceptance: null, processing: null };
    const result = completeAppServiceCall(authorizeAppServiceCall(caller, { operation: "app.meetings.recordings.processing.show", action: "read", resourceType: "capture_recording",
      accessMode: "read", eventContract: "read_only:no_domain_mutation" }), data, { resourceCount: 0 });
    const expected = { scope: recordingScope, requestActorId: recordingContext.actorId, role: recordingContext.role, keySha256: fixture.intent.keySha256 };
    expect(nativeMeetingRecordingReadResponseForScopeSchema(expected).safeParse({ ...data, serviceReceipt: result.receipt }).success).toBe(true);
    expect(nativeMeetingRecordingReadResponseForScopeSchema(expected).safeParse({ ...data, acceptance: fixture.acceptance, serviceReceipt: result.receipt }).success).toBe(false);
  });
});
