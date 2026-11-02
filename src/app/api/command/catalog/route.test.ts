import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContextCatalog } from "@/lib/command/composer-context-contract";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  caller: vi.fn(),
  agents: vi.fn(),
  skills: vi.fn(),
  plugins: vi.fn(),
  projects: vi.fn(),
  integrations: vi.fn(),
  files: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <T>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/app-services/contracts", () => ({ createAppServiceCaller: mocks.caller }));
vi.mock("@/lib/app-services/agents", () => ({
  listAgentsService: mocks.agents,
  listSkillsService: mocks.skills,
}));
vi.mock("@/lib/app-services/plugins", () => ({ listPluginsService: mocks.plugins }));
vi.mock("@/lib/app-services/projects", () => ({ listProjectsService: mocks.projects }));
vi.mock("@/lib/app-services/integrations", () => ({ showTruthfulIntegrationsService: mocks.integrations }));
vi.mock("@/lib/app-services/library", () => ({ listWorkspaceLibraryService: mocks.files }));

import { GET } from "./route";

const authority = { tenantId: "tenant-a", actorId: "owner-a" };
const caller = { context: authority };
const digest = "a".repeat(64);

async function catalog() {
  const response = await GET(new Request("https://asael.test/api/command/catalog"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return await response.json() as CommandContextCatalog;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(authority);
  mocks.caller.mockReturnValue(caller);
  mocks.agents.mockResolvedValue({ data: { builtIns: [], agents: [] } });
  mocks.skills.mockResolvedValue({ data: { skills: [] } });
  mocks.plugins.mockResolvedValue({ data: { plugins: [] } });
  mocks.projects.mockResolvedValue({ data: { projects: [] } });
  mocks.integrations.mockResolvedValue({ data: { overview: { installed: [] } } });
  mocks.files.mockResolvedValue({ data: { items: [] } });
});

describe("Command context catalog display contract", () => {
  it("keeps long saved project objectives within the unchanged native contract", async () => {
    const projects = [1159, 1985].map((length) => ({
      id: `project_${length}`, title: `Saved project ${length}`,
      objective: "x".repeat(length), status: "active",
    }));
    mocks.projects.mockResolvedValue({ data: { projects } });
    const result = await catalog();
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.description.length).toBeLessThanOrEqual(1000);
      expect(item.description).toBe(`${"x".repeat(999)}…`);
      expect(item.selectable).toBe(true);
    }
    expect(projects.map((project) => project.objective.length)).toEqual([1159, 1985]);
    expect(mocks.projects).toHaveBeenCalledWith(caller, { limit: 80 });
  });

  it("bounds every source's display text without changing reference bindings", async () => {
    const title = "t".repeat(300);
    const description = "d".repeat(1200);
    mocks.agents.mockResolvedValue({ data: { builtIns: [{ id: "atlas", name: title, role: description }], agents: [] } });
    mocks.skills.mockResolvedValue({ data: { skills: [{ id: "skill-a", name: title, description, status: "active", version: 7 }] } });
    mocks.plugins.mockResolvedValue({ data: { plugins: [{ installed: true, installationId: "plugin-a", name: title, description, status: "enabled", revision: 9, installedManifestSha256: digest }] } });
    mocks.projects.mockResolvedValue({ data: { projects: [{ id: "project-a", title, objective: description, status: "active" }] } });
    mocks.integrations.mockResolvedValue({ data: { overview: { installed: [{ id: "integration-a", name: title, permissions: { mode: "read_only" }, nextAction: description, state: "connected", connected: true }] } } });
    mocks.files.mockResolvedValue({ data: { items: [{ id: "file-a", title, summary: description, sourceLabel: "Library", status: "ready", sourceId: "source-a", currentVersion: { versionNumber: 3, versionId: "version-a", contentSha256: digest } }] } });
    const result = await catalog();
    expect(result.items).toHaveLength(6);
    for (const item of result.items) {
      expect(item.label).toBe(`${"t".repeat(239)}…`);
      expect(item.description.length).toBeLessThanOrEqual(1000);
      expect(item.description.endsWith("…")).toBe(true);
    }
    expect(result.items.find((item) => item.kind === "file")).toMatchObject({
      id: "file-a", sourceId: "source-a", expectedVersion: 3, versionId: "version-a", bindingSha256: digest,
    });
    expect(result.items.find((item) => item.kind === "plugin")).toMatchObject({
      id: "plugin-a", expectedVersion: 9, bindingSha256: digest,
    });
    expect(result.items.find((item) => item.kind === "skill")).toMatchObject({ id: "skill-a", expectedVersion: 7 });
  });

  it("leaves short and exact-boundary text intact", async () => {
    mocks.projects.mockResolvedValue({ data: { projects: [
      { id: "project-a", title: "A short title", objective: "An intact objective.", status: "active" },
      { id: "project-b", title: "t".repeat(240), objective: "d".repeat(1000), status: "archived" },
    ] } });
    const result = await catalog();
    expect(result.items.find((item) => item.id === "project-a")).toMatchObject({ label: "A short title", description: "An intact objective." });
    expect(result.items.find((item) => item.id === "project-b")).toMatchObject({ label: "t".repeat(240), description: "d".repeat(1000), selectable: false });
  });

  it("does not cut a UTF-16 surrogate pair at a native display boundary", async () => {
    mocks.projects.mockResolvedValue({ data: { projects: [{
      id: "project-a", title: `${"t".repeat(238)}🌍 more`,
      objective: `${"d".repeat(998)}🌍 more`, status: "active",
    }] } });
    const result = await catalog();
    expect(result.items[0].label).toBe(`${"t".repeat(238)}…`);
    expect(result.items[0].description).toBe(`${"d".repeat(998)}…`);
  });

  it("retains usable source groups when another source is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mocks.plugins.mockRejectedValue(new Error("unavailable"));
      mocks.projects.mockResolvedValue({ data: { projects: [{ id: "project-a", title: "Available", objective: "Still selectable", status: "active" }] } });
      const result = await catalog();
      expect(result.sources.plugin).toBe("unavailable");
      expect(result.sources.project).toBe("ready");
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("project-a");
    } finally { warn.mockRestore(); }
  });

  it("does not load a catalog without current authority", async () => {
    mocks.authorize.mockRejectedValue(new Error("forbidden"));
    expect((await GET(new Request("https://asael.test/api/command/catalog"))).status).toBe(403);
    expect(mocks.caller).not.toHaveBeenCalled();
    for (const service of [mocks.agents, mocks.skills, mocks.plugins, mocks.projects, mocks.integrations, mocks.files]) {
      expect(service).not.toHaveBeenCalled();
    }
  });
});
