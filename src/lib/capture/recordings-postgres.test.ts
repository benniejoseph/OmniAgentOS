import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const state = { databaseEnabled: true };
  const rows: Record<string, unknown>[] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => state.databaseEnabled),
    readJsonFile: vi.fn(),
    rows,
    sql,
    state,
    statements,
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
  getSql: dbMocks.getSql,
  hasDatabaseUrl: dbMocks.hasDatabaseUrl,
}));

vi.mock("@/lib/storage/json", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/json")>()),
  readJsonFile: dbMocks.readJsonFile,
}));

import {
  CaptureRecordingReadConflictError,
  getCaptureRecording,
  getCaptureRecordingMetadataForRequest,
  listCaptureRecordings,
  listCaptureRecordingsForRequest,
} from "@/lib/capture/recordings";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "capture-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

beforeEach(() => {
  dbMocks.state.databaseEnabled = true;
  dbMocks.rows.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.readJsonFile.mockReset().mockResolvedValue({
    recordings: [],
    segments: [],
  });
  dbMocks.sql.mockClear();
});

describe("request-bound Capture recording summaries", () => {
  it("globally limits the owner pair and derives actionability from physical ownership", async () => {
    dbMocks.rows.push(
      recordingRow("canonical-recording", canonicalActorId),
      recordingRow("email-recording", actorId),
    );

    const records = await listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    }, 6);
    expect(records).toEqual([
      {
        id: "canonical-recording",
        title: "Recording canonical-recording",
        status: "ready",
        startedAt: "2026-09-04T10:00:00.000Z",
        completedAt: "2026-09-04T10:15:00.000Z",
        durationMs: 900_000,
        segmentCount: 15,
        updatedAt: "2026-09-04T10:15:00.000Z",
        metadataDetailAvailable: true,
        detailAvailable: false,
        manageable: false,
      },
      {
        id: "email-recording",
        title: "Recording email-recording",
        status: "ready",
        startedAt: "2026-09-04T10:00:00.000Z",
        completedAt: "2026-09-04T10:15:00.000Z",
        durationMs: 900_000,
        segmentCount: 15,
        updatedAt: "2026-09-04T10:15:00.000Z",
        metadataDetailAvailable: true,
        detailAvailable: true,
        manageable: true,
      },
    ]);

    const statement = dbMocks.statements[0];
    expect(statement.text).toMatch(
      /WITH canonical_rows AS[\s\S]*?actor_id = \$\d+[\s\S]*?ORDER BY updated_at DESC, id COLLATE "C" ASC[\s\S]*?LIMIT \$\d+[\s\S]*?exact_rows AS[\s\S]*?WHERE \$\d+::text COLLATE "C" <>[\s\S]*?actor_id = \$\d+[\s\S]*?ORDER BY updated_at DESC, id COLLATE "C" ASC[\s\S]*?LIMIT \$\d+[\s\S]*?UNION ALL[\s\S]*?ORDER BY updated_at DESC, id COLLATE "C" ASC[\s\S]*?LIMIT \$\d+/,
    );
    expect(statement.text).not.toMatch(
      /\btranscript\b|\baudio_data\b|\bmetadata\b|\bingest_job_id\b|\bknowledge_document_id\b|\bbyte_count\b|\bsource\b/,
    );
    expect(statement.params).toEqual([
      "tenant-a",
      canonicalActorId,
      "tenant-a",
      canonicalActorId,
      6,
      actorId,
      canonicalActorId,
      "tenant-a",
      actorId,
      "tenant-a",
      actorId,
      6,
      6,
    ]);
  });

  it("falls back to an exact PostgreSQL actor for an absent or malformed binding", async () => {
    await listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
    }, 5);
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      "tenant-a",
      actorId,
      5,
      actorId,
      actorId,
      "tenant-a",
      actorId,
      "tenant-a",
      actorId,
      5,
      5,
    ]);

    dbMocks.statements.splice(0);
    await listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    }, 4);
    expect(dbMocks.statements[0].params).toEqual([
      "tenant-a",
      actorId,
      "tenant-a",
      actorId,
      4,
      actorId,
      actorId,
      "tenant-a",
      actorId,
      "tenant-a",
      actorId,
      4,
      4,
    ]);
  });

  it("accepts exact scalar limits, zero state, and normalized title controls", async () => {
    const maximumId = "r".repeat(200);
    dbMocks.rows.push({
      ...recordingRow(maximumId, actorId),
      title: "t".repeat(240),
      duration_ms: "86400000",
      segment_count: 1_440,
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual([expect.objectContaining({
      id: maximumId,
      title: "t".repeat(240),
      durationMs: 86_400_000,
      segmentCount: 1_440,
    })]);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      title: "Quarterly\u202e\nreview",
      duration_ms: "0",
      segment_count: 0,
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual([expect.objectContaining({
      title: "Quarterly review",
      durationMs: 0,
      segmentCount: 0,
    })]);
  });

  it("fails closed when a projected row has an unexpected owner or malformed summary", async () => {
    dbMocks.rows.push(
      recordingRow("recording-a", "unexpected-owner@example.test"),
    );
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("r".repeat(201), actorId),
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      duration_ms: -1,
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      duration_ms: "86400001",
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      title: "x".repeat(241),
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      updated_at: "not-a-timestamp",
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      status: "unexpected",
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      duration_ms: null,
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      segment_count: 1_441,
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      status: ["ready"],
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);

    dbMocks.rows.splice(0, 1, {
      ...recordingRow("recording-a", actorId),
      updated_at: ["2026-09-04T10:15:00.000Z"],
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);
  });

  it("keeps file fallback exact and returns an explicit summary allowlist", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      recordings: [
        fileRecording("canonical-recording", canonicalActorId),
        fileRecording("email-recording", actorId),
      ],
      segments: [],
    });

    const records = await listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });
    expect(records).toEqual([{
      id: "email-recording",
      title: "Recording email-recording",
      status: "ready",
      startedAt: "2026-09-04T10:00:00.000Z",
      completedAt: "2026-09-04T10:15:00.000Z",
      durationMs: 900_000,
      segmentCount: 1,
      updatedAt: "2026-09-04T10:15:00.000Z",
      metadataDetailAvailable: true,
      detailAvailable: true,
      manageable: true,
    }]);
    expect(records[0]).not.toHaveProperty("transcript");
    expect(records[0]).not.toHaveProperty("actorId");
    expect(records[0]).not.toHaveProperty("source");
    expect(records[0]).not.toHaveProperty("metadata");
    expect(records[0]).not.toHaveProperty("ingestJobId");
    expect(records[0]).not.toHaveProperty("knowledgeDocumentId");
  });

  it("rejects duplicate file-ledger recording identities before limiting", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      recordings: [
        fileRecording("duplicate-recording", actorId),
        {
          ...fileRecording("duplicate-recording", actorId),
          updatedAt: "2026-09-04T11:15:00.000Z",
        },
      ],
      segments: [],
    });
    await expect(listCaptureRecordingsForRequest({
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    }, 1)).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);
  });

  it("leaves the legacy full list and detail paths exact-owner", async () => {
    await listCaptureRecordings({ tenantId: "tenant-a", actorId }, 3);
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).toMatch(
      /WHERE tenant_id = \$\d+ AND actor_id = \$\d+/,
    );
    expect(dbMocks.statements[0].params).toEqual(["tenant-a", actorId, 3]);
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);

    dbMocks.statements.splice(0);
    await expect(getCaptureRecording("recording-a", {
      tenantId: "tenant-a",
      actorId,
    })).resolves.toBeUndefined();
    expect(dbMocks.statements).toHaveLength(2);
    for (const statement of dbMocks.statements) {
      expect(statement.params).toContain("recording-a");
      expect(statement.params).toContain("tenant-a");
      expect(statement.params).toContain(actorId);
      expect(statement.params).not.toContain(canonicalActorId);
    }
  });
});

