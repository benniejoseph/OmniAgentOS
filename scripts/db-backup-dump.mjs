/**
 * Tables whose rows a backup leaves out. Their definitions, indexes, and
 * policies are still dumped, so a restore recreates them empty.
 *
 * omni_local_computer_commands holds what a Mac returned, a screenshot
 * included, until the run reads it, and a restored queued command must not
 * reach a Mac again.
 */
export const BACKUP_EXCLUDED_TABLE_DATA = Object.freeze([
  "omni_local_computer_commands",
]);

/** pg_dump's arguments for one snapshot of the public schema. */
export function backupDumpArguments({ snapshotId, file }) {
  return [
    "--format=custom",
    "--compress=9",
    "--schema=public",
    "--no-owner",
    "--no-acl",
    ...BACKUP_EXCLUDED_TABLE_DATA.map(
      (tableName) => `--exclude-table-data=public.${tableName}`,
    ),
    "--snapshot",
    snapshotId,
    "--file",
    file,
  ];
}

/**
 * The row counts a restore of the dump finds: the source's counts, with each
 * table whose rows are left out counted as empty.
 */
export function dumpedTableRowCounts(sourceTableRowCounts) {
  return Object.fromEntries(
    Object.entries(sourceTableRowCounts).map(([tableName, count]) => [
      tableName,
      BACKUP_EXCLUDED_TABLE_DATA.includes(tableName) ? "0" : count,
    ]),
  );
}
