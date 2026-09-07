import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAIN_AGENT_APP_SERVICE_BINDINGS,
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
    expect(validation.mainAgentOperationCount).toBe(15);
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
    ].map(async (file) => ({
      file,
      source: await readFile(resolve(process.cwd(), file), "utf8"),
    })));
    for (const route of routes) {
      expect(route.source, route.file).toContain("@/lib/app-services/");
    }
  });
});
