import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const file = "20260929120000_oauth_sync_backoff.sql";
const source = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations", file),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("OAuth sync backoff migration v210", () => {
  it("runs only on a database whose latest migration is the recorded v209", () => {
    const predecessor = manifest.find((migration) => migration.version === 209);

    expect(predecessor?.name).toBe("mobile_refresh_rotation_retry_v1");
    expect(source).toContain("IF latest_version IS DISTINCT FROM 209 OR (");
    expect(source).toContain(
      `WHERE version = 209\n      AND name = '${predecessor?.name}'\n`
        + `      AND checksum = '${predecessor?.checksum}'\n  ) <> 1 THEN\n`
        + "    RAISE EXCEPTION 'OAuth sync backoff predecessor is invalid'\n"
        + "      USING ERRCODE = '55000';",
    );
  });

  it("records itself as v210 from its own file", () => {
    expect(manifest.find((migration) => migration.version === 210)).toMatchObject({
      name: "oauth_sync_backoff_v1",
      file,
    });
    expect(source).toContain("VALUES (\n  210,\n  'oauth_sync_backoff_v1',");
    expect(source.trimEnd()).toMatch(/COMMIT;$/);
  });
});
