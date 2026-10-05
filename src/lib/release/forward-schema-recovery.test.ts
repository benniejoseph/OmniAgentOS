import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseForwardSchemaRecovery,
  validateForwardSchemaDatabaseVerification,
  validateForwardSchemaPriorArtifact,
} from "../../../scripts/forward-schema-recovery.mjs";

const candidateRevision = "b".repeat(40);
const previousRevision = "a".repeat(40);
const baseUrl = "https://asael.bennierichard.com";
const now = new Date("2026-10-06T12:00:00.000Z");
const instant = (ageMs = 0) => new Date(now.getTime() - ageMs).toISOString();
const directories: string[] = [];
const gateIds = [
  "deployment_environment", "internal_smoke_auth", "openai_us_egress_gateway",
  "openai_provider", "cron_auth", "runtime_database_role", "maintenance_database_role",
  "dedicated_worker", "tenant_isolation_database", "latest_tenant_isolation_eval",
  "observability_slo", "agent_error_budget", "eval_report_signing",
];

function candidate() {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "asael-forward-schema-"));
  directories.push(repositoryRoot);
  const migrationRoot = path.join(repositoryRoot, "supabase", "migrations");
  mkdirSync(migrationRoot, { recursive: true });
  const migrationFile = path.join(migrationRoot, "20261005000000_candidate.sql");
  const sql = `-- Synthetic migration bytes only.\nSELECT 1;\nINSERT INTO omni_schema_version VALUES (3, 'synthetic_three', '${"0".repeat(64)}');\n`;
  const checksum = createHash("sha256").update(sql).digest("hex");
  writeFileSync(migrationFile, sql.replaceAll("0".repeat(64), checksum));
  const manifest = [
    { version: 1, name: "synthetic_one", checksum: "1".repeat(64) },
    { version: 2, name: "synthetic_two", checksum: "2".repeat(64) },
    { version: 3, name: "synthetic_three", checksum, sha256: checksum, file: path.basename(migrationFile) },
  ];
  const manifestPath = path.join(repositoryRoot, "schema-migrations.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const shape = {
    previousRevision, candidateRevision, migrationVersion: 3, migrationChecksum: checksum,
    unclassifiedTables: ["omni_native_openapi_import_preparations"],
  };
  const options = { candidateRevision, manifestPath, repositoryRoot };
  const parse = (value: unknown = shape) => parseForwardSchemaRecovery(JSON.stringify(value), options);
  const pin = parse();
  if (!pin) throw new Error("Synthetic pin was absent.");
  return { shape, options, pin, parse, migrationFile, manifest };
}

function priorArtifact() {
  const gates = gateIds.map((id) => ({
    id, name: id === "tenant_isolation_database" ? "Database tenant isolation" : id,
    status: id === "tenant_isolation_database" ? "fail" : "pass",
    summary: id === "tenant_isolation_database" ? "Tenant isolation schema evidence is incomplete." : "Ready.",
  }));
  return {
    httpStatus: 200, generatedAt: instant(1000), reportCheckedAt: instant(2000), baseUrl,
    deployment: { commitSha: previousRevision, environment: "production", provider: "vercel" },
    tenantIsolationStatus: "degraded",
    previousReleaseCompatibility: undefined as { missingAgentErrorBudget: boolean } | undefined,
    gates,
    releaseGate: {
      approved: false, status: "blocked",
      reasons: ["Database tenant isolation: Tenant isolation schema evidence is incomplete."], warnings: [] as string[],
      summary: { total: gates.length, passed: gates.length - 1, warnings: 0, failures: 1 },
    },
    tenantIsolation: {
      expectedTables: 10, protectedTables: 10, failingTables: 0, childTables: 2,
      unclassifiedTables: ["omni_native_openapi_import_preparations"],
      missingTables: [] as string[], missingTenantColumns: [] as string[], rlsDisabled: [] as string[],
      forceRlsDisabled: [] as string[], missingPolicies: [] as string[],
    },
  };
}

