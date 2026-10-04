import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), review: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/app-services/meeting-recordings", () => ({ inspectMeetingRecordingProcessingService: mocks.read, reviewMeetingRecordingService: mocks.review }));
vi.mock("@/lib/db/client", async (actual) => ({ ...await actual<typeof import("@/lib/db/client")>(), withDatabaseRequestScope: (handler: unknown) => handler }));
vi.mock("@/lib/security/guard", async (actual) => ({ ...await actual<typeof import("@/lib/security/guard")>(), authorizeRequest: mocks.authorize }));
import { GET as read } from "./[id]/processing/[keySha256]/route";
import { GET as review } from "./[id]/processing-review/route";
import { recordingContext, recordingScope } from "@/lib/capture/meeting-recording-native.test-fixtures";
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); mocks.authorize.mockResolvedValue(recordingContext); });
describe("native recording exact GET boundary", () => {
  it("requires exact single Meeting/workspace coordinates on both reads", async () => {
    for (const query of ["", `?meetingId=${recordingScope.meetingId}`, `?meetingId=${recordingScope.meetingId}&workspaceId=${recordingScope.workspaceId}&workspaceId=${recordingScope.workspaceId}`]) {
      const response = await review(new Request(`http://localhost/review${query}`), { params: Promise.resolve({ id: recordingScope.recordingId }) });
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("dispatches only an exact read and preserves unknown absence", async () => {
    mocks.read.mockResolvedValue({ data: { acceptance: null, processing: null }, receipt: { operation: "app.meetings.recordings.processing.show" } });
    const key = "a".repeat(64), response = await read(new Request(`http://localhost/read?meetingId=${recordingScope.meetingId}&workspaceId=${recordingScope.workspaceId}`),
      { params: Promise.resolve({ id: recordingScope.recordingId, keySha256: key }) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ acceptance: null, processing: null });
    expect(mocks.read).toHaveBeenCalledWith(expect.any(Object), recordingScope.recordingId, key, { meetingId: recordingScope.meetingId, workspaceId: recordingScope.workspaceId });
    expect(mocks.review).not.toHaveBeenCalled();
  });
});
