import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const responses: Record<string, unknown>[][] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve(responses.shift() || []);
    },
  );
  const transaction = vi.fn(
    async (callback: (transactionSql: typeof sql) => Promise<unknown>) =>
      callback(sql),
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getDatabaseTenantContext: vi.fn(() => undefined),
    getSql: vi.fn(() => ({ transaction })),
    hasDatabaseUrl: vi.fn(() => true),
    responses,
    sql,
    statements,
    transaction,
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
    getDatabaseTenantContext: dbMocks.getDatabaseTenantContext,
    getSql: dbMocks.getSql,
    hasDatabaseUrl: dbMocks.hasDatabaseUrl,
  };
});

import { getTodayBriefBundle } from "@/lib/today/briefs";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "brief-owner@example.test";
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
  vi.stubEnv("OMNIAGENT_TIME_ZONE", "UTC");
  dbMocks.responses.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getDatabaseTenantContext.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.sql.mockClear();
  dbMocks.transaction.mockClear();
});

describe("request-bound Postgres daily brief reads", () => {
  it("reads canonical and current-email owners atomically and projects the request actor", async () => {
    dbMocks.responses.push(
      [preferenceRow(actorId)],
      [briefRow("canonical-brief", canonicalActorId)],
    );

    await expect(getTodayBriefBundle({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
      requestActorBinding: binding,
    })).resolves.toMatchObject({
      localDate: "2026-09-04",
      preferences: { actorId },
      brief: { id: "canonical-brief", actorId },
      generationDue: false,
    });

    expect(dbMocks.transaction).toHaveBeenCalledOnce();
    expect(dbMocks.statements).toHaveLength(2);
    expect(dbMocks.statements[0].text).toContain("FROM omni_today_preferences");
    expect(dbMocks.statements[1].text).toMatch(
      /FROM omni_daily_briefs briefs[\s\S]*briefs\.actor_id = \$\d+[\s\S]*OR briefs\.actor_id = \$\d+[\s\S]*briefs\.local_date = \$\d+[\s\S]*LIMIT 2/,
    );
    expect(dbMocks.statements[1].text).toContain("AS source_counts_are_valid");
    expect(dbMocks.statements[1].text).toContain("FROM jsonb_each(");
    expect(dbMocks.statements[1].params).toEqual([
      "tenant-a",
      canonicalActorId,
      actorId,
      "2026-09-04",
      canonicalActorId,
    ]);
    expect(dbMocks.statements.some((statement) =>
      statement.text.includes("INSERT INTO omni_today_preferences")
    )).toBe(false);
  });

  it("rejects a same-date alias collision inside the transaction", async () => {
    dbMocks.responses.push(
      [preferenceRow(actorId)],
      [
        briefRow("canonical-brief", canonicalActorId),
        briefRow("email-brief", actorId),
      ],
    );

    await expect(getTodayBriefBundle({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
      requestActorBinding: binding,
    })).rejects.toThrow(
      "Daily brief resolved to multiple physical rows for one local date.",
    );

    expect(dbMocks.transaction).toHaveBeenCalledOnce();
    expect(dbMocks.statements.some((statement) =>
      statement.text.includes("INSERT INTO omni_today_preferences")
    )).toBe(false);
  });

  it("rejects malformed ownership content before creating default preferences", async () => {
    const malformed = briefRow("canonical-brief", canonicalActorId);
    malformed.content.actorId = actorId;
    dbMocks.responses.push([], [malformed]);

    await expect(getTodayBriefBundle({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
      requestActorBinding: binding,
    })).rejects.toThrow(
      "Daily brief content does not match its physical row.",
    );

    expect(dbMocks.statements).toHaveLength(2);
    expect(dbMocks.statements.some((statement) =>
      statement.text.includes("INSERT INTO omni_today_preferences")
    )).toBe(false);
  });

  it("does not normalize content that the Today SQL guard rejects", async () => {
    const padded = briefRow("canonical-brief", canonicalActorId);
    padded.content.summary = " Priorities are ready. ";
    dbMocks.responses.push([preferenceRow(actorId)], [padded]);

    await expect(getTodayBriefBundle({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
      requestActorBinding: binding,
    })).rejects.toThrow(
      "Daily brief content does not match its physical row.",
    );

    dbMocks.responses.push([preferenceRow(actorId)]);
    const alternateTimestamp = briefRow("canonical-brief", canonicalActorId);
    alternateTimestamp.content.generatedAt = "2026-09-04T08:00:00Z";
    dbMocks.responses.push([alternateTimestamp]);

    await expect(getTodayBriefBundle({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
      requestActorBinding: binding,
    })).rejects.toThrow(
      "Daily brief content does not match its physical row.",
    );
  });

  it("requires the exact JSONB source-count guard before JavaScript projection", async () => {
    const imprecise = briefRow("canonical-brief", canonicalActorId);
    imprecise.source_counts_are_valid = false;
    dbMocks.responses.push([preferenceRow(actorId)], [imprecise]);

    await expect(getTodayBriefBundle({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
      requestActorBinding: binding,
    })).rejects.toThrow(
      "Daily brief content does not match its physical row.",
    );
  });

  it("keeps bindingless Postgres bundles on the same strict exact-owner path", async () => {
    const malformed = briefRow("email-brief", actorId);
    malformed.content.summary = " Padded summary ";
    dbMocks.responses.push([preferenceRow(actorId)], [malformed]);

    await expect(getTodayBriefBundle({
      tenantId: "tenant-a",
      actorId,
      now: new Date("2026-09-04T12:00:00.000Z"),
    })).rejects.toThrow(
      "Daily brief content does not match its physical row.",
    );

    expect(dbMocks.statements[1].params).toEqual([
      "tenant-a",
      actorId,
      actorId,
      "2026-09-04",
      actorId,
    ]);
  });
});

function preferenceRow(ownerActorId: string) {
  return {
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    brief_enabled: true,
    brief_time: "08:00",
    timezone: "UTC",
    reminder_lead_minutes: 30,
    notifications_enabled: true,
    quiet_hours_enabled: true,
    quiet_hours_start: "22:00",
    quiet_hours_end: "07:00",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

function briefRow(id: string, ownerActorId: string) {
  const sourceCounts = {
    items: 1,
    memories: 2,
    threads: 3,
    activeWork: 4,
    projects: 5,
  };
  const generatedAt = "2026-09-04T08:00:00.000Z";
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    local_date: "2026-09-04",
    content: {
      id,
      tenantId: "tenant-a",
      actorId: ownerActorId,
      localDate: "2026-09-04",
      summary: "Priorities are ready.",
      focus: [{ title: "Ship safely", reason: "The release is ready." }],
      watchouts: [],
      resurfaced: [],
      generatedBy: "system",
      sourceCounts,
      generatedAt,
    },
    generated_by: "system",
    model: null,
    source_counts: sourceCounts,
    source_counts_are_valid: true,
    generated_at: generatedAt,
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
