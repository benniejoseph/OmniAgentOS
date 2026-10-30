import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/projects-workspace", () => ({ ProjectsWorkspace: () => null }));
vi.mock("@/components/csm-workspace", () => ({ CsmWorkspace: () => null }));

const { default: ProjectsPage } = await import("./page");
const { ProjectsWorkspace } = await import("@/components/projects-workspace");
const { CsmWorkspace } = await import("@/components/csm-workspace");

describe("My work entry and saved links", () => {
  it("opens general projects without a client-only assumption", async () => {
    const page = await ProjectsPage({ searchParams: Promise.resolve({}) });
    expect(page.type).toBe(ProjectsWorkspace);
    expect(page.props.initialView).toBe("overview");
  });

  it.each(["clients", "role"])("keeps the explicit %s destination reachable", async (view) => {
    const page = await ProjectsPage({ searchParams: Promise.resolve({ view }) });
    expect(page.type).toBe(CsmWorkspace);
    expect(page.props.initialView).toBe(view);
  });

  it("retains existing client project deep links", async () => {
    const page = await ProjectsPage({ searchParams: Promise.resolve({ project: "client:aster-vale" }) });
    expect(page.type).toBe(CsmWorkspace);
    expect(page.props.initialProjectId).toBe("client:aster-vale");
  });

  it.each(["projects", "execution", "build"])("retains %s links even with a project selection", async (view) => {
    const page = await ProjectsPage({ searchParams: Promise.resolve({ view, project: "project:launch" }) });
    expect(page.type).toBe(ProjectsWorkspace);
    expect(page.props.initialView).toBe(view === "projects" ? "overview" : view);
  });

  it("keeps search results on the general project browser", async () => {
    const page = await ProjectsPage({ searchParams: Promise.resolve({ fromSearch: "1", project: "project:launch" }) });
    expect(page.type).toBe(ProjectsWorkspace);
  });
});
