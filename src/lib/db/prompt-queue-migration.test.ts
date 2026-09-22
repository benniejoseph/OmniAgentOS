import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260922170000_prompt_queue_runtime.sql",
);
const storePath = path.join(
  process.cwd(),
  "src/lib/command/prompt-queue-store.ts",
);

describe("prompt queue runtime migration v201", () => {
  it("is contiguous with v200 and uses the repository name digest", async () => {
    const source = await readFile(migrationPath, "utf8");
    const name = "prompt_queue_runtime_v1";
    const checksum = createHash("sha256").update(name).digest("hex");

    expect(checksum).toBe(
      "e9cd14ec6c526fbd0fbed097cbc8a535e92b60cfd6bae0785a0a0a6c3b584567",
    );
    expect(source).toContain("latest_version IS DISTINCT FROM 200");
    expect(source).toContain("name = 'notification_disposition_runtime_v1'");
    expect(source).toContain(
      "checksum = '99af5ab52a824c435e19e46f918755bfa549a1fecda22f9061940f9030c97c2b'",
    );
    expect(source).toContain("VALUES (\n  201,\n  'prompt_queue_runtime_v1'");
    expect(source).toContain(`'${checksum}'`);
  });

  it("keeps sealed prompts actor-private and grants no queue authority", async () => {
    const source = await readFile(migrationPath, "utf8");

    expect(source).toContain("sealed_prompt JSONB");
    expect(source).toContain("CHECK (NOT queue_grants_authority)");
    expect(source).toContain("ENABLE ROW LEVEL SECURITY");
    expect(source).toContain("FORCE ROW LEVEL SECURITY");
    expect(source).toContain("AS RESTRICTIVE FOR ALL TO PUBLIC");
    expect(source).toContain(
      "omni_actor_scope_v1_allows(tenant_id, owner_actor_id)",
    );
    expect(source).toContain("Prompt queue rows cannot be physically removed");
  });

  it("allows only the declared lifecycle columns and rejects broad mutation grants", async () => {
    const source = await readFile(migrationPath, "utf8");

    expect(source).toContain("privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')");
    expect(source).toContain("information_schema.role_column_grants");
    expect(source).toContain("column_name NOT IN (");
    expect(source).toContain("count(DISTINCT grant_row.column_name)");
    expect(source).toContain(") <> 18");
    expect(source).toContain(
      "REVOKE ALL ON TABLE public.omni_prompt_queue_items FROM omni_runtime",
    );
    expect(source).toContain(
      "REVOKE ALL ON TABLE public.omni_prompt_queue_items FROM omni_maintenance",
    );
    expect(source).toContain("AND NEW.state IN ('queued', 'paused')");
    expect(source).toContain("NEW.state = 'deleted'");
    expect(source).toContain("AND NEW.sealed_prompt IS NULL");
    expect(source).toContain("OLD.state = 'dispatching' AND NEW.state IN (");
  });

  it("permits only the explicit sealed deletion transition and clears failed state", async () => {
    const [migration, store] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(storePath, "utf8"),
    ]);

    expect(migration).toContain("NEW.state = 'deleted'");
    expect(migration).toContain("NEW.sealed_prompt IS NULL");
    expect(migration).toContain(
      "NEW.prompt_sha256, NEW.prompt_characters,\n        NEW.agent_pin, NEW.model_pin",
    );
    expect(store).toMatch(
      /SET state = 'deleted', sealed_prompt = NULL,[\s\S]*failure_code = NULL/,
    );
  });
});
