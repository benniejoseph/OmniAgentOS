import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { builderCommandInputSchema, builderFileUpdateInputSchema, safeBuilderRelativePath } from "@/lib/app-builder/contracts";
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
  });

  it("ships a reviewed credential-free Next.js starter", () => {
    const paths = appBuilderStarterTemplate.files.map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining(["package.json", "app/page.tsx", "app/globals.css", "tsconfig.json"]));
    const combined = appBuilderStarterTemplate.files.map((file) => file.content).join("\n");
    expect(combined).not.toMatch(/API_KEY|SECRET|PASSWORD|\.env/);
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
      "app.projects.builder.stop",
    ]);
    const operations = new Set(APP_SERVICE_OPERATION_CONTRACTS.map((contract) => contract.operation));
    const bindings = new Set(MAIN_AGENT_APP_SERVICE_BINDINGS.map((binding) => binding.toolId));
    for (const id of ids) {
      expect(operations.has(id), id).toBe(true);
      expect(bindings.has(id), id).toBe(true);
    }
    expect(FIRST_PARTY_APP_TOOLS.find((tool) => tool.id === "app.projects.builder.file.update")).toMatchObject({ operationClass: "mutation", riskLevel: 1, reversible: true });
    expect(FIRST_PARTY_APP_TOOLS.find((tool) => tool.id === "app.projects.builder.create")).toMatchObject({ approvalRequired: true, riskLevel: 2 });
  });

  it("adds the configurable builder model and actor-private persistent schema", async () => {
    expect(modelAssignmentRoleContracts.code_builder).toMatchObject({ title: "Code builder", acceptedCapabilities: ["tools", "text"] });
    expect(databaseSchemaMigrations.at(-1)).toEqual({
      version: 167,
      name: "app_builder_workspaces_v1",
      checksum: "df930dd3d4221b175bcabcbe4670c200798568f95c91a1c04537d509a3b0133c",
    });
    const migration = await readFile(new URL("../../../supabase/migrations/20260914113000_app_builder_workspaces.sql", import.meta.url), "utf8");
    expect(migration).toContain("'code_builder'");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("omni_actor_scope_v1_allows_canonical");
    expect(migration).toContain("app_builder.command.completed");
  });
});
