import { describe, expect, it, vi } from "vitest";
import {
  studioProjectProfileDefaults,
  studioProjectProfileInputSchema,
  type StudioProject,
} from "@/lib/studio/contracts";
import {
  readPendingStudioFlowAction,
  readStudioProjects,
  readStudioProjectScope,
  resolveStudioProjectScope,
  resolveStudioFlowScope,
  studioCreateStorageKey,
  studioEditableProfile,
  studioFlowsPath,
  studioProjectName,
  studioScopeMatches,
  studioScopeProjectId,
  studioScopeStorageKey,
  studioScopeUrl,
} from "./project-state";
import { StudioClient, StudioRequestTimeout } from "./transport";

const project: StudioProject = {
  id: "project_fashion",
  legacyProjectId: null,
  title: "Fashion brand",
  status: "active",
  workspaceId: "workspace_a",
  profile: null,
};
describe("Studio project scope and recovery", () => {
  it("treats all and unassigned as filters, never project identities", () => {
    expect(readStudioProjectScope("all")).toBeUndefined();
    expect(readStudioProjectScope(["project_fashion"])).toBeUndefined();
    expect(readStudioProjectScope("../other")).toBeUndefined();
    expect(readStudioProjectScope("unassigned")).toBe("unassigned");
    expect(studioScopeProjectId("unassigned")).toBeUndefined();
    expect(studioScopeProjectId("project_fashion")).toBe("project_fashion");
  });
  it("keeps landing, API filtering, refresh and return navigation in the same project", () => {
    expect(studioScopeUrl("project_fashion", "studio_flow_a")).toBe(
      "/app/studio?project=project_fashion&flow=studio_flow_a",
    );
    expect(studioScopeUrl("project_fashion")).toBe(
      "/app/studio?project=project_fashion",
    );
    expect(studioScopeUrl(undefined)).toBe("/app/studio");
    expect(studioFlowsPath("unassigned")).toBe(
      "/api/studio/flows?projectId=unassigned",
    );
    expect(studioFlowsPath(undefined)).toBe("/api/studio/flows");
    expect(studioScopeMatches("project_other", "project_fashion")).toBe(false);
    expect(studioScopeMatches(null, "unassigned")).toBe(true);
    expect(studioScopeMatches("project_fashion", "unassigned")).toBe(false);
    expect(studioScopeMatches("project_fashion", undefined)).toBe(true);
  });
  it("normalizes Work's legacy project links for selection, filtering and direct-flow refresh", () => {
    const projects = [{ ...project, legacyProjectId: "omni_project_fashion" }];
    const scope = resolveStudioProjectScope("omni_project_fashion", projects);
    expect(scope).toBe(project.id);
    expect(projects.find((item) => item.id === scope)?.title).toBe(
      "Fashion brand",
    );
    expect(studioScopeMatches(project.id, scope)).toBe(true);
    const direct = resolveStudioFlowScope(
      { id: "flow_a", projectId: project.id, revision: 1 },
      "omni_project_fashion",
      projects,
    );
    const url = studioScopeUrl(direct.scope, "flow_a");
    expect(url).toBe("/app/studio?project=project_fashion&flow=flow_a");
    expect(
      resolveStudioProjectScope(
        new URL(url, "https://asael.example").searchParams.get("project") ||
          undefined,
        projects,
      ),
    ).toBe(project.id);
    expect(studioScopeUrl(direct.scope)).toBe(
      "/app/studio?project=project_fashion",
    );
    expect(resolveStudioProjectScope("unknown", projects)).toBe("unknown");
    expect(() =>
      resolveStudioFlowScope(
        { id: "flow_a", projectId: "project_other", revision: 1 },
        "omni_project_fashion",
        projects,
      ),
    ).toThrow("another project");
  });
  it("recovers an acknowledged assignment after a lost response and reload with the original frozen request", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    try {
      const original = {
        key: "assign_original",
        flowId: "flow_a",
        body: { action: "assign-project", revision: 4, projectId: project.id },
      };
      const receiptKey = "asael:studio-flow-action:actor_a:flow_a";
      sessionStorage.setItem(receiptKey, JSON.stringify(original));
      let saved = {
        id: "flow_a",
        projectId: null as string | null,
        revision: 4,
      };
      const requests: { key: string | null; body: string }[] = [];
      const transport = async (_path: unknown, init?: RequestInit) => {
        requests.push({
          key: new Headers(init?.headers).get("idempotency-key"),
          body: String(init?.body),
        });
        if (requests.length === 1) {
          saved = { ...saved, projectId: project.id, revision: 5 };
          return new Promise<Response>(() => {});
        }
        return Response.json({ flow: saved });
      };
      await expect(
        new StudioClient(transport as typeof fetch, 10, "actor_a").post(
          "/api/studio/flows/flow_a/actions",
          original.body,
          original.key,
        ),
      ).rejects.toBeInstanceOf(StudioRequestTimeout);
      // Reload still has the old unassigned URL, while the server has committed the assignment.
      const recovered = resolveStudioFlowScope(
        saved,
        "unassigned",
        [project],
        JSON.parse(sessionStorage.getItem(receiptKey)!),
      );
      expect(recovered.recoveringAssignment).toBe(true);
      expect(recovered.pending).toEqual(original);
      const acknowledgement = await new StudioClient(
        transport as typeof fetch,
        100,
        "actor_a",
      ).post<{ flow: typeof saved }>(
        "/api/studio/flows/flow_a/actions",
        recovered.pending!.body,
        recovered.pending!.key,
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(JSON.parse(requests[1].body).revision).toBe(4);
      expect(acknowledgement.flow.revision).toBe(5);
      expect(
        studioScopeUrl(
          acknowledgement.flow.projectId || "unassigned",
          acknowledgement.flow.id,
        ),
      ).toBe("/app/studio?project=project_fashion&flow=flow_a");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("keeps cross-project guards for absent, unrelated and uncommitted assignment receipts", () => {
    const saved = { id: "flow_a", projectId: project.id, revision: 5 };
    const receipt = {
      key: "assign_original",
      flowId: "flow_a",
      body: { action: "assign-project", revision: 4, projectId: project.id },
    };
    for (const invalid of [
      undefined,
      { ...receipt, flowId: "flow_b" },
      { ...receipt, body: { ...receipt.body, action: "duplicate" } },
      { ...receipt, body: { ...receipt.body, projectId: "project_other" } },
      { ...receipt, body: { ...receipt.body, revision: 5 } },
    ])
      expect(() =>
        resolveStudioFlowScope(saved, "unassigned", [project], invalid),
      ).toThrow("another project");
    expect(() =>
      resolveStudioFlowScope(saved, "project_other", [project], receipt),
    ).toThrow("another project");
  });
  it("isolates last-opened flow and pending creation by project and actor", () => {
    const scopes = [
      undefined,
      "unassigned",
      "project_fashion",
      "project_trading",
    ];
    const keys = ["actor_a", "actor_b"].flatMap((owner) =>
      scopes.flatMap((scope) => [
        studioScopeStorageKey(owner, scope),
        studioCreateStorageKey(owner, scope),
      ]),
    );
    expect(new Set(keys).size).toBe(16);
  });
  it("keeps a brandless ordinary project selectable without inventing profile details", () => {
    expect(readStudioProjects([project])).toEqual([project]);
    expect(studioProjectName([project], project.id)).toBe("Fashion brand");
    expect(studioProjectName([project], null)).toBe("Unassigned");
    expect(studioProjectName([project], "project_missing")).toBe(
      "Project unavailable",
    );
    expect(() =>
      readStudioProjects([
        { ...project, profile: { projectId: "project_other", revision: 1 } },
      ]),
    ).toThrow("incomplete");
  });
  it("preserves the original copy request and rejects recovery from another flow", () => {
    const receipt = {
      key: "request_original",
      flowId: "flow_a",
      body: {
        action: "duplicate",
        revision: 3,
        projectId: "project_trading",
        retainReferences: false,
      },
    };
    expect(readPendingStudioFlowAction(receipt, "flow_a")).toEqual(receipt);
    expect(readPendingStudioFlowAction(receipt, "flow_b")).toBeUndefined();
    expect(
      readPendingStudioFlowAction(
        { ...receipt, body: { ...receipt.body, revision: 0 } },
        "flow_a",
      ),
    ).toBeUndefined();
    expect(
      readPendingStudioFlowAction(
        { ...receipt, body: { ...receipt.body, retainReferences: "yes" } },
        "flow_a",
      ),
    ).toBeUndefined();
  });
  it("sends only editable profile fields and accepts platform-only accounts", () => {
    const saved = {
      ...studioProjectProfileDefaults("fashion", "Fashion brand"),
      projectId: project.id,
      revision: 8,
      updatedAt: "2026-10-26",
      contentPillars: ["Style", "", "  Textures  "],
      channels: [{ platform: "Threads", handle: "" }],
    };
    const input = studioEditableProfile(saved);
    expect(input).not.toHaveProperty("revision");
    expect(input).not.toHaveProperty("projectId");
    expect(input.contentPillars).toEqual(["Style", "Textures"]);
    expect(studioProjectProfileInputSchema.safeParse(input).success).toBe(true);
    expect(saved.contentPillars).toEqual(["Style", "", "  Textures  "]);
  });
});
