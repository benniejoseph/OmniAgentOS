import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const file = "20261001120000_operation_job_quarantine.sql";
const source = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations", file),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("operation job quarantine migration v212", () => {
  it("runs only on a database whose latest migration is the recorded v211", () => {
    const predecessor = manifest.find((migration) => migration.version === 211);

    expect(predecessor?.name).toBe("rls_scope_initplans_v1");
    expect(source).toContain("IF latest_version IS DISTINCT FROM 211 OR (");
    expect(source).toContain(
      `WHERE version = 211\n      AND name = '${predecessor?.name}'\n`
        + `      AND checksum = '${predecessor?.checksum}'\n  ) <> 1 THEN\n`
        + "    RAISE EXCEPTION 'Operation job quarantine predecessor is invalid'\n"
        + "      USING ERRCODE = '55000';",
    );
  });

  it("adds a non-negative lapse count that every existing row starts at 0", () => {
    expect(source).toContain(
      "ADD COLUMN IF NOT EXISTS lease_lapses INTEGER NOT NULL DEFAULT 0;",
    );
    expect(source).toContain("AND column_default = '0'\n  ) <> 1 THEN");
    expect(source).toContain(
      "ADD CONSTRAINT omni_operation_jobs_lease_lapses_check CHECK (\n"
        + "    lease_lapses >= 0\n  ) NOT VALID;",
    );
  });

  it("records itself as v212 from its own file", () => {
    expect(manifest.find((migration) => migration.version === 212)).toMatchObject({
      name: "operation_job_quarantine_v1",
      file,
    });
    expect(source).toContain("VALUES (\n  212,\n  'operation_job_quarantine_v1',");
    expect(source.trimEnd()).toMatch(/COMMIT;$/);
  });
});
