import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const file = "20261001090000_rls_scope_initplans.sql";
const source = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations", file),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("Row security scope initplan migration v211", () => {
  it("runs only on a database whose latest migration is the recorded v210", () => {
    const predecessor = manifest.find((migration) => migration.version === 210);

    expect(predecessor?.name).toBe("oauth_sync_backoff_v1");
    expect(source).toContain("IF latest_version IS DISTINCT FROM 210 OR (");
    expect(source).toContain(
      `WHERE version = 210\n      AND name = '${predecessor?.name}'\n`
        + `      AND checksum = '${predecessor?.checksum}'\n  ) <> 1 THEN\n`
        + "    RAISE EXCEPTION 'Row security scope initplan predecessor is invalid'\n"
        + "      USING ERRCODE = '55000';",
    );
  });

  it("records itself as v211 from its own file", () => {
    expect(manifest.find((migration) => migration.version === 211)).toMatchObject({
      name: "rls_scope_initplans_v1",
      file,
    });
    expect(source).toContain("VALUES (\n  211,\n  'rls_scope_initplans_v1',");
    expect(source.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("leaves the policies a writer checks word for word", () => {
    expect(source).toContain(
      "AND relation.relname <> 'omni_tenant_memory_data_right_requests'",
    );
  });
});
