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
  listMissions,
  listMissionSummariesForRequest,
  MissionReadConflictError,
} from "@/lib/missions/store";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "mission-owner@example.test";
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
    missions: [],
    tasks: [],
    attempts: [],
    artifacts: [],
  });
  dbMocks.sql.mockClear();
});

describe("request-bound Mission summaries", () => {
  it("orders the owner pair deterministically and derives capabilities from physical ownership", async () => {
    dbMocks.rows.push(
      missionRow("mission-z", actorId, {
        updated_at: new Date("2026-09-05T12:00:00.000Z"),
      }),
      missionRow("mission-waiting", actorId, {
        status: "waiting",
        started_at: null,
        updated_at: new Date("2026-09-05T13:00:00.000Z"),
      }),
      missionRow("mission-a", canonicalActorId, {
        updated_at: new Date("2026-09-05T12:00:00.000Z"),
      }),
    );

    const summaries = await listMissionSummariesForRequest(6, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });

    expect(summaries.map((summary) => summary.id)).toEqual([
      "mission-a",
      "mission-z",
      "mission-waiting",
    ]);
    expect(summaries[0]).toMatchObject({
      canonicalStatus: { domain: "mission", status: "running" },
      detailAvailable: false,
      manageable: false,
      runnable: false,
    });
    expect(summaries[1]).toMatchObject({
      detailAvailable: true,
      manageable: true,
      runnable: true,
    });
    expect(summaries[0]).not.toHaveProperty("tenantId");
    expect(summaries[0]).not.toHaveProperty("actorId");
    expect(JSON.stringify(summaries)).not.toContain("private-source-key");
    expect(JSON.stringify(summaries)).not.toContain("private-metadata");
  });

  it("uses the indexed owner/status shape and selects only public columns plus the collision sentinel", async () => {
    await listMissionSummariesForRequest(7, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });

    expect(dbMocks.statements).toHaveLength(1);
    const statement = dbMocks.statements[0];
    expect(statement.text).toMatch(
      /WITH status_order\(status, status_rank\) AS[\s\S]*requested_owners[\s\S]*CROSS JOIN status_order[\s\S]*CROSS JOIN LATERAL[\s\S]*tenant_id = \$\d+[\s\S]*actor_id = readable_owners\.actor_id[\s\S]*status = status_order\.status[\s\S]*ORDER BY updated_at DESC, id COLLATE "C" ASC[\s\S]*LIMIT \$\d+/,
    );
    expect(statement.text).toMatch(
      /SELECT bounded_rows\.id, bounded_rows\.tenant_id, bounded_rows\.actor_id,[\s\S]*bounded_rows\.updated_at, source_key_state\.source_key_collision[\s\S]*ORDER BY bounded_rows\.status_rank ASC, bounded_rows\.updated_at DESC,[\s\S]*bounded_rows\.id COLLATE "C" ASC[\s\S]*LIMIT \$\d+/,
    );
    expect(statement.text).not.toMatch(/SELECT\s+\*/i);
    for (const projection of selectProjections(statement.text)) {
      expect(projection).not.toMatch(/\bsource_key\b|\bmetadata\b/i);
    }
    expect(statement.text).not.toMatch(
      /\binstructions\b|\bdefinition_of_done\b|\binput\b|\boutput\b|\bfence_token\b|\bexecutor_id\b|\bdata\b|\buri\b/i,
    );
    expect(statement.text).toMatch(
      /exact_mission\.source_key = canonical_mission\.source_key/,
    );
    expect(statement.text).toMatch(
      /invalid_status_state AS[\s\S]*FROM omni_missions AS invalid_mission[\s\S]*NOT EXISTS \([\s\S]*FROM status_order AS accepted_status[\s\S]*LIMIT 1[\s\S]*unsupported_status/,
    );
    expect(statement.text).toMatch(
      /FROM source_key_state[\s\S]*CROSS JOIN invalid_status_state[\s\S]*LEFT JOIN bounded_rows ON TRUE/,
    );
    expect(statement.params).toContain(canonicalActorId);
    expect(statement.params).toContain(actorId);
  });

  it("fails closed on an unsupported status even when no public row is present", async () => {
    dbMocks.rows.push({
      source_key_collision: false,
      unsupported_status: true,
      mission_present: false,
    });

    await expectRequestConflict();

    dbMocks.rows.splice(0, 1, {
      source_key_collision: false,
      unsupported_status: false,
      mission_present: false,
    });
    await expect(listMissionSummariesForRequest(10, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual([]);
  });

  it("falls back to the exact PostgreSQL actor for a missing or malformed binding", async () => {
    await listMissionSummariesForRequest(5, {
      tenantId: "tenant-a",
      actorId,
    });
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);
    expect(dbMocks.statements[0].params.filter((value) => value === actorId).length)
      .toBeGreaterThan(1);

    dbMocks.statements.splice(0);
    await listMissionSummariesForRequest(5, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: {
        ...binding,
        readableOwnerActorIds: Object.freeze([actorId, canonicalActorId]),
      },
    });
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);
  });

  it("fails closed on source-key ambiguity, duplicate IDs, or unexpected ownership", async () => {
    dbMocks.rows.push(missionRow("mission-a", actorId, {
      source_key_collision: true,
    }));
    await expectRequestConflict();

    dbMocks.rows.splice(
      0,
      1,
      missionRow("mission-a", actorId),
      missionRow("mission-a", canonicalActorId),
    );
    await expectRequestConflict();

    dbMocks.rows.splice(0, 2, missionRow("mission-a", "foreign@example.test"));
    await expectRequestConflict();

    dbMocks.rows.splice(0, 1, missionRow("mission-a", actorId, {
      tenant_id: "tenant-b",
    }));
    await expectRequestConflict();
  });

  it("rejects malformed public fields, dates, and lifecycle combinations", async () => {
    const corruptRows: Record<string, unknown>[] = [
      missionRow("mission-a", actorId, { status: "unknown" }),
      missionRow("mission-a", actorId, { priority: "critical" }),
      missionRow("mission-a", actorId, { title: " padded title" }),
      missionRow("mission-a", actorId, { objective: true }),
      missionRow("mission-a", actorId, {
        created_at: "2026-09-05T10:00:00Z",
      }),
      missionRow("mission-a", actorId, {
        created_at: new Date("2026-09-05T13:00:00.000Z"),
      }),
      missionRow("mission-a", actorId, {
        status: "running",
        started_at: null,
      }),
      missionRow("mission-a", actorId, {
        status: "draft",
        started_at: new Date("2026-09-05T10:30:00.000Z"),
      }),
      missionRow("mission-a", actorId, {
        status: "succeeded",
        terminal_at: null,
      }),
      missionRow("mission-a", actorId, {
        status: "queued",
        started_at: null,
        terminal_at: new Date("2026-09-05T11:00:00.000Z"),
      }),
    ];

    for (const row of corruptRows) {
      dbMocks.rows.splice(0, dbMocks.rows.length, row);
      await expectRequestConflict();
    }
  });

  it("keeps file fallback exact-only, strictly projected, and validates before limiting", async () => {
    dbMocks.state.databaseEnabled = false;
    dbMocks.readJsonFile.mockResolvedValue({
      missions: [
        fileMission("mission-waiting", actorId, {
          status: "waiting",
          startedAt: undefined,
          updatedAt: "2026-09-05T13:00:00.000Z",
        }),
        fileMission("mission-canonical", canonicalActorId),
        fileMission("mission-running", actorId),
        fileMission("mission-foreign", "foreign@example.test"),
      ],
      tasks: [],
      attempts: [],
      artifacts: [],
    });

    const summaries = await listMissionSummariesForRequest(1, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    });
    expect(summaries).toEqual([
      expect.objectContaining({
        id: "mission-running",
        detailAvailable: true,
        manageable: true,
        runnable: true,
      }),
    ]);
    expect(JSON.stringify(summaries)).not.toContain("private-source-key");
    expect(JSON.stringify(summaries)).not.toContain("private-metadata");
    expect(dbMocks.statements).toHaveLength(0);

    dbMocks.readJsonFile.mockResolvedValue({
      missions: [
        fileMission("mission-duplicate", actorId),
        fileMission("mission-duplicate", actorId),
      ],
      tasks: [],
      attempts: [],
      artifacts: [],
    });
    await expect(listMissionSummariesForRequest(1, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(MissionReadConflictError);

    dbMocks.readJsonFile.mockResolvedValue({
      missions: [
        fileMission("mission-first", actorId, {
          sourceKey: "duplicate-source-key",
        }),
        fileMission("mission-second", actorId, {
          sourceKey: "duplicate-source-key",
        }),
      ],
      tasks: [],
      attempts: [],
      artifacts: [],
    });
    await expect(listMissionSummariesForRequest(1, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).rejects.toBeInstanceOf(MissionReadConflictError);
  });

  it("leaves the legacy Mission list on its exact-owner query", async () => {
    dbMocks.rows.push(missionRow("mission-exact", actorId));
    await listMissions(5, { tenantId: "tenant-a", actorId });
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).toMatch(
      /SELECT \* FROM omni_missions[\s\S]*tenant_id = \$\d+ AND actor_id = \$\d+/,
    );
    expect(dbMocks.statements[0].params).toContain(actorId);
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);
  });
});

