import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSqlMigrationFile, readSqlMigrationFile } from "./sql-migration-files";

describe("Assistant modes migration267", () => {
  it("pins its executable bytes and only extends the durable queue mode constraint", async () => {
    const manifest = JSON.parse(readFileSync("schema-migrations.json", "utf8")) as { version: number; name: string; checksum: string; file: string; sha256: string }[];
    const entry = manifest.find(row => row.version === 267)!;
    const source = readFileSync(`supabase/migrations/${entry.file}`, "utf8");
    const result = await readSqlMigrationFile({ file: entry.file, sha256: entry.sha256, migrations: [entry] });
    expect(result.ledger).toEqual([{ version: 267, name: entry.name, checksum: entry.checksum }]);
    expect(source).toContain("latest_version IS DISTINCT FROM 266");
    const ddl = parseSqlMigrationFile(entry.file, source).statements.map(statement => statement.replace(/^--[^\n]*(?:\n|$)/gm, "").trim()).filter(statement => /^(?:ALTER|CREATE|DROP|UPDATE|DELETE|GRANT|REVOKE)\b/.test(statement));
    expect(ddl).toHaveLength(2);
    expect(ddl.every(statement => statement.startsWith("ALTER TABLE public.omni_prompt_queue_items"))).toBe(true);
    expect(source).toContain("'orchestrate', 'research', 'execute', 'learn', 'chat', 'cowork', 'coding'");
    expect(source).not.toContain("NOT VALID");
  });
});
