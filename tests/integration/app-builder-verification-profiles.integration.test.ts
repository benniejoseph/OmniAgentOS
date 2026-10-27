/** Exercises the installed266 row check, with no production or app-row writes. */
import fs from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE === "1" ? describe : describe.skip;
const web = [{ command: "lint_focused" }, { command: "typecheck_direct" }, { command: "test_focused", purpose: "regression" }, { command: "test_focused", purpose: "adjacent" }];
const native = [{ command: "macos_analyze" }, { command: "macos_test_focused", purpose: "regression" }, { command: "macos_test_focused", purpose: "adjacent" }, { command: "macos_build" }];

enabled("installed Builder verification profiles row constraint", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    const address = process.env.ASAEL_SELF_IMPROVEMENT_CANDIDATE_DATABASE_URL;
    if (!address) throw new Error("Provide the disposable loopback candidate database URL.");
    const url = new URL(address);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/asael_self_improvement_candidate") throw new Error("Only the disposable loopback candidate is allowed.");
    admin = postgres(address, { ssl: false, prepare: false, max: 1, onnotice: () => undefined });
    const manifest = JSON.parse(fs.readFileSync("schema-migrations.json", "utf8")) as Array<{ version: number; name: string; checksum: string }>;
    const expected = manifest.find(row => row.version === 266)!;
    expect((await admin`SELECT version,name,checksum FROM omni_schema_version ORDER BY version DESC LIMIT 1`)[0]).toEqual({ version: 266, name: expected.name, checksum: expected.checksum });
    const constraint = await admin`SELECT convalidated FROM pg_constraint WHERE conrelid='public.omni_app_builder_verifications'::regclass AND conname='omni_app_builder_verifications_row_check'`;
    expect(constraint[0].convalidated).toBe(true);
  });
  afterAll(async () => { await admin?.end(); });

  it("accepts legacy length-only and exact four-check profiles, rejects malformed profiles and retains other guards", async () => {
    await admin.begin(async sql => {
      // LIKE copies the actual installed CHECK and NOT NULL constraints. It
      // neither changes the maintained table nor relaxes a fixture constraint.
      await sql`CREATE TEMPORARY TABLE verification_profile_probe (LIKE public.omni_app_builder_verifications INCLUDING CONSTRAINTS) ON COMMIT DROP`;
      const original = await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.omni_app_builder_verifications'::regclass AND conname='omni_app_builder_verifications_row_check'`;
      const copied = await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='pg_temp.verification_profile_probe'::regclass AND conname='omni_app_builder_verifications_row_check'`;
      expect(copied[0].definition).toBe(original[0].definition);
      const insert = (checks: unknown, options: { id?: string; owner?: string; status?: string; workspace?: string; browser?: unknown; future?: boolean } = {}) => sql.savepoint(async tx => tx`
        INSERT INTO verification_profile_probe(schema_version,id,tenant_id,owner_actor_id,project_id,session_id,checkpoint_id,contract_version,workspace_sha256,status,checks,browser_evidence,created_at)
        VALUES(1,${options.id ?? `app_build_verification_${"a".repeat(48)}`},'synthetic',${options.owner ?? "actor:synthetic"},'project',${`app_build_${"b".repeat(48)}`},${`app_build_checkpoint_${"c".repeat(48)}`},'app-builder-verification:1',${options.workspace || "d".repeat(64)},${options.status || "passed"},${JSON.stringify(checks)}::text::jsonb,${JSON.stringify(options.browser ?? {})}::text::jsonb,NOW() + ${options.future ? "1 hour" : "0 seconds"}::interval)`);
      for (const checks of [[{ command: "lint" }, { command: "typecheck" }], [{ command: "typecheck" }, { command: "lint" }], [null, 42], web, native]) await expect(insert(checks)).resolves.toBeDefined();
      for (const checks of [[], web.slice(0, 3), [...web, web[0]], [...web].reverse(), [...native].reverse(), [web[0], web[1], web[2], web[2]], [native[0], native[1], native[2], web[0]], web.map(({ command }) => ({ command })), {}, null]) await expect(insert(checks)).rejects.toMatchObject({ code: "23514" });
      for (const options of [{ id: "invalid" }, { owner: "" }, { status: "unknown" }, { workspace: "invalid" }, { browser: [] }, { future: true }]) await expect(insert(web, options)).rejects.toMatchObject({ code: "23514" });
      const large = web.map(check => ({ ...check, output: Array.from({ length: 3000 }, (_, index) => `${index.toString(16)}${Math.imul(index, 2654435761).toString(16)}`).join(":") }));
      await expect(insert(large)).rejects.toMatchObject({ code: "23514" });
    });
  });
});