describe("request-bound Capture recording metadata detail", () => {
  it("returns one canonical metadata snapshot with retained capabilities and a strict SQL allowlist", async () => {
    dbMocks.rows.push(...metadataSnapshotRows(canonicalActorId));

    const detail = await getCaptureRecordingMetadataForRequest(
      "recording-a",
      {
        tenantId: "tenant-a",
        actorId,
        requestActorBinding: binding,
      },
    );

    expect(detail).toEqual({
      id: "recording-a",
      title: "Recording recording-a",
      status: "ready",
      language: "en-US",
      tags: ["customer-call", "quarterly-review"],
      startedAt: "2026-09-04T10:00:00.000Z",
      completedAt: "2026-09-04T10:04:00.000Z",
      durationMs: 3_000,
      byteCount: 30,
      segmentCount: 2,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:05:00.000Z",
      segments: [
        {
          id: "segment-0",
          segmentIndex: 0,
          mimeType: "audio/webm",
          durationMs: 1_000,
          byteCount: 10,
          transcriptionStatus: "completed",
          createdAt: "2026-09-04T10:01:00.000Z",
          updatedAt: "2026-09-04T10:03:00.000Z",
        },
        {
          id: "segment-1",
          segmentIndex: 1,
          mimeType: "audio/webm",
          durationMs: 2_000,
          byteCount: 20,
          transcriptionStatus: "completed",
          createdAt: "2026-09-04T10:02:00.000Z",
          updatedAt: "2026-09-04T10:02:00.000Z",
        },
      ],
      metadataAvailable: true,
      segmentMetadataAvailable: true,
      transcriptAvailable: false,
      audioAvailable: false,
      manageable: false,
    });
    expect(detail).not.toHaveProperty("tenantId");
    expect(detail).not.toHaveProperty("actorId");
    expect(detail?.segments[0]).not.toHaveProperty("recordingId");
    expect(detail?.segments[0]).not.toHaveProperty("tenantId");
    expect(detail?.segments[0]).not.toHaveProperty("actorId");

    expect(dbMocks.statements).toHaveLength(1);
    const statement = dbMocks.statements[0];
    expect(statement.text).toMatch(
      /WITH readable_parent AS[\s\S]*?WHERE id = \$\d+[\s\S]*?tenant_id = \$\d+[\s\S]*?actor_id IN \(\$\d+, \$\d+\)[\s\S]*?bounded_segments AS[\s\S]*?INNER JOIN readable_parent[\s\S]*?segment\.recording_id = \$\d+[\s\S]*?ORDER BY segment\.segment_index ASC, segment\.id COLLATE "C" ASC[\s\S]*?UNION ALL[\s\S]*?FROM snapshot_rows[\s\S]*?LIMIT \$\d+/,
    );
    expect(statement.text).not.toMatch(/SELECT\s+\*/);
    expect(statement.text).not.toMatch(
      /\baudio_sha256\b|\baudio_data\b|\btranscript\b|\btranscription_model\b|\btranscription_error\b|\bmetadata\b|\bsource\b|\bknowledge_document_id\b|\bingest_job_id\b/,
    );
    expect(statement.params).toContain(1_441);
    expect(statement.params).toContain(1_442);
    expect(statement.params).toContain(canonicalActorId);
    expect(statement.params).toContain(actorId);
  });

  it("derives transcript, audio, and mutation capabilities from the physical exact owner", async () => {
    dbMocks.rows.push(...metadataSnapshotRows(actorId));

    await expect(getCaptureRecordingMetadataForRequest("recording-a", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      metadataAvailable: true,
      segmentMetadataAvailable: true,
      transcriptAvailable: true,
      audioAvailable: true,
      manageable: true,
    }));
  });

  it("returns undefined for zero rows and uses only the exact actor for a malformed binding", async () => {
    await expect(getCaptureRecordingMetadataForRequest("recording-a", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    })).resolves.toBeUndefined();

    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);
    expect(dbMocks.statements[0].params.filter((value) =>
      value === actorId
    ).length).toBeGreaterThan(1);
  });

  it("fails closed for duplicate parents, unexpected ownership, or mixed child ownership", async () => {
    dbMocks.rows.push(
      metadataParentRow("recording-a", canonicalActorId),
      metadataParentRow("recording-a", actorId),
    );
    await expectMetadataDetailConflict();

    dbMocks.rows.splice(
      0,
      dbMocks.rows.length,
      ...metadataSnapshotRows("unexpected-owner@example.test"),
    );
    await expectMetadataDetailConflict();

    const mixedRows = metadataSnapshotRows(canonicalActorId);
    mixedRows[1] = {
      ...mixedRows[1],
      segment_actor_id: actorId,
    };
    dbMocks.rows.splice(0, dbMocks.rows.length, ...mixedRows);
    await expectMetadataDetailConflict();
  });

  it("rejects malformed public fields, chronology, indices, and aggregates", async () => {
    const malformedSnapshots = [
      metadataSnapshotRows(actorId, { tags: ["quarterly-review", "quarterly-review"] }),
      metadataSnapshotRows(actorId, { status: "unexpected" }),
      metadataSnapshotRows(actorId, { completed_at: null }),
      metadataSnapshotRows(actorId, { language: "en_US" }),
      metadataSnapshotRows(actorId, { recording_duration_ms: "3e3" }),
      metadataSnapshotRows(actorId, {
        recording_updated_at: new Date("2026-09-04T10:03:00.000Z"),
      }),
      metadataSnapshotRows(actorId, {}, {
        mime_type: "audio/webm;codecs=opus",
      }),
      metadataSnapshotRows(actorId, {}, {
        transcription_status: "unknown",
      }),
      metadataSnapshotRows(actorId, {}, {
        segment_index: 1,
      }),
      metadataSnapshotRows(actorId, {}, {
        segment_created_at: new Date("2026-09-04T09:59:00.000Z"),
      }),
      metadataSnapshotRows(actorId, { recording_byte_count: "31" }),
    ];
    for (const rows of malformedSnapshots) {
      dbMocks.rows.splice(0, dbMocks.rows.length, ...rows);
      await expectMetadataDetailConflict();
    }
  });

  it("accepts ordered unique bounded segment indices with gaps and a nonzero first index", async () => {
    const rows = metadataSnapshotRows(actorId);
    rows[1] = { ...rows[1], segment_index: 4 };
    rows[2] = { ...rows[2], segment_index: 9 };
    dbMocks.rows.push(...rows);

    await expect(getCaptureRecordingMetadataForRequest("recording-a", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      segments: [
        expect.objectContaining({ segmentIndex: 4 }),
        expect.objectContaining({ segmentIndex: 9 }),
      ],
    }));
  });

  it("rejects pending segments once the recording has left the recording lifecycle", async () => {
    const rows = metadataSnapshotRows(actorId);
    rows[1] = { ...rows[1], transcription_status: "pending" };
    dbMocks.rows.push(...rows);

    await expectMetadataDetailConflict();
  });

  it("keeps file metadata exact and returns only the public projection", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      recordings: [
        fileRecording("canonical-recording", canonicalActorId),
        {
          ...fileRecording("recording-a", actorId),
          durationMs: 1_000,
          byteCount: 32,
          segmentCount: 1,
        },
      ],
      segments: [fileSegment("segment-0", "recording-a", actorId)],
    });

    await expect(getCaptureRecordingMetadataForRequest("canonical-recording", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toBeUndefined();

    const detail = await getCaptureRecordingMetadataForRequest(
      "recording-a",
      {
        tenantId: "tenant-a",
        actorId,
        requestActorBinding: binding,
      },
    );
    expect(detail).toEqual(expect.objectContaining({
      id: "recording-a",
      metadataAvailable: true,
      segmentMetadataAvailable: true,
      transcriptAvailable: true,
      audioAvailable: true,
      manageable: true,
      segments: [expect.objectContaining({
        id: "segment-0",
        segmentIndex: 0,
      })],
    }));
    expect(detail).not.toHaveProperty("transcript");
    expect(detail).not.toHaveProperty("source");
    expect(detail).not.toHaveProperty("metadata");
    expect(detail).not.toHaveProperty("knowledgeDocumentId");
    expect(detail).not.toHaveProperty("ingestJobId");
    expect(detail?.segments[0]).not.toHaveProperty("audioSha256");
    expect(detail?.segments[0]).not.toHaveProperty("audioPath");
    expect(detail?.segments[0]).not.toHaveProperty("transcript");
    expect(detail?.segments[0]).not.toHaveProperty("transcriptionModel");
    expect(detail?.segments[0]).not.toHaveProperty("transcriptionError");
    expect(detail?.segments[0]).not.toHaveProperty("metadata");
    expect(dbMocks.statements).toHaveLength(0);
  });

  it("fails closed when an exact file recording contains a foreign child", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      recordings: [{
        ...fileRecording("recording-a", actorId),
        durationMs: 1_000,
        byteCount: 32,
        segmentCount: 1,
      }],
      segments: [fileSegment(
        "segment-0",
        "recording-a",
        canonicalActorId,
      )],
    });

    await expectMetadataDetailConflict();
  });
});

