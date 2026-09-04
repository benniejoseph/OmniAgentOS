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

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (text, part, index) =>
      `${text}${part}${index < params.length ? `$${index + 1}` : ""}`,
    "",
  );
}
