import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_SERVICE_OPERATION_CONTRACTS,
  MAIN_AGENT_APP_SERVICE_BINDINGS,
  MAIN_AGENT_EXCLUDED_APP_OPERATIONS,
  validateAppServiceRegistry,
} from "@/lib/app-services/registry";

describe("P9.1 Main Agent application-service coverage", () => {
  it("binds every current first-party application tool to a registered service", () => {
    const validation = validateAppServiceRegistry();
    expect(validation).toMatchObject({
      mainAgentOperationCount: MAIN_AGENT_APP_SERVICE_BINDINGS.length,
      missingAgentOperations: [],
      forbiddenAgentAccessPaths: [],
      passed: true,
    });
    expect(validation.mainAgentOperationCount).toBeGreaterThanOrEqual(15);
  });

  it("keeps the governed executor off application stores and retrievers", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/lib/tools/executor.ts"),
      "utf8",
    );
    for (const forbiddenImport of [
      "@/lib/memory/store",
      "@/lib/memory/maintenance-store",
      "@/lib/missions/store",
      "@/lib/runs/store",
      "@/lib/rag/store",
      "@/lib/rag/retriever",
    ]) {
      expect(source, forbiddenImport).not.toContain(forbiddenImport);
    }
    expect(source).not.toMatch(/document\.(querySelector|click)|page\.(click|locator)/);
  });

  it("routes overlapping UI operations through the same service modules", async () => {
    const routes = await Promise.all([
      "src/app/api/memory/route.ts",
      "src/app/api/memory/[id]/route.ts",
      "src/app/api/memory/[id]/lifecycle/route.ts",
      "src/app/api/knowledge/route.ts",
      "src/app/api/missions/route.ts",
      "src/app/api/missions/[id]/route.ts",
      "src/app/api/missions/[id]/tasks/route.ts",
      "src/app/api/missions/[id]/tasks/[taskId]/comments/route.ts",
      "src/app/api/runs/route.ts",
      "src/app/api/settings/api-keys/route.ts",
      "src/app/api/settings/api-keys/[id]/route.ts",
      "src/app/api/settings/mcp/route.ts",
      "src/app/api/settings/providers/[id]/route.ts",
      "src/app/api/settings/providers/[id]/validate/route.ts",
      "src/app/api/capture/assets/[id]/route.ts",
      "src/app/api/capture/recordings/[id]/route.ts",
      "src/app/api/connectors/native/mcp-registration-preparations/route.ts",
      "src/app/api/connectors/native/mcp-registration-preparations/[keySha256]/route.ts",
      "src/app/api/connectors/native/mcp-registration-preparations/[keySha256]/abandon/route.ts",
      "src/app/api/connectors/native/mcp-registrations/route.ts",
      "src/app/api/connectors/native/mcp-registrations/[keySha256]/route.ts",
    ].map(async (file) => ({
      file,
      source: await readFile(resolve(process.cwd(), file), "utf8"),
    })));
    for (const route of routes) {
      expect(route.source, route.file).toContain("@/lib/app-services/");
    }
  });

  it("gives the architecture guide the registry's own counts", async () => {
    const guide = (await readFile(resolve(process.cwd(), "docs/architecture.md"), "utf8"))
      .replace(/\s+/g, " ");
    const appOperations = APP_SERVICE_OPERATION_CONTRACTS
      .filter((contract) => contract.operation.startsWith("app."));

    expect(guide).toContain(`extend it to ${appOperations.length} active \`app.*\` operations`);
    expect(guide).toContain(
      `The ${MAIN_AGENT_EXCLUDED_APP_OPERATIONS.length} deliberately excluded operations`,
    );
  });

  it("leaves every permanent effect to its preview-bound service", async () => {
    const serviceByEffect = {
      revokeServiceApiKey: "src/lib/app-services/settings.ts",
      revokeProviderConnection: "src/lib/app-services/settings.ts",
      deleteCaptureAssetWithKnowledge: "src/lib/app-services/assets.ts",
      deleteCaptureRecordingWithKnowledge: "src/lib/app-services/assets.ts",
      retireAgentRelease: "src/lib/app-services/agent-governance.ts",
      revokeAgentMemoryGrant: "src/lib/app-services/agent-governance.ts",
      forgetMemoryWithReceipt: "src/lib/app-services/memory.ts",
      deleteKnowledgeDocumentsBySourcePrefix: "src/lib/app-services/knowledge.ts",
    };
    const root = process.cwd();
    const routes = await routeFiles(resolve(root, "src/app/api"));
    expect(routes.length).toBeGreaterThan(100);
    const bypasses: string[] = [];
    for (const route of routes) {
      const source = await readFile(route, "utf8");
      for (const effect of Object.keys(serviceByEffect)) {
        if (new RegExp(`\\b${effect}\\b`).test(source)) {
          bypasses.push(`${relative(root, route)} ${effect}`);
        }
      }
    }
    expect(bypasses).toEqual([]);
    for (const [effect, service] of Object.entries(serviceByEffect)) {
      const source = await readFile(resolve(root, service), "utf8");
      expect(source, effect).toMatch(new RegExp(`\\b${effect}\\(`));
    }
  });
});

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return Promise.resolve(entry.name === "route.ts" ? [path] : []);
  }));
  return nested.flat();
}