function metadataSnapshotRows(
  owner: string,
  parentOverrides: Record<string, unknown> = {},
  firstSegmentOverrides: Record<string, unknown> = {},
) {
  return [
    metadataParentRow("recording-a", owner, parentOverrides),
    {
      ...metadataSegmentRow("segment-0", "recording-a", owner, 0, {
        segment_duration_ms: "1000",
        segment_byte_count: 10,
        transcription_status: "completed",
        segment_created_at: new Date("2026-09-04T10:01:00.000Z"),
        segment_updated_at: new Date("2026-09-04T10:03:00.000Z"),
      }),
      ...firstSegmentOverrides,
    },
    metadataSegmentRow("segment-1", "recording-a", owner, 1, {
      segment_duration_ms: "2000",
      segment_byte_count: "20",
      transcription_status: "completed",
      segment_created_at: new Date("2026-09-04T10:02:00.000Z"),
      segment_updated_at: new Date("2026-09-04T10:02:00.000Z"),
    }),
  ];
}

function metadataParentRow(
  id: string,
  owner: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    row_kind: "recording",
    recording_id: id,
    recording_tenant_id: "tenant-a",
    recording_actor_id: owner,
    title: `Recording ${id}`,
    status: "ready",
    language: "en-US",
    tags: ["customer-call", "quarterly-review"],
    started_at: new Date("2026-09-04T10:00:00.000Z"),
    completed_at: new Date("2026-09-04T10:04:00.000Z"),
    recording_duration_ms: "3000",
    recording_byte_count: "30",
    segment_count: "2",
    recording_created_at: new Date("2026-09-04T10:00:00.000Z"),
    recording_updated_at: new Date("2026-09-04T10:05:00.000Z"),
    future_secret: "must-not-project",
    ...overrides,
  };
}

