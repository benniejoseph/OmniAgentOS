import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createOpaqueToken } from "@/lib/auth/crypto";

const file = "20260928100000_mobile_refresh_rotation_retry.sql";
const source = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations", file),
  "utf8",
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "schema-migrations.json"), "utf8"),
) as Array<{ version: number; name: string; checksum: string; file?: string }>;

describe("mobile refresh rotation retry migration v209", () => {
  it("runs only on a database whose latest migration is the recorded v208", () => {
    const predecessor = manifest.find((migration) => migration.version === 208);

    expect(predecessor?.name).toBe("schema_catalog_convergence_v1");
    expect(source).toContain("IF latest_version IS DISTINCT FROM 208 OR (");
    expect(source).toContain(
      `WHERE version = 208\n      AND name = '${predecessor?.name}'\n`
        + `      AND checksum = '${predecessor?.checksum}'\n  ) <> 1 THEN\n`
        + "    RAISE EXCEPTION 'Mobile refresh rotation retry predecessor is invalid'\n"
        + "      USING ERRCODE = '55000';",
    );
  });

  it("accepts every rotation key the server generates", () => {
    const pattern = /refresh_rotation_key ~ '([^']+)'/.exec(source)?.[1];

    expect(pattern).toBe("^[A-Za-z0-9_-]{43}$");
    for (let index = 0; index < 64; index += 1) {
      expect(createOpaqueToken()).toMatch(new RegExp(pattern ?? "$^"));
    }
  });

  it("records itself as v209 from its own file", () => {
    expect(manifest.find((migration) => migration.version === 209)).toMatchObject({
      name: "mobile_refresh_rotation_retry_v1",
      file,
    });
    expect(source).toContain("VALUES (\n  209,\n  'mobile_refresh_rotation_retry_v1',");
    expect(source.trimEnd()).toMatch(/COMMIT;$/);
  });
});
