import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";

const actorId = "actor:11111111-1111-4111-8111-111111111111";
const workspaceId = "workspace:tenant-a";
const timestamp = "2026-09-08T10:00:00.000Z";
const mocks = vi.hoisted(() => ({
  responses: [] as Record<string, unknown>[][],
  queries: [] as Array<{ text: string; values: unknown[] }>,
  event: vi.fn(),
}));

vi.mock("@/lib/db/client", () => {
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      mocks.queries.push({ text, values });
      return mocks.responses.shift() || [];
    },
    {
      transaction: async (operation: (client: unknown) => Promise<unknown>) => operation(sql),
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: () => sql,
    hasDatabaseUrl: () => true,
    runWithDatabaseActorScope: async (
      _tenantId: string,
      _actorIds: readonly string[],
      operation: () => Promise<unknown>,
    ) => operation(),
  };
});

vi.mock("@/lib/events/store", () => ({ appendScopedDomainEvent: mocks.event }));

import { buildMeetingRevision } from "@/lib/meetings/contracts";
import { readMeetingLinkedSources, saveMeeting } from "@/lib/meetings/store";

function authority(idempotencyKey = "meeting-write-1") {
  return {
    tenantId: "tenant-a",
    workspaceId,
    canonicalActorId: actorId,
    readableActorIds: [actorId, "person@example.com"],
    idempotencyKey,
    executionScope: createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      workspaceId,
      correlationId: idempotencyKey,
      purpose: "meeting.write",
    }),
  } as const;
}

function draft() {
  return {
    title: "Customer review",
    summary: "",
    status: "scheduled" as const,
    scheduledStartAt: timestamp,
    scheduledEndAt: "2026-09-08T11:00:00.000Z",
    actualStartAt: null,
    actualEndAt: null,
    timezone: "Asia/Kolkata",
    location: "Video call",
    projectId: null,
    declaredAccessClass: "workspace_members" as const,
    participants: [],
    sourceLinks: [],
    entityLinks: [],
    decisions: [],
    commitments: [],
    followUps: [],
  };
}

beforeEach(() => {
  mocks.responses = [];
  mocks.queries = [];
  mocks.event.mockReset().mockResolvedValue({ id: "event-1" });
});

