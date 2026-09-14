import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { builderCheckpointCreateInputSchema, builderCheckpointRestoreInputSchema, builderCommandInputSchema, builderFileUpdateInputSchema, safeBuilderRelativePath } from "@/lib/app-builder/contracts";
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
    expect(databaseSchemaMigrations.at(-1)).toEqual({
      version: 169,
      name: "app_builder_verification_v1",
      checksum: "42d9291da42daf9b4513f4fe9f3221bae4336d2d20074773a96db70135d9d176",
    });
    const verification = await readFile(new URL("../../../supabase/migrations/20260914170000_app_builder_verification.sql", import.meta.url), "utf8");
    expect(verification).toContain("omni_app_builder_verifications");
    expect(verification).toContain("app_builder.sentinel.reviewed");
    expect(verification).toContain("FORCE ROW LEVEL SECURITY");
    const runner = await readFile(new URL("../orchestration/agent-runner.ts", import.meta.url), "utf8");
    expect(runner).toContain('agentId === "sentinel"');
    expect(runner).toContain('? "verifier" as const');
  });
});