function metadataSegmentRow(
  id: string,
  recordingId: string,
  owner: string,
  segmentIndex: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    row_kind: "segment",
    segment_id: id,
    segment_tenant_id: "tenant-a",
    segment_actor_id: owner,
    segment_recording_id: recordingId,
    segment_index: segmentIndex,
    mime_type: "audio/webm",
    segment_duration_ms: 0,
    segment_byte_count: 1,
    transcription_status: "pending",
    segment_created_at: new Date("2026-09-04T10:01:00.000Z"),
    segment_updated_at: new Date("2026-09-04T10:01:00.000Z"),
    private_transcript: "must-not-project",
    private_audio_sha256: "must-not-project",
    ...overrides,
  };
}

async function expectMetadataDetailConflict() {
  await expect(getCaptureRecordingMetadataForRequest("recording-a", {
    tenantId: "tenant-a",
    actorId,
    requestActorBinding: binding,
  })).rejects.toBeInstanceOf(CaptureRecordingReadConflictError);
}

function recordingRow(id: string, owner: string) {
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: owner,
    title: `Recording ${id}`,
    status: "ready",
    started_at: new Date("2026-09-04T10:00:00.000Z"),
    completed_at: new Date("2026-09-04T10:15:00.000Z"),
    duration_ms: "900000",
    segment_count: 15,
    source: `capture:recording:${id}`,
    updated_at: new Date("2026-09-04T10:15:00.000Z"),
    future_secret: "must-not-project",
  };
}

