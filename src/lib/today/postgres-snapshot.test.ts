import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  const commit = vi.fn();
  const rollback = vi.fn();
  const transaction = vi.fn(
    async (callback: (transactionSql: typeof sql) => Promise<unknown>) => {
      try {
        const result = await callback(sql);
        commit();
        return result;
      } catch (error) {
        rollback();
        throw error;
      }
    },
  );
  return {
    commit,
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => ({ transaction })),
    rollback,
    rows,
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
    getSql: dbMocks.getSql,
  };
});

import { loadPostgresTodaySnapshot } from "@/lib/today/postgres-snapshot";

beforeEach(() => {
  vi.stubEnv("OMNIAGENT_TIME_ZONE", "UTC");
  dbMocks.rows.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.sql.mockClear();
  dbMocks.transaction.mockClear();
  dbMocks.commit.mockClear();
  dbMocks.rollback.mockClear();
});

describe("Postgres Today snapshot", () => {
  it("hydrates the owner projection through one scoped transaction and aggregate statement", async () => {
    dbMocks.rows.push({
      preference_match_count: 1,
      brief_owner_collision: false,
      brief_content_malformed: false,
      items: [
        {
          id: "item-open",
          title: "Prepare launch review",
          kind: "task",
          priority: "high",
          status: "open",
          due_at: "2026-08-26T01:20:00.000Z",
          created_at: "2026-08-25T20:00:00.000Z",
          updated_at: "2026-08-25T20:00:00.000Z",
        },
        {
          id: "item-done",
          title: "Completed task",
          kind: "task",
          priority: "medium",
          status: "done",
          due_at: "2026-08-25T00:00:00.000Z",
          completed_at: "2026-08-25T01:00:00.000Z",
          created_at: "2026-08-24T00:00:00.000Z",
          updated_at: "2026-08-25T01:00:00.000Z",
        },
      ],
      threads: [{
        id: "thread-1",
        title: "Launch planning",
        updated_at: "2026-08-25T23:00:00.000Z",
      }],
      memories: [{
        id: "memory-1",
        title: "Preferred release flow",
        content: "secret=abcdefghijklmnop verify production after rollout",
        type: "procedure",
        updated_at: "2026-08-25T22:00:00.000Z",
      }],
      preferences: {
        brief_enabled: true,
        brief_time: "08:00",
        timezone: "America/Los_Angeles",
        reminder_lead_minutes: 30,
        notifications_enabled: true,
        quiet_hours_enabled: true,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
      briefs: [{
        id: "brief-1",
        local_date: "2026-08-25",
        content: {
          id: "brief-1",
          tenantId: "tenant-a",
          actorId: "owner-a",
          localDate: "2026-08-25",
          summary: "Focus on the production release.",
          focus: [{ title: "Launch", reason: "Ready for verification." }],
          watchouts: ["Watch the latency budget."],
          resurfaced: [{ title: "Release flow", context: "Verify before promotion." }],
          generatedBy: "system",
          sourceCounts: {
            items: 2,
            memories: 1,
            threads: 1,
            activeWork: 0,
            projects: 1,
          },
          generatedAt: "2026-08-26T00:30:00.000Z",
        },
        generated_by: "system",
        source_counts: {
          items: 2,
          memories: 1,
          threads: 1,
          activeWork: 0,
          projects: 1,
        },
        generated_at: "2026-08-26T00:30:00.000Z",
      }],
      projects: [{
        id: "project-1",
        title: "Asael rollout",
        objective: "Ship a fast owner workspace.",
        target_date: "2026-09-01T00:00:00.000Z",
        completed_tasks: 2,
        total_tasks: 4,
        next_task: "Run the dashboard benchmark",
        updated_at: "2026-08-25T23:30:00.000Z",
      }],
    });

    const snapshot = await loadPostgresTodaySnapshot({
      tenantId: "tenant-a",
      actorId: "owner-a",
      now: new Date("2026-08-26T01:00:00.000Z"),
    });

    expect(dbMocks.ensureDatabaseSchema).toHaveBeenCalledOnce();
    expect(dbMocks.transaction).toHaveBeenCalledOnce();
    expect(dbMocks.commit).toHaveBeenCalledOnce();
    expect(dbMocks.rollback).not.toHaveBeenCalled();
    expect(dbMocks.sql).toHaveBeenCalledTimes(2);
    expect(dbMocks.statements).toHaveLength(2);

    expect(dbMocks.statements[0].text).toContain("set_config('statement_timeout'");
    const statement = dbMocks.statements[1];
    expect(statement.text).not.toContain("set_config('statement_timeout'");
    expect(statement.text).toContain("INSERT INTO omni_today_preferences");
    expect(statement.text).toMatch(
      /WHERE[\s\S]*?NOT EXISTS \(SELECT 1 FROM existing_preferences\)/,
    );
    expect(statement.text).toContain("ON CONFLICT (tenant_id, actor_id) DO UPDATE");
    expect(statement.text).toContain("LIMIT 500");
    expect(statement.text).toMatch(
      /FROM omni_today_items items[\s\S]*?WHERE items\.tenant_id = \$\d+[\s\S]*?AND \([\s\S]*?items\.actor_id = \$\d+[\s\S]*?OR items\.actor_id = \$\d+[\s\S]*?\)/,
    );
    expect(statement.text).toMatch(
      /FROM omni_threads threads[\s\S]*?WHERE threads\.tenant_id = \$\d+[\s\S]*?AND \([\s\S]*?threads\.actor_id = \$\d+[\s\S]*?OR threads\.actor_id = \$\d+[\s\S]*?\)[\s\S]*?ORDER BY threads\.updated_at DESC, threads\.id ASC[\s\S]*?LIMIT 6/,
    );
    expect(statement.text).toMatch(
      /matched_brief_rows AS MATERIALIZED \([\s\S]*?FROM omni_daily_briefs briefs[\s\S]*?WHERE briefs\.tenant_id = \$\d+[\s\S]*?briefs\.actor_id = \$\d+[\s\S]*?OR briefs\.actor_id = \$\d+[\s\S]*?briefs\.local_date IN/,
    );
    const matchedBriefRows = statement.text.match(
      /matched_brief_rows AS MATERIALIZED \(([\s\S]*?)\),\s*brief_guard_state AS MATERIALIZED/,
    );
    expect(matchedBriefRows).not.toBeNull();
    expect(matchedBriefRows?.[1]).not.toContain("LIMIT");
    expect(statement.text).toMatch(
      /GROUP BY matched\.local_date[\s\S]*?HAVING COUNT\(DISTINCT matched\.actor_id COLLATE "C"\) > 1/,
    );
    expect(statement.text).toContain("briefs.content ->> 'id' = briefs.id");
    expect(statement.text).toContain("briefs.content ->> 'tenantId' = briefs.tenant_id");
    expect(statement.text).toContain("briefs.content ->> 'actorId' = briefs.actor_id");
    expect(statement.text).toContain("briefs.content ->> 'localDate' = briefs.local_date");
    expect(statement.text).toContain("briefs.content ->> 'generatedBy' = briefs.generated_by");
    expect(statement.text).toContain("briefs.content ->> 'model' = briefs.model");
    expect(statement.text).toContain("briefs.content -> 'sourceCounts' = briefs.source_counts");
    expect(statement.text).toContain("briefs.source_counts ?& ARRAY[");
    expect(statement.text).toContain("FROM jsonb_each(");
    expect(statement.text).toContain("isfinite(briefs.generated_at)");
    expect(statement.text).toContain("'generatedAt'\n                ~ '^[0-9]{4}");
    expect(statement.text).toContain(
      "YEAR FROM (briefs.generated_at AT TIME ZONE 'UTC')",
    );
    expect(statement.text).toContain("briefs.generated_at AT TIME ZONE 'UTC'");
    expect(statement.text).toMatch(
      /jsonb_array_length\(briefs\.content -> 'focus'\) <= 5[\s\S]*?jsonb_array_length\(briefs\.content -> 'watchouts'\) <= 4[\s\S]*?jsonb_array_length\(briefs\.content -> 'resurfaced'\) <= 3/,
    );
    expect(statement.text).toMatch(
      /CROSS JOIN brief_guard_state brief_guard[\s\S]*?WHERE state\.preference_match_count = 0[\s\S]*?AND NOT brief_guard\.brief_owner_collision[\s\S]*?AND NOT brief_guard\.brief_content_malformed/,
    );
    expect(statement.text).toMatch(
      /(?:^|\n)\s*brief_rows AS MATERIALIZED \([\s\S]*?FROM matched_brief_rows briefs[\s\S]*?ORDER BY briefs\.local_date ASC, briefs\.generated_at DESC, briefs\.id ASC[\s\S]*?LIMIT 3/,
    );
    const publicBriefRows = statement.text.match(
      /(?:^|\n)\s*brief_rows AS MATERIALIZED \(\s*SELECT([\s\S]*?)FROM matched_brief_rows briefs/,
    );
    expect(publicBriefRows).not.toBeNull();
    expect(publicBriefRows?.[1]).not.toContain("tenant_id");
    expect(publicBriefRows?.[1]).not.toContain("actor_id");
    expect(publicBriefRows?.[1]).not.toContain("content_is_valid");
    expect(statement.text).toMatch(
      /to_jsonb\(brief_rows\)[\s\S]*?ORDER BY local_date ASC, generated_at DESC, id ASC/,
    );
    expect(statement.text).toMatch(
      /FROM omni_projects projects[\s\S]*?WHERE projects\.tenant_id = \$\d+[\s\S]*?AND \([\s\S]*?projects\.actor_id = \$\d+[\s\S]*?OR projects\.actor_id = \$\d+[\s\S]*?\)[\s\S]*?AND projects\.status = 'active'[\s\S]*?ORDER BY projects\.updated_at DESC, projects\.id ASC[\s\S]*?LIMIT 4/,
    );
    expect(statement.text).toMatch(
      /active_projects AS MATERIALIZED \([\s\S]*?SELECT[\s\S]*?projects\.actor_id[\s\S]*?FROM omni_projects projects/,
    );
    const projectRowsProjection = statement.text.match(
      /project_rows AS MATERIALIZED \(\s*SELECT([\s\S]*?)FROM active_projects projects/,
    );
    expect(projectRowsProjection).not.toBeNull();
    expect(projectRowsProjection?.[1]).not.toContain("actor_id");
    expect(statement.text).toMatch(
      /FROM omni_project_tasks tasks[\s\S]*?WHERE tasks\.tenant_id = \$\d+[\s\S]*?owner_project\.tenant_id = \$\d+[\s\S]*?AND owner_project\.actor_id = projects\.actor_id/,
    );
    expect(statement.text).toMatch(
      /jsonb_agg\([\s\S]*?to_jsonb\(thread_rows\)[\s\S]*?ORDER BY updated_at DESC, id ASC[\s\S]*?\)[\s\S]*?FROM thread_rows/,
    );
    expect(statement.text).toMatch(
      /jsonb_agg\([\s\S]*?to_jsonb\(project_rows\)[\s\S]*?ORDER BY updated_at DESC, id ASC[\s\S]*?\)[\s\S]*?FROM project_rows/,
    );
    expect(statement.params.filter((value) => value === "tenant-a").length)
      .toBeGreaterThanOrEqual(8);
    expect(statement.params.filter((value) => value === "owner-a").length)
      .toBeGreaterThanOrEqual(6);

    expect(snapshot.generatedAt).toBe("2026-08-26T01:00:00.000Z");
    expect(snapshot.items).toMatchObject([
      { id: "item-open", reminderState: "due_soon", status: "open" },
      { id: "item-done", reminderState: "none", status: "done" },
    ]);
    expect(snapshot.memories[0]).toMatchObject({
      id: "memory-1",
      type: "procedure",
    });
    expect(snapshot.memories[0].content).not.toContain("abcdefghijklmnop");
    expect(snapshot.briefLocalDate).toBe("2026-08-25");
    expect(snapshot.brief).toMatchObject({
      localDate: "2026-08-25",
      summary: "Focus on the production release.",
      sourceCounts: { items: 2, projects: 1 },
    });
    expect(snapshot.brief).not.toHaveProperty("actorId");
    expect(snapshot.briefGenerationDue).toBe(false);
    expect(snapshot.projects).toEqual([{
      id: "project-1",
      title: "Asael rollout",
      objective: "Ship a fast owner workspace.",
      targetDate: "2026-09-01T00:00:00.000Z",
      completedTasks: 2,
      totalTasks: 4,
      nextTask: "Run the dashboard benchmark",
    }]);
  });

  it("uses safe read defaults when the aggregate contains malformed optional data", async () => {
    dbMocks.rows.push({
      preference_match_count: 0,
      brief_owner_collision: false,
      brief_content_malformed: false,
      items: [],
      threads: [],
      memories: [],
      preferences: null,
      briefs: [],
      projects: [],
    });

    const snapshot = await loadPostgresTodaySnapshot({
      tenantId: "tenant-defaults",
      actorId: "owner-defaults",
      now: new Date("2026-08-26T09:00:00.000Z"),
    });

    expect(dbMocks.transaction).toHaveBeenCalledOnce();
    expect(dbMocks.commit).toHaveBeenCalledOnce();
    expect(dbMocks.rollback).not.toHaveBeenCalled();
    expect(dbMocks.sql).toHaveBeenCalledTimes(2);
    expect(snapshot).toMatchObject({
      items: [],
      threads: [],
      memories: [],
      brief: undefined,
      preferences: {
        briefEnabled: true,
        briefTime: "08:00",
        timezone: "UTC",
        reminderLeadMinutes: 30,
        notificationsEnabled: true,
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      },
      briefLocalDate: "2026-08-26",
      briefGenerationDue: true,
      projects: [],
    });
  });

  it("fails closed when the aggregate does not return the required projection", async () => {
    await expect(loadPostgresTodaySnapshot({
      tenantId: "tenant-missing",
      actorId: "owner-missing",
      now: new Date("2026-08-26T09:00:00.000Z"),
    })).rejects.toThrow("Today snapshot aggregate returned no row.");
    expect(dbMocks.rollback).toHaveBeenCalledOnce();
    expect(dbMocks.commit).not.toHaveBeenCalled();
  });

  it("fails closed when canonical and legacy preference rows both match", async () => {
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const actorId = "owner@example.com";
    const canonicalActorId = `actor:${authUserId}`;
    dbMocks.rows.push({
      preference_match_count: 2,
      brief_owner_collision: false,
      brief_content_malformed: false,
    });

    await expect(loadPostgresTodaySnapshot({
      tenantId: "tenant-collision",
      actorId,
      now: new Date("2026-08-26T09:00:00.000Z"),
      requestActorBinding: {
        version: 1,
        kind: "auth_user",
        authUserId,
        canonicalActorId,
        legacyOwnerActorIds: Object.freeze([actorId]),
        readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
      },
    })).rejects.toThrow("Today preferences resolved to multiple physical rows.");

    expect(dbMocks.rollback).toHaveBeenCalledOnce();
    expect(dbMocks.commit).not.toHaveBeenCalled();

    expect(dbMocks.statements[1].params).toContain(canonicalActorId);
    expect(dbMocks.statements[1].params).toContain(actorId);
    expect(dbMocks.statements[1].text).toMatch(
      /FROM omni_today_items items[\s\S]*?items\.actor_id = \$\d+[\s\S]*?OR items\.actor_id = \$\d+/,
    );
    expectScopeActorPair(
      dbMocks.statements[1],
      /matched_brief_rows AS MATERIALIZED[\s\S]*?briefs\.actor_id = \$(\d+)[\s\S]*?OR briefs\.actor_id = \$(\d+)/,
      [canonicalActorId, actorId],
    );
    expectScopeActorPair(
      dbMocks.statements[1],
      /FROM omni_threads threads[\s\S]*?threads\.actor_id = \$(\d+)[\s\S]*?OR threads\.actor_id = \$(\d+)/,
      [canonicalActorId, actorId],
    );
    expectScopeActorPair(
      dbMocks.statements[1],
      /FROM omni_projects projects[\s\S]*?projects\.actor_id = \$(\d+)[\s\S]*?OR projects\.actor_id = \$(\d+)/,
      [canonicalActorId, actorId],
    );
    expect(dbMocks.statements[1].text).toMatch(
      /FROM omni_project_tasks tasks[\s\S]*?owner_project\.tenant_id = \$\d+[\s\S]*?owner_project\.actor_id = projects\.actor_id/,
    );
  });

  it("rolls back preference insertion when brief aliases collide beyond the limit", async () => {
    dbMocks.rows.push({
      preference_match_count: 0,
      brief_owner_collision: true,
      brief_content_malformed: false,
    });

    await expect(loadPostgresTodaySnapshot({
      tenantId: "tenant-brief-collision",
      actorId: "owner@example.com",
      now: new Date("2026-08-26T09:00:00.000Z"),
      requestActorBinding: requestActorBinding("owner@example.com"),
    })).rejects.toThrow(
      "Daily briefs resolved to multiple physical rows for one local date.",
    );

    expect(dbMocks.rollback).toHaveBeenCalledOnce();
    expect(dbMocks.commit).not.toHaveBeenCalled();
    const statement = dbMocks.statements[1];
    expect(statement.text.indexOf("brief_guard_state AS MATERIALIZED")).toBeLessThan(
      statement.text.indexOf(",\n      brief_rows AS MATERIALIZED"),
    );
  });

  it("rolls back preference insertion when stored brief identity or content is malformed", async () => {
    dbMocks.rows.push({
      preference_match_count: 0,
      brief_owner_collision: false,
      brief_content_malformed: true,
    });

    await expect(loadPostgresTodaySnapshot({
      tenantId: "tenant-brief-malformed",
      actorId: "owner@example.com",
      now: new Date("2026-08-26T09:00:00.000Z"),
      requestActorBinding: requestActorBinding("owner@example.com"),
    })).rejects.toThrow(
      "Today snapshot encountered malformed daily brief content.",
    );

    expect(dbMocks.rollback).toHaveBeenCalledOnce();
    expect(dbMocks.commit).not.toHaveBeenCalled();
  });
});

function requestActorBinding(actorId: string) {
  const authUserId = "11111111-1111-4111-8111-111111111111";
  const canonicalActorId = `actor:${authUserId}`;
  return {
    version: 1 as const,
    kind: "auth_user" as const,
    authUserId,
    canonicalActorId,
    legacyOwnerActorIds: Object.freeze([actorId]),
    readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
  };
}

function expectScopeActorPair(
  statement: { text: string; params: unknown[] },
  pattern: RegExp,
  expected: [string, string],
) {
  const match = statement.text.match(pattern);
  expect(match).not.toBeNull();
  expect(match && [
    statement.params[Number(match[1]) - 1],
    statement.params[Number(match[2]) - 1],
  ]).toEqual(expected);
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
