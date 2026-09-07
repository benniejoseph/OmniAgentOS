import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestAccess: vi.fn(),
  listMeetings: vi.fn(),
  getMeeting: vi.fn(),
  saveMeeting: vi.fn(),
}));

vi.mock("@/lib/memory/shared-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/shared-context")>()),
  requestSharedMemoryAccessFromSecurityContext: mocks.requestAccess,
}));

vi.mock("@/lib/meetings/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meetings/store")>()),
  listMeetings: mocks.listMeetings,
  getMeeting: mocks.getMeeting,
  saveMeeting: mocks.saveMeeting,
}));

import {
  createAppServiceCaller,
} from "@/lib/app-services/contracts";
import {
  createMeetingService,
  listMeetingsService,
  updateMeetingService,
} from "@/lib/app-services/meetings";
import { buildMeetingRevision } from "@/lib/meetings/contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const workspaceId = `workspace:personal:${authUserId}`;
const timestamp = "2026-09-08T10:00:00.000Z";
const context = {
  tenantId: "tenant-meeting",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-meeting",
    tenantName: "Meeting tenant",
  },
} satisfies SecurityContext;

const meeting = buildMeetingRevision({
  tenantId: context.tenantId,
  workspaceId,
  ownerActorId: canonicalActorId,
  meetingId: "meeting:22222222-2222-4222-8222-222222222222",
  revision: 1,
  revisedAt: timestamp,
  definition: {
    title: "Customer review",
    status: "scheduled",
    scheduledStartAt: timestamp,
    scheduledEndAt: "2026-09-08T11:00:00.000Z",
    timezone: "Asia/Kolkata",
    projectId: null,
    declaredAccessClass: "owner_private",
  },
});

function access(canWrite = true) {
  return {
    actorBinding: {
      canonicalActorId,
      readableOwnerActorIds: [canonicalActorId, context.actorId],
    },
    authority: {
      workspaceId,
      accessLevel: canWrite ? "manager" : "reader",
      canWrite,
      authoritySha256: "a".repeat(64),
    },
  };
}

function draft() {
  return {
    title: "Customer review",
    status: "scheduled" as const,
    scheduledStartAt: timestamp,
    scheduledEndAt: "2026-09-08T11:00:00.000Z",
    timezone: "Asia/Kolkata",
    projectId: null,
    declaredAccessClass: "owner_private" as const,
  };
}

function mutationCaller(idempotencyKey: string) {
  return createAppServiceCaller({
    context,
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId: context.tenantId,
      initiatingActorId: context.actorId,
      executingPrincipalType: "user",
      executingPrincipalId: context.actorId,
      correlationId: idempotencyKey,
      purpose: "api.meeting.write",
    }),
  });
}

beforeEach(() => {
  mocks.requestAccess.mockReset().mockResolvedValue(access());
  mocks.listMeetings.mockReset().mockResolvedValue([meeting]);
  mocks.getMeeting.mockReset().mockResolvedValue(meeting);
  mocks.saveMeeting.mockReset().mockResolvedValue(meeting);
});

describe("meeting app services", () => {
  it("lists through canonical readable actor scope", async () => {
    const result = await listMeetingsService(
      createAppServiceCaller({ context }),
      { limit: 20 },
    );
    expect(result.receipt.operation).toBe("app.meetings.list");
    expect(mocks.listMeetings).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      workspaceId,
      canonicalActorId,
      readableActorIds: [canonicalActorId, context.actorId],
    }), { limit: 20, status: undefined });
  });

  it("creates through a canonical meeting execution scope", async () => {
    const result = await createMeetingService(
      mutationCaller("meeting-create-1"),
      draft(),
    );
    expect(result.receipt.operation).toBe("app.meetings.create");
    const call = mocks.saveMeeting.mock.calls[0][0];
    expect(call.authority.executionScope).toMatchObject({
      initiatingActorId: canonicalActorId,
      executingPrincipalId: canonicalActorId,
      workspaceId,
      projectId: null,
      purpose: "meeting.write",
    });
    expect(call.authority.idempotencyKey).toBe("meeting-create-1");
  });

  it("requires exact optimistic concurrency when revising", async () => {
    await updateMeetingService(mutationCaller("meeting-update-1"), {
      ...draft(),
      meetingId: meeting.meetingId,
      expectedRevision: meeting.revision,
    });
    expect(mocks.saveMeeting).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: meeting.meetingId,
      expectedRevision: 1,
    }));
  });

  it("rejects writes for a workspace reader", async () => {
    mocks.requestAccess.mockResolvedValue(access(false));
    await expect(createMeetingService(
      mutationCaller("meeting-create-reader"),
      draft(),
    )).rejects.toThrow(/contributor access/);
    expect(mocks.saveMeeting).not.toHaveBeenCalled();
  });
});