async function expectRequestConflict() {
  const promise = listMissionSummariesForRequest(10, {
    tenantId: "tenant-a",
    actorId,
    requestActorBinding: binding,
  });
  await expect(promise).rejects.toBeInstanceOf(MissionReadConflictError);
}

function missionRow(
  id: string,
  owner: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: owner,
    title: `Mission ${id}`,
    objective: `Complete ${id} safely.`,
    status: "running",
    priority: "high",
    source: "user",
    started_at: new Date("2026-09-05T10:30:00.000Z"),
    terminal_at: null,
    created_at: new Date("2026-09-05T10:00:00.000Z"),
    updated_at: new Date("2026-09-05T12:00:00.000Z"),
    source_key_collision: false,
    unsupported_status: false,
    mission_present: true,
    source_key: `private-source-key:${id}:${owner}`,
    metadata: { private: "private-metadata" },
    ...overrides,
  };
}

function fileMission(
  id: string,
  owner: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    tenantId: "tenant-a",
    actorId: owner,
    title: `Mission ${id}`,
    objective: `Complete ${id} safely.`,
    status: "running",
    priority: "high",
    source: "user",
    sourceKey: `private-source-key:${id}:${owner}`,
    metadata: { private: "private-metadata" },
    startedAt: "2026-09-05T10:30:00.000Z",
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

function selectProjections(statement: string) {
  return [...statement.matchAll(/\bSELECT\s+([\s\S]*?)\s+FROM\b/gi)]
    .map((match) => match[1]);
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