describe("meeting store", () => {
  it("persists one immutable revision and a separate current projection", async () => {
    mocks.responses.push([], [], [], [], [{ revised_at: timestamp }], [], []);
    const meeting = await saveMeeting({ authority: authority(), draft: draft() });

    expect(meeting.revision).toBe(1);
    expect(meeting.effectiveAccessClass).toBe("workspace_members");
    expect(mocks.queries.some((query) => query.text.includes("INSERT INTO omni_meeting_revisions")))
      .toBe(true);
    expect(mocks.queries.some((query) => query.text.includes("INSERT INTO omni_meetings")))
      .toBe(true);
    expect(mocks.queries.every((query) => !query.text.includes("ON CONFLICT"))).toBe(true);
    expect(mocks.event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "meeting.created" }),
      expect.objectContaining({ sql: expect.any(Function) }),
    );
  });

  it("resolves an exact calendar revision and adopts project access", async () => {
    const value = {
      ...draft(),
      projectId: "project-1",
      sourceLinks: [{
        linkId: "link:calendar",
        kind: "calendar_event" as const,
        sourceId: "source-item-1",
        sourceRevisionId: "source-revision-1",
        mediaRole: "calendar" as const,
        label: "Calendar event",
      }],
    };
    mocks.responses.push(
      [], [], [], [],
      [{ project_id: "project-1" }],
      [{
          source_item_id: "source-item-1",
          source_revision_id: "source-revision-1",
          owner_actor_id: actorId,
          workspace_id: workspaceId,
          project_id: "project-1",
          mission_id: null,
          visibility: "project_shared",
          sensitivity: "confidential",
          permission_set_sha256: "a".repeat(64),
          purpose_set_sha256: "b".repeat(64),
          retention_policy_id: "retention-1",
          retention_expires_at: null,
          source_kind: "calendar_event",
          source_revision_sha256: "c".repeat(64),
      }],
      [{ revised_at: timestamp }], [], [],
    );

    const meeting = await saveMeeting({
      authority: authority("meeting-calendar-1"),
      draft: value,
    });

    expect(meeting.effectiveAccessClass).toBe("project_members");
    expect(meeting.sourceLinks[0]).toMatchObject({
      sourceRevisionId: "source-revision-1",
      sourceRevisionSha256: "c".repeat(64),
      accessClass: "project_members",
    });
    const sourceQuery = mocks.queries.find((query) => query.text.includes("FROM omni_source_revisions"));
    expect(sourceQuery?.text).toContain("source_item_id =");
    expect(sourceQuery?.text).toContain("id =");
  });

  it("rejects a stale capture revision before writing a meeting revision", async () => {
    const value = {
      ...draft(),
      participants: [{
        participantId: "participant:owner",
        displayName: "Owner",
        email: null,
        entityId: null,
        role: "organizer" as const,
        response: "accepted" as const,
        attendeeConsent: "granted" as const,
        recordingConsent: "granted" as const,
        consentCapturedAt: timestamp,
        source: "manual" as const,
      }],
      sourceLinks: [{
        linkId: "link:recording",
        kind: "capture_recording" as const,
        sourceId: "recording-1",
        sourceRevisionId: `capture-recording-revision:${"f".repeat(64)}`,
        mediaRole: "recording" as const,
        label: "Recording",
      }],
    };
    mocks.responses.push(
      [], [], [], [],
      [{
          id: "recording-1",
          actor_id: actorId,
          status: "ready",
          language: "en-US",
          started_at: timestamp,
          completed_at: "2026-09-08T11:00:00.000Z",
          duration_ms: 3_600_000,
          byte_count: 100,
          segment_count: 1,
          transcript: "Bound transcript",
          source: "capture:recording:recording-1",
          knowledge_document_id: null,
          ingest_job_id: null,
          updated_at: "2026-09-08T11:00:01.000Z",
      }],
    );

    await expect(saveMeeting({
      authority: authority("meeting-recording-1"),
      draft: value,
    })).rejects.toThrow(/changed/);
    expect(mocks.queries.some((query) => query.text.includes("INSERT INTO omni_meeting_revisions")))
      .toBe(false);
  });

  it("never substitutes a changed recording transcript for the linked revision", async () => {
    const linkedMeeting = buildMeetingRevision({
      tenantId: "tenant-a",
      workspaceId,
      ownerActorId: actorId,
      meetingId: "meeting:33333333-3333-4333-8333-333333333333",
      revision: 1,
      revisedAt: timestamp,
      definition: {
        ...draft(),
        participants: [{
          participantId: "participant:owner",
          displayName: "Owner",
          email: null,
          entityId: null,
          role: "organizer",
          response: "accepted",
          attendeeConsent: "granted",
          recordingConsent: "granted",
          consentCapturedAt: timestamp,
          source: "manual",
        }],
        sourceLinks: [{
          linkId: "link:recording",
          kind: "capture_recording",
          sourceId: "recording-1",
          sourceRevisionId: `capture-recording-revision:${"f".repeat(64)}`,
          sourceRevisionSha256: "f".repeat(64),
          sourceAuthoritySha256: "e".repeat(64),
          accessClass: "owner_private",
          mediaRole: "recording",
          label: "Recording",
        }],
      },
    });
    mocks.responses.push([{
      id: "recording-1",
      actor_id: actorId,
      status: "ready",
      language: "en-US",
      started_at: timestamp,
      completed_at: "2026-09-08T11:00:00.000Z",
      duration_ms: 3_600_000,
      byte_count: 100,
      segment_count: 1,
      transcript: "New content that was not linked",
      source: "capture:recording:recording-1",
      knowledge_document_id: null,
      ingest_job_id: null,
      updated_at: "2026-09-08T11:00:01.000Z",
    }]);

    const [view] = await readMeetingLinkedSources({
      tenantId: "tenant-a",
      workspaceId,
      canonicalActorId: actorId,
      readableActorIds: [actorId],
    }, linkedMeeting);

    expect(view.revisionState).toBe("changed");
    expect(view.transcript).toBeNull();
    expect(mocks.queries.some((query) => query.text.includes("FROM omni_capture_segments")))
      .toBe(false);
  });
});
