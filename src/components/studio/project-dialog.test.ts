import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  studioProjectProfileDefaults,
  type StudioProject,
} from "@/lib/studio/contracts";
import { StudioClient } from "./transport";
import {
  StudioBrandSnapshotDialog,
  StudioFlowProjectDialog,
  StudioProjectDialog,
} from "./project-dialog";

const project: StudioProject = {
  id: "fashion",
  legacyProjectId: null,
  title: "Fashion brand",
  status: "active",
  workspaceId: "workspace_a",
  profile: null,
};
describe("Studio project dialogs", () => {
  it("offers editable starters and optional account metadata without implying publishing", () => {
    const transport = vi.fn();
    const html = renderToStaticMarkup(
      createElement(StudioProjectDialog, {
        client: new StudioClient(transport),
        owner: "actor_a",
        writable: true,
        onSaved: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain("Fashion");
    expect(html).toContain("Trading");
    expect(html).toContain("AI &amp; Tech");
    expect(html).toContain("does not connect an account or publish anything");
    expect(html).toContain("Create project");
    expect(transport).not.toHaveBeenCalled();
  });
  it("excludes the current and archived projects from cross-project copy destinations", () => {
    const html = renderToStaticMarkup(
      createElement(StudioFlowProjectDialog, {
        mode: "copy",
        projects: [
          project,
          { ...project, id: "trading", title: "Trading brand" },
          {
            ...project,
            id: "archived",
            title: "Archived brand",
            status: "archived",
          },
        ],
        currentProjectId: "fashion",
        busy: false,
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain("Trading brand");
    expect(html).not.toContain('<option value="fashion"');
    expect(html).not.toContain('<option value="archived"');
    expect(html).toContain("Run history and generated results are not copied");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
  });
  it("shows the flow's saved context rather than a project's newer profile", () => {
    const context = {
      ...studioProjectProfileDefaults("fashion", "Saved brand name"),
      projectId: "fashion",
      profileRevision: 2,
      channels: [{ platform: "Threads", handle: "" }],
    };
    const html = renderToStaticMarkup(
      createElement(StudioBrandSnapshotDialog, {
        graph: {
          schemaVersion: 1,
          nodes: [],
          edges: [],
          projectContext: context,
        },
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain("Saved brand name");
    expect(html).toContain("Saved version");
    expect(html).toContain("Threads");
    expect(html).toContain("Full submitted prompt");
    expect(html).not.toContain("Threads:");
  });
});
