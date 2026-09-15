import { describe, expect, it } from "vitest";

import { buildAppBuilderAgentRequest } from "@/lib/app-builder/agent-request";

describe("App Builder agent requests", () => {
  it.each(["forge", "sentinel"] as const)(
    "uses project context without an incompatible explicit-selection lock for %s",
    (agentId) => {
      const request = buildAppBuilderAgentRequest({
        projectId: "project_canary",
        message: "Inspect the bounded App Builder workspace.",
        requestId: "request-canary",
        agentId,
      });

      expect(request).toMatchObject({
        mode: "execute",
        projectId: "project_canary",
        strategy: "direct",
        agentId,
        contextScope: "project",
      });
      expect(request).not.toHaveProperty("contextSelection");
    },
  );
});
