import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertBuilderBranchName, builderCheckpointCreateInputSchema, builderCheckpointRestoreInputSchema, builderCommandInputSchema, builderDeliveryInputSchema, builderFileUpdateInputSchema, builderPreviewDeploymentInputSchema, builderPreviewDeploymentRefreshInputSchema, builderProductionReleaseInputSchema, builderProductionReleasePreviewInputSchema, builderProductionReleaseRefreshInputSchema, safeBuilderRelativePath } from "@/lib/app-builder/contracts";
import { scanBuilderFilesForSecrets } from "@/lib/app-builder/secret-scan";
import { appBuilderStarterTemplate } from "@/lib/app-builder/templates";
import { APP_SERVICE_OPERATION_CONTRACTS, MAIN_AGENT_APP_SERVICE_BINDINGS } from "@/lib/app-services/registry";
import { databaseSchemaMigrations } from "@/lib/db/client";
import { modelAssignmentRoleContracts } from "@/lib/settings/model-assignment-contract";
import { FIRST_PARTY_APP_TOOLS } from "@/lib/tools/app-registry";

describe("project App Builder boundary", () => {
  it("accepts application files and rejects dependency, credential, generated, and traversal paths", () => {
    expect(safeBuilderRelativePath("app/page.tsx")).toBe("app/page.tsx");
    expect(safeBuilderRelativePath("components/Product card.tsx")).toBe("components/Product card.tsx");
    for (const value of ["../secret", "/etc/passwd", ".env", "node_modules/pkg/index.js", ".next/server/app.js", ".git/config", "app/../../secret"]) {
      expect(() => safeBuilderRelativePath(value), value).toThrow();
    }
  });

  it("requires exact file revisions and exposes only fixed verification commands", () => {
    expect(builderFileUpdateInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      path: "app/page.tsx",
      expectedSha256: "b".repeat(64),
      content: "export default function Page() { return null }",
    }).success).toBe(true);
    expect(builderCommandInputSchema.safeParse({ projectId: "project-1", sessionId: `app_build_${"a".repeat(48)}`, command: "rm -rf" }).success).toBe(false);
    expect(builderCheckpointCreateInputSchema.safeParse({ projectId: "project-1", sessionId: `app_build_${"a".repeat(48)}`, expectedSessionRevision: 4, reason: "before_forge", label: "Before Forge" }).success).toBe(true);
    expect(builderCheckpointRestoreInputSchema.safeParse({ projectId: "project-1", sessionId: `app_build_${"a".repeat(48)}`, checkpointId: `app_build_checkpoint_${"b".repeat(48)}`, expectedSessionRevision: 5 }).success).toBe(true);
    expect(assertBuilderBranchName("asael/research-dashboard-a1b2c3d4")).toBe("asael/research-dashboard-a1b2c3d4");
    for (const branch of ["refs/heads/main", "../main", "feature//unsafe", "feature/"]) {
      expect(() => assertBuilderBranchName(branch), branch).toThrow();
    }
    expect(builderDeliveryInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      repositoryBindingId: `app_build_repository_${"b".repeat(48)}`,
      expectedBindingRevision: 1,
      checkpointId: `app_build_checkpoint_${"c".repeat(48)}`,
      verificationId: `app_build_verification_${"d".repeat(48)}`,
      branchName: "asael/research-dashboard-a1b2c3d4",
      title: "Build research dashboard",
      body: "Review the responsive workspace.",
      draft: true,
    }).success).toBe(true);
    expect(builderPreviewDeploymentInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      checkpointId: `app_build_checkpoint_${"c".repeat(48)}`,
      verificationId: `app_build_verification_${"d".repeat(48)}`,
      repositoryDeliveryId: `app_build_delivery_${"e".repeat(48)}`,
    }).success).toBe(true);
    expect(builderPreviewDeploymentRefreshInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      deploymentId: `app_build_deployment_${"f".repeat(48)}`,
    }).success).toBe(true);
    expect(builderProductionReleasePreviewInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      deploymentId: `app_build_deployment_${"f".repeat(48)}`,
    }).success).toBe(true);
    expect(builderProductionReleaseInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      releaseId: `app_build_release_${"b".repeat(48)}`,
      releaseDigest: "c".repeat(64),
      confirmation: "RELEASE",
    }).success).toBe(true);
    expect(builderProductionReleaseInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      releaseId: `app_build_release_${"b".repeat(48)}`,
      releaseDigest: "c".repeat(64),
      confirmation: "release",
    }).success).toBe(false);
    expect(builderProductionReleaseRefreshInputSchema.safeParse({
      projectId: "project-1",
      sessionId: `app_build_${"a".repeat(48)}`,
      releaseId: `app_build_release_${"b".repeat(48)}`,
    }).success).toBe(true);
  });

  it("blocks credential-shaped source without retaining the secret in the receipt", () => {
    const content = "const token = \"github_pat_abcdefghijklmnopqrstuvwxyz1234567890\";";
    const scan = scanBuilderFilesForSecrets([{ path: "app/unsafe.ts", content, sha256: "a".repeat(64), size: content.length }]);
    expect(scan).toMatchObject({ status: "blocked", findingCount: 1 });
    expect(scan.findings).toEqual([{ path: "app/unsafe.ts", line: 1, rule: "github_token" }]);
    expect(JSON.stringify(scan)).not.toContain("github_pat_");
    const safe = scanBuilderFilesForSecrets([{ path: "app/safe.ts", content: "const key = process.env.API_KEY;", sha256: "b".repeat(64), size: 32 }]);
    expect(safe).toMatchObject({ status: "passed", findingCount: 0 });
  });

  it("ships a reviewed credential-free Next.js starter and creates its image-independent workspace root", async () => {
    const paths = appBuilderStarterTemplate.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining(["package.json", "app/page.tsx", "app/globals.css", "tsconfig.json"]));
    const combined = appBuilderStarterTemplate.files.map((file) => file.content).join("\n");
    expect(combined).not.toMatch(/API_KEY|SECRET|PASSWORD|\.env/);
    const sandboxSource = await readFile(new URL("./sandbox.ts", import.meta.url), "utf8");
    expect(sandboxSource).toContain("sandbox.fs.mkdir(APP_BUILDER_ROOT, { recursive: true })");
  });

  it("registers every builder action through the governed app-service boundary", () => {
    const ids = FIRST_PARTY_APP_TOOLS.map((tool) => tool.id).filter((id) => id.startsWith("app.projects.builder."));
    expect(ids).toEqual([
      "app.projects.builder.show",
      "app.projects.builder.create",
      "app.projects.builder.tree",
      "app.projects.builder.file.read",
      "app.projects.builder.file.update",
      "app.projects.builder.command.run",
      "app.projects.builder.checkpoint.create",
      "app.projects.builder.checkpoint.restore",
      "app.projects.builder.verification.show",
      "app.projects.builder.verification.run",
      "app.projects.builder.sentinel.record",
      "app.projects.builder.repositories.list",
      "app.projects.builder.repository.bind",
      "app.projects.builder.delivery.create",
      "app.projects.builder.deployment.preview",
      "app.projects.builder.deployment.refresh",
      "app.projects.builder.release.preview",
      "app.projects.builder.release.production",
      "app.projects.builder.release.refresh",
      "app.projects.builder.stop",
    ]);
    const operations = new Set<string>(APP_SERVICE_OPERATION_CONTRACTS.map((contract) => contract.operation));
    const bindings = new Set<string>(MAIN_AGENT_APP_SERVICE_BINDINGS.map((binding) => binding.toolId));
    for (const id of ids) {
      expect(operations.has(id), id).toBe(true);
      expect(bindings.has(id), id).toBe(true);
    }
    expect(FIRST_PARTY_APP_TOOLS.find((tool) => tool.id === "app.projects.builder.file.update")).toMatchObject({ operationClass: "mutation", riskLevel: 1, reversible: true });
    expect(FIRST_PARTY_APP_TOOLS.find((tool) => tool.id === "app.projects.builder.create")).toMatchObject({ approvalRequired: true, riskLevel: 2 });
    expect(FIRST_PARTY_APP_TOOLS.find((tool) => tool.id === "app.projects.builder.deployment.preview")).toMatchObject({ approvalRequired: true, riskLevel: 2 });
    expect(FIRST_PARTY_APP_TOOLS.find((tool) => tool.id === "app.projects.builder.release.production")).toMatchObject({ approvalRequired: true, riskLevel: 3, reversible: false });
  });

  it("adds the configurable builder model and actor-private persistent schema", async () => {
    expect(modelAssignmentRoleContracts.code_builder).toMatchObject({ title: "Code builder", acceptedCapabilities: ["tools", "text"] });
    expect(databaseSchemaMigrations.find((migration) => migration.version === 167)).toEqual({
      version: 167,
      name: "app_builder_workspaces_v1",
      checksum: "df930dd3d4221b175bcabcbe4670c200798568f95c91a1c04537d509a3b0133c",
    });
    const migration = await readFile(new URL("../../../supabase/migrations/20260914113000_app_builder_workspaces.sql", import.meta.url), "utf8");
    expect(migration).toContain("'code_builder'");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_actor_scope_v1_allows_canonical");
    expect(migration).toContain("app_builder.command.completed");
    expect(databaseSchemaMigrations.find((migration) => migration.version === 168)).toEqual({
      version: 168,
      name: "app_builder_recovery_v1",
      checksum: "5817c2ae6209f9344439fd536fef3551ed6adca4cafb2811810eaf9ffc6cfd82",
    });
    const recovery = await readFile(new URL("../../../supabase/migrations/20260914160000_app_builder_recovery.sql", import.meta.url), "utf8");
    expect(recovery).toContain("omni_app_builder_checkpoints");
    expect(recovery).toContain("app_builder.checkpoint.restored");
    expect(recovery).toContain("FORCE ROW LEVEL SECURITY");
    expect(databaseSchemaMigrations.find((migration) => migration.version === 169)).toEqual({
      version: 169,
      name: "app_builder_verification_v1",
      checksum: "42d9291da42daf9b4513f4fe9f3221bae4336d2d20074773a96db70135d9d176",
    });
    const verification = await readFile(new URL("../../../supabase/migrations/20260914170000_app_builder_verification.sql", import.meta.url), "utf8");
    expect(verification).toContain("omni_app_builder_verifications");
    expect(verification).toContain("app_builder.sentinel.reviewed");
    expect(verification).toContain("FORCE ROW LEVEL SECURITY");
    expect(databaseSchemaMigrations.find((migration) => migration.version === 170)).toEqual({
      version: 170,
      name: "app_builder_github_delivery_v1",
      checksum: "7d1f8e773faa0de1e8a5ac7a58ffb79a236a79504932fc757ee4cfbfbf796e7f",
    });
    const delivery = await readFile(new URL("../../../supabase/migrations/20260915103000_app_builder_github_delivery.sql", import.meta.url), "utf8");
    expect(delivery).toContain("omni_app_builder_repository_bindings");
    expect(delivery).toContain("omni_app_builder_deliveries");
    expect(delivery).toContain("app_builder.delivery.pull_request_open");
    expect(delivery).toContain("FORCE ROW LEVEL SECURITY");
    expect(databaseSchemaMigrations.find((migration) => migration.version === 171)).toEqual({
      version: 171,
      name: "app_builder_preview_deployments_v1",
      checksum: "22a1cc4db58ef6e999d0276af281a12d4876dc46964009ebd124d645327294ad",
    });
    const previewDeployment = await readFile(new URL("../../../supabase/migrations/20260915140000_app_builder_preview_deployments.sql", import.meta.url), "utf8");
    expect(previewDeployment).toContain("omni_app_builder_deployments");
    expect(previewDeployment).toContain("app_builder.deployment.preview_ready");
    expect(previewDeployment).toContain("FORCE ROW LEVEL SECURITY");
    expect(databaseSchemaMigrations.find((migration) => migration.version === 172)).toEqual({
      version: 172,
      name: "app_builder_production_releases_v1",
      checksum: "7d4c51d2d01df3f14c2ccf263b8c2b029acaf1537db427d8b2353b4b3ea8fed0",
    });
    const productionRelease = await readFile(new URL("../../../supabase/migrations/20260915170000_app_builder_production_releases.sql", import.meta.url), "utf8");
    expect(productionRelease).toContain("omni_app_builder_releases");
    expect(productionRelease).toContain("app_builder.release.production_healthy");
    expect(productionRelease).toContain("FORCE ROW LEVEL SECURITY");
    expect(databaseSchemaMigrations.at(-1)).toEqual({
      version: 173,
      name: "app_builder_deployment_url_constraint_repair_v1",
      checksum: "a41d2d82ad95d8402b182f8136f9bee67133d2380f246605c803915838c7da8e",
    });
    const deploymentUrlRepair = await readFile(new URL("../../../supabase/migrations/20260915173000_app_builder_deployment_url_constraint_repair.sql", import.meta.url), "utf8");
    expect(deploymentUrlRepair).toContain("[.]vercel[.]app");
    expect(deploymentUrlRepair).toContain("omni_app_builder_deployments_row_check");
    expect(deploymentUrlRepair).toContain("omni_app_builder_releases_row_check");
    const runner = await readFile(new URL("../orchestration/agent-runner.ts", import.meta.url), "utf8");
    expect(runner).toContain('agentId === "sentinel"');
    expect(runner).toContain('? "verifier" as const');
  });
});
