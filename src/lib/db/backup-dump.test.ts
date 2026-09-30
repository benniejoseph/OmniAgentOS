import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  BACKUP_EXCLUDED_TABLE_DATA,
  backupDumpArguments,
  dumpedTableRowCounts,
} from "../../../scripts/db-backup-dump.mjs";

describe("database backup dump", () => {
  it("dumps the public schema at the snapshot without the Mac's command rows", () => {
    expect(
      backupDumpArguments({
        snapshotId: "00000003-0000001B-1",
        file: "/secure/omniagent.dump.partial-7",
      }),
    ).toEqual([
      "--format=custom",
      "--compress=9",
      "--schema=public",
      "--no-owner",
      "--no-acl",
      "--exclude-table-data=public.omni_local_computer_commands",
      "--snapshot",
      "00000003-0000001B-1",
      "--file",
      "/secure/omniagent.dump.partial-7",
    ]);
    expect(Object.isFrozen(BACKUP_EXCLUDED_TABLE_DATA)).toBe(true);
  });

  it("expects a restore to find each left-out table empty", () => {
    const source = {
      omni_auth_tenants: "2",
      omni_local_computer_commands: "12",
      omni_local_computer_sessions: "4",
      omni_threads: "0",
    };

    const dumped = dumpedTableRowCounts(source);

    expect(dumped).toEqual({
      omni_auth_tenants: "2",
      omni_local_computer_commands: "0",
      omni_local_computer_sessions: "4",
      omni_threads: "0",
    });
    // The restore drill compares the inventories as JSON text.
    expect(Object.keys(dumped)).toEqual(Object.keys(source));
    expect(source.omni_local_computer_commands).toBe("12");
  });

  it("is what the backup script runs and records", async () => {
    const script = await readFile("scripts/db-backup.mjs", "utf8");

    for (const wiring of [
      'await run("pg_dump", backupDumpArguments({\n' +
        "          snapshotId: snapshot.snapshot_id,\n" +
        "          file: temporaryOutput,\n",
      "excludedTableData: BACKUP_EXCLUDED_TABLE_DATA,\n",
      "tableRowCounts: dumpedTableRowCounts(sourceTableRowCounts),\n",
    ]) {
      expect(script).toContain(wiring);
    }
    expect(script).not.toContain('"--format=custom"');
  });
});
