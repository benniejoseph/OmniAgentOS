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
  const transaction = vi.fn(
    async (callback: (transactionSql: typeof sql) => Promise<unknown>) =>
      callback(sql),
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => ({ transaction })),
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
});

describe("Postgres Today snapshot", () => {
  it("hydrates the owner projection through one scoped transaction and aggregate statement", async () => {
    dbMocks.rows.push({
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
          summary: "Focus on the production release.",
          focus: [{ title: "Launch", reason: "Ready for verification." }],
          watchouts: ["Watch the latency budget."],
          resurfaced: [{ title: "Release flow", context: "Verify before promotion." }],
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
    expect(dbMocks.sql).toHaveBeenCalledTimes(2);
    expect(dbMocks.statements).toHaveLength(2);

    expect(dbMocks.statements[0].text).toContain("set_config('statement_timeout'");
    const statement = dbMocks.statements[1];
    expect(statement.text).not.toContain("set_config('statement_timeout'");
    expect(statement.text).toContain("INSERT INTO omni_today_preferences");
    expect(statement.text).toContain("WHERE NOT EXISTS (SELECT 1 FROM existing_preferences)");
    expect(statement.text).toContain("ON CONFLICT (tenant_id, actor_id) DO UPDATE");
    expect(statement.text).toContain("LIMIT 500");
    expect(statement.text).toMatch(
      /FROM omni_today_items items[\s\S]*?WHERE items\.tenant_id = \$\d+[\s\S]*?AND items\.actor_id = \$\d+/,
    );
    expect(statement.text).toMatch(
      /FROM omni_threads threads[\s\S]*?WHERE threads\.tenant_id = \$\d+[\s\S]*?AND threads\.actor_id = \$\d+/,
    );
    expect(statement.text).toMatch(
      /FROM omni_daily_briefs briefs[\s\S]*?WHERE briefs\.tenant_id = \$\d+[\s\S]*?AND briefs\.actor_id = \$\d+/,
    );
    expect(statement.text).toMatch(
      /FROM omni_projects projects[\s\S]*?WHERE projects\.tenant_id = \$\d+[\s\S]*?AND projects\.actor_id = \$\d+/,
    );
    expect(statement.text).toMatch(
      /FROM omni_project_tasks tasks[\s\S]*?WHERE tasks\.tenant_id = \$\d+[\s\S]*?owner_project\.actor_id = \$\d+/,
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
  });
});

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