function completion() {
  return { level: "info", event: "database_verification_completed", migrations: 3,
    tenantTables: 11, completedAt: instant(1000) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("explicit forward-schema recovery pin", () => {
  it("is absent by default and freezes a pin matching real manifest and SQL bytes", () => {
    const c = candidate();
    for (const raw of [undefined, null, "", "  "]) expect(parseForwardSchemaRecovery(raw, c.options)).toBeUndefined();
    expect(c.pin).toEqual(c.shape);
    expect(Object.isFrozen(c.pin)).toBe(true);
    expect(Object.isFrozen(c.pin.unclassifiedTables)).toBe(true);
  });

  it("accepts the checked-in manifest and self-checksummed SQL using the migration runner's digest", () => {
    const repositoryRoot = process.cwd();
    const manifestPath = path.join(repositoryRoot, "schema-migrations.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const latest = manifest.at(-1);
    const bytes = readFileSync(path.join(repositoryRoot, "supabase", "migrations", latest.file));
    expect(createHash("sha256").update(bytes).digest("hex")).not.toBe(latest.checksum);
    const shape = { previousRevision, candidateRevision, migrationVersion: latest.version,
      migrationChecksum: latest.checksum, unclassifiedTables: ["omni_native_openapi_import_preparations"] };
    expect(parseForwardSchemaRecovery(JSON.stringify(shape), { candidateRevision, manifestPath, repositoryRoot })).toEqual(shape);
  });

  it("rejects an altered embedded ledger checksum or invalid UTF-8", () => {
    const c = candidate();
    writeFileSync(c.migrationFile, readFileSync(c.migrationFile, "utf8").replaceAll(c.shape.migrationChecksum, "f".repeat(64)));
    expect(() => c.parse()).toThrow("migration bytes");
    writeFileSync(c.migrationFile, Buffer.from([0xff, 0xfe]));
    expect(() => c.parse()).toThrow("valid UTF-8");
  });

  it.each([
    ["candidate identity", { candidateRevision: "c".repeat(40) }],
    ["short prior revision", { previousRevision: "abc" }],
    ["same revision", { previousRevision: candidateRevision }],
    ["unknown field", { ignoreOtherGates: true }],
    ["missing migration", { migrationVersion: undefined }],
    ["fractional migration", { migrationVersion: 3.5 }],
    ["older migration", { migrationVersion: 2 }],
    ["future migration", { migrationVersion: 4 }],
    ["wrong checksum", { migrationChecksum: "f".repeat(64) }],
    ["empty table list", { unclassifiedTables: [] }],
    ["too many tables", { unclassifiedTables: ["omni_a", "omni_b", "omni_c", "omni_d", "omni_e"] }],
    ["duplicate tables", { unclassifiedTables: ["omni_a", "omni_a"] }],
    ["unsorted tables", { unclassifiedTables: ["omni_b", "omni_a"] }],
    ["foreign table", { unclassifiedTables: ["other_table"] }],
    ["unsafe table", { unclassifiedTables: ["omni_a;SELECT"] }],
    ["overlong table", { unclassifiedTables: [`omni_${"a".repeat(59)}`] }],
  ] as const)("rejects %s", (_label, changed) => {
    const c = candidate();
    expect(() => c.parse({ ...c.shape, ...changed })).toThrow("Forward-schema recovery:");
  });

  it("rejects malformed, oversized and repeated-key JSON without echoing input", () => {
    const c = candidate();
    for (const raw of ["credential-secret-is-not-json", "x".repeat(8193),
      JSON.stringify(c.shape).replace("{", `{"previousRevision":"${previousRevision}",`),
      JSON.stringify(c.shape).replace("{", `{"previous\\u0052evision":"${previousRevision}",`)]) {
      expect(() => parseForwardSchemaRecovery(raw, c.options)).toThrow("Forward-schema recovery:");
      try { parseForwardSchemaRecovery(raw, c.options); } catch (error) {
        expect(String(error)).not.toContain("credential-secret");
      }
    }
  });

  it("rejects modified migration bytes, a changed manifest checksum or a ledger gap", () => {
    const c = candidate();
    writeFileSync(c.migrationFile, "different SQL bytes");
    expect(() => c.parse()).toThrow("migration bytes");
    c.manifest[2].sha256 = "f".repeat(64);
    writeFileSync(c.options.manifestPath, JSON.stringify(c.manifest));
    expect(() => c.parse()).toThrow("latest candidate migration");
    writeFileSync(c.options.manifestPath, JSON.stringify(c.manifest.slice(1)));
    expect(() => c.parse()).toThrow("ordered and contiguous");
  });

  it("rejects a SQL path or symlink escaping the candidate migration directory", () => {
    const c = candidate();
    c.manifest[2].file = "../outside.sql";
    writeFileSync(c.options.manifestPath, JSON.stringify(c.manifest));
    expect(() => c.parse()).toThrow("bounded SQL file");
    const outside = path.join(c.options.repositoryRoot, "outside.sql");
    writeFileSync(outside, readFileSync(c.migrationFile));
    rmSync(c.migrationFile);
    symlinkSync(outside, c.migrationFile);
    c.manifest[2].file = path.basename(c.migrationFile);
    writeFileSync(c.options.manifestPath, JSON.stringify(c.manifest));
    expect(() => c.parse()).toThrow("migration file must belong");
  });
});

describe("prior-release schema classification evidence", () => {
  const options = { baseUrl, previousRevision, now };
  it("admits exactly the known gap while retaining the original blocked report", () => {
    const { pin } = candidate(), artifact = priorArtifact();
    const before = structuredClone(artifact);
    expect(validateForwardSchemaPriorArtifact(artifact, pin, options)).toEqual({ priorExpectedTables: 10 });
    expect(artifact).toEqual(before);
    expect(artifact.releaseGate.approved).toBe(false);
  });

  it("permits an absent budget only with the existing exact compatibility marker", () => {
    const { pin } = candidate(), artifact = priorArtifact();
    artifact.gates = artifact.gates.filter((gate) => gate.id !== "agent_error_budget");
    artifact.releaseGate.summary.total--;
    artifact.releaseGate.summary.passed--;
    expect(() => validateForwardSchemaPriorArtifact(artifact, pin, options)).toThrow("budget absence");
    artifact.previousReleaseCompatibility = { missingAgentErrorBudget: true };
    expect(validateForwardSchemaPriorArtifact(artifact, pin, options)).toEqual({ priorExpectedTables: 10 });
    artifact.previousReleaseCompatibility.missingAgentErrorBudget = false;
    expect(() => validateForwardSchemaPriorArtifact(artifact, pin, options)).toThrow("budget absence");
  });

  it.each(gateIds.filter((id) => id !== "tenant_isolation_database"))("never exempts another failed or warning gate: %s", (id) => {
    const { pin } = candidate();
    for (const status of ["fail", "warn", "unknown"]) {
      const artifact = priorArtifact();
      artifact.gates.find((gate) => gate.id === id)!.status = status;
      expect(() => validateForwardSchemaPriorArtifact(artifact, pin, options)).toThrow("only the prior database isolation gate");
    }
  });

  const corruptions: Array<[string, (artifact: ReturnType<typeof priorArtifact>) => void]> = [
    ["HTTP failure", (a) => { a.httpStatus = 503; }],
    ["wrong origin", (a) => { a.baseUrl = "https://other.example"; }],
    ["wrong deployment", (a) => { a.deployment.commitSha = candidateRevision; }],
    ["stale report", (a) => { a.reportCheckedAt = instant(300001); }],
    ["stale artifact", (a) => { a.generatedAt = instant(300001); }],
    ["future report", (a) => { a.reportCheckedAt = instant(-1); }],
    ["future artifact", (a) => { a.generatedAt = instant(-1); }],
    ["report after artifact", (a) => { a.reportCheckedAt = instant(500); }],
    ["noncanonical timestamp", (a) => { a.reportCheckedAt = "2026-10-06T12:00:00+00:00"; }],
    ["duplicate gate", (a) => { a.gates.push({ ...a.gates[0] }); }],
    ["missing core gate", (a) => { a.gates = a.gates.filter((gate) => gate.id !== "runtime_database_role"); }],
    ["approved report", (a) => { a.releaseGate.approved = true; }],
    ["passing report", (a) => { a.releaseGate.status = "passed"; }],
    ["extra reason", (a) => { a.releaseGate.reasons.push("Another failure"); }],
    ["wrong reason", (a) => { a.releaseGate.reasons[0] = "Other: Unknown"; }],
    ["warning", (a) => { a.releaseGate.warnings.push("Something changed"); }],
    ["wrong gate totals", (a) => { a.releaseGate.summary.failures = 0; }],
    ["false absence marker", (a) => { a.previousReleaseCompatibility = { missingAgentErrorBudget: true }; }],
    ["passing isolation", (a) => { a.tenantIsolationStatus = "passing"; }],
    ["unprotected table", (a) => { a.tenantIsolation.protectedTables--; }],
    ["failing table", (a) => { a.tenantIsolation.failingTables = 1; }],
    ["wrong unknown table", (a) => { a.tenantIsolation.unclassifiedTables = ["omni_other"]; }],
    ["missing table", (a) => { a.tenantIsolation.missingTables = ["omni_other"]; }],
    ["missing tenant column", (a) => { a.tenantIsolation.missingTenantColumns = ["omni_other"]; }],
    ["disabled RLS", (a) => { a.tenantIsolation.rlsDisabled = ["omni_other"]; }],
    ["disabled forced RLS", (a) => { a.tenantIsolation.forceRlsDisabled = ["omni_other"]; }],
    ["missing policy", (a) => { a.tenantIsolation.missingPolicies = ["omni_other"]; }],
  ];
  it.each(corruptions)("rejects %s", (_label, mutate) => {
    const { pin } = candidate(), artifact = priorArtifact();
    mutate(artifact);
    expect(() => validateForwardSchemaPriorArtifact(artifact, pin, options)).toThrow("Forward-schema recovery:");
  });

  it("requires the observed previous revision and permits the exact five-minute boundary", () => {
    const { pin } = candidate(), artifact = priorArtifact();
    expect(() => validateForwardSchemaPriorArtifact(artifact, pin, { ...options, previousRevision: "c".repeat(40) })).toThrow("previous revision");
    artifact.reportCheckedAt = instant(300000);
    artifact.generatedAt = instant(300000);
    expect(validateForwardSchemaPriorArtifact(artifact, pin, options)).toEqual({ priorExpectedTables: 10 });
  });
});

describe("fresh candidate database verification", () => {
  const options = { priorExpectedTables: 10, now };
  it("accepts one strict fresh completion behind npm banners", () => {
    const { pin } = candidate(), result = completion();
    const stdout = `\n> db:verify\n> tsx scripts/db-verify.ts\n\n${JSON.stringify(result)}\n`;
    expect(validateForwardSchemaDatabaseVerification(stdout, pin, options)).toEqual({
      migrations: 3, tenantTables: 11, completedAt: result.completedAt,
    });
  });

  it.each([
    ["wrong migration count", { migrations: 2 }],
    ["unknown future migration", { migrations: 4 }],
    ["wrong tenant count", { tenantTables: 10 }],
    ["extra unexplained table", { tenantTables: 12 }],
    ["stale completion", { completedAt: instant(300001) }],
    ["future completion", { completedAt: instant(-1) }],
    ["error level", { level: "error" }],
    ["unknown completion fields", { skippedPolicy: true }],
  ] as const)("rejects %s", (_label, changed) => {
    const { pin } = candidate();
    expect(() => validateForwardSchemaDatabaseVerification(JSON.stringify({ ...completion(), ...changed }), pin, options)).toThrow("Forward-schema recovery:");
  });

  it("rejects absent, duplicate, malformed, oversized and contradictory output", () => {
    const { pin } = candidate(), completed = JSON.stringify(completion());
    for (const stdout of ["", "> banner only", `${completed}\n${completed}`, "{broken", "x".repeat(262145),
      `${JSON.stringify({ level: "error", event: "database_verification_failed" })}\n${completed}`]) {
      expect(() => validateForwardSchemaDatabaseVerification(stdout, pin, options)).toThrow("Forward-schema recovery:");
    }
  });
});
