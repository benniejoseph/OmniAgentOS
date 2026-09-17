import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260917110000_p13_3_local_computer_runtime.sql",
  import.meta.url,
);
const runBindingMigrationUrl = new URL(
  "../../../supabase/migrations/20260917150000_p13_3_local_computer_run_binding.sql",
  import.meta.url,
);
const openUrlActionMigrationUrl = new URL(
  "../../../supabase/migrations/20260917193000_p13_3_local_computer_open_url_action.sql",
  import.meta.url,
);
const developmentSchemaUrl = new URL(
  "../db/local-computer-schema.ts",
  import.meta.url,
);
const databaseClientUrl = new URL("../db/client.ts", import.meta.url);

const COMMAND_ACTIONS = [
  "observe",
  "list_apps",
  "activate_app",
  "press",
  "click",
  "type",
  "key",
  "scroll",
  "open_url",
];

function commandRowCheck(source: string, startAt = 0) {
  const marker = "omni_local_computer_commands_row_check CHECK (COALESCE(";
  const start = source.indexOf(marker, startAt);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const end = source.indexOf(", FALSE))", bodyStart);
  expect(end).toBeGreaterThan(bodyStart);
  return source
    .slice(bodyStart, end)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function commandActions(rowCheck: string) {
  const match = rowCheck.match(/action IN \(([^)]+)\)/);
  expect(match).not.toBeNull();
  return [...(match?.[1].matchAll(/'([^']+)'/g) || [])].map(
    (action) => action[1],
  );
}

describe("local Computer Use migration", () => {
  it("adds device-bound actor-private routing without a helper credential", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("latest_version IS DISTINCT FROM 178");
    expect(migration).toContain("omni_local_computer_devices");
    expect(migration).toContain("omni_local_computer_sessions");
    expect(migration).toContain("omni_local_computer_commands");
    expect(migration).toContain("native_contract_version >= 11");
    expect(migration).toContain("input_sha256 TEXT NOT NULL");
    expect(migration).not.toContain("input JSONB NOT NULL");
    expect(migration).toContain("pg_column_size(result) <= 2097152");
    expect(migration).toContain("omni_local_computer_commands_actor_scope");
    expect(migration).toContain("VALUES (\n  179,\n  'p13_3_local_computer_runtime_v1'");
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("binds native sessions to exact typed runs and indexes screenshot expiry", async () => {
    const migration = await readFile(runBindingMigrationUrl, "utf8");

    expect(migration).toContain("latest_version IS DISTINCT FROM 179");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS run_id TEXT");
    expect(migration).toContain("event.type = 'run.scope_bound'");
    expect(migration).toContain("omni_local_computer_sessions_run_idx");
    expect(migration).toContain(
      "omni_local_computer_sessions_mobile_session_fkey",
    );
    expect(migration).toContain(
      "tenant_id, owner_actor_id, device_id\n  ) REFERENCES public.omni_local_computer_devices",
    );
    expect(migration).toContain(
      "omni_local_computer_commands_observation_expiry_idx",
    );
    expect(migration).toContain(
      "VALUES (\n  180,\n  'p13_3_local_computer_run_binding_v1'",
    );
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("adds only open_url to the validated command action boundary", async () => {
    const [runtimeMigration, migration, developmentSchema] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(openUrlActionMigrationUrl, "utf8"),
      readFile(developmentSchemaUrl, "utf8"),
    ]);

    const originalCheck = commandRowCheck(runtimeMigration);
    const repairedCheck = commandRowCheck(migration);
    const developmentRepairStart = developmentSchema.indexOf(
      "export async function ensureLocalComputerOpenUrlActionV1",
    );
    const developmentCheck = commandRowCheck(
      developmentSchema,
      developmentRepairStart,
    );

    expect(commandActions(originalCheck)).toEqual(COMMAND_ACTIONS.slice(0, -1));
    expect(commandActions(repairedCheck)).toEqual(COMMAND_ACTIONS);
    expect(repairedCheck.replace(", 'open_url'", "")).toBe(originalCheck);
    expect(developmentCheck).toBe(repairedCheck);
    expect(migration).toContain(
      "ADD CONSTRAINT omni_local_computer_commands_row_check CHECK",
    );
    expect(migration).toContain(", FALSE)) NOT VALID;");
    expect(migration).toContain(
      "VALIDATE CONSTRAINT omni_local_computer_commands_row_check",
    );
  });

  it("orders the open_url repair directly after the retirement boundary", async () => {
    const [migration, databaseClient] = await Promise.all([
      readFile(openUrlActionMigrationUrl, "utf8"),
      readFile(databaseClientUrl, "utf8"),
    ]);

    expect(migration).toContain("latest_version IS DISTINCT FROM 181");
    expect(migration).toContain("version = 181");
    expect(migration).toContain("'isolated_browser_runtime_retirement_v1'");
    expect(migration).toContain(
      "'2d8bfc80ac843fe49ca79024022b873f5046a68822892ace7ff78d393025cf4d'",
    );
    expect(migration).toContain(
      "VALUES (\n  182,\n  'p13_3_local_computer_open_url_action_v1'",
    );
    expect(migration).toContain(
      "'46a2975c9099d954bc7f7ff6aa537076f14f8dce274e53f33826a38471d1f5e4'",
    );
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
    expect(databaseClient).toContain(
      "...databaseSchemaMigrations[181],\n      up: ensureLocalComputerOpenUrlActionV1",
    );
  });
});