function fileRecording(id: string, owner: string) {
  return {
    id,
    tenantId: "tenant-a",
    actorId: owner,
    title: `Recording ${id}`,
    status: "ready",
    language: "en-US",
    tags: [],
    startedAt: "2026-09-04T10:00:00.000Z",
    completedAt: "2026-09-04T10:15:00.000Z",
    durationMs: 900_000,
    byteCount: 32,
    segmentCount: 1,
    transcript: "private transcript",
    source: `capture:recording:${id}`,
    knowledgeDocumentId: "knowledge-a",
    ingestJobId: "job-a",
    metadata: { private: "value" },
    futureSecret: "must-not-project",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:15:00.000Z",
  };
}

function fileSegment(id: string, recordingId: string, owner: string) {
  return {
    id,
    tenantId: "tenant-a",
    actorId: owner,
    recordingId,
    segmentIndex: 0,
    mimeType: "audio/webm",
    byteCount: 32,
    durationMs: 1_000,
    audioSha256: "a".repeat(64),
    transcript: "private segment transcript",
    transcriptionStatus: "completed",
    transcriptionModel: "private-model",
    transcriptionError: "private-error",
    metadata: { private: "value" },
    audioPath: "/private/capture-audio/segment-0.bin",
    createdAt: "2026-09-04T10:01:00.000Z",
    updatedAt: "2026-09-04T10:03:00.000Z",
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (text, part, index) =>
      `${text}${part}${index < params.length ? `$${index + 1}` : ""}`,
    "",
  );
}
