import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260916143000_p13_1_macos_native_platform.sql",
  import.meta.url,
);

describe("macOS native platform migration", () => {
  it("widens only the attested-session and push platform checks", async () => {
    const migration = await readFile(migrationUrl, "utf8");

    expect(migration).toContain("latest_version IS DISTINCT FROM 177");
    expect(migration).toContain("market_deterministic_backtests_v1");
    expect(migration).toContain(
      "platform COLLATE \"C\" IN ('android', 'ios', 'macos')",
    );
    expect(migration).toContain(
      "provider <> 'apns'\n    OR platform COLLATE \"C\" IN ('ios', 'macos')",
    );
    expect(migration).toContain(
      "ADD CONSTRAINT omni_mobile_push_registrations_platform_check_v2",
    );
    expect(migration).toContain(
      "ADD CONSTRAINT omni_mobile_push_registrations_apns_platform_check_v2",
    );
    expect(migration).toContain(
      "VALUES (\n  178,\n  'p13_1_macos_native_platform_v1',",
    );
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });
});
