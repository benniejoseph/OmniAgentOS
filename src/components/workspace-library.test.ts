import { describe, expect, it } from "vitest";
import {
  workspaceLibraryKindLabel,
  workspaceLibraryQueryHref,
} from "@/components/workspace-library";

describe("workspace library UI helpers", () => {
  it("builds a bounded repeatable kind query without leaking undefined scope", () => {
    expect(workspaceLibraryQueryHref({
      query: " launch plan ",
      kinds: ["image", "transcript", "image"],
      projectId: "project-1",
      limit: 500,
    })).toBe("/api/library?q=launch+plan&kind=image&kind=transcript&project=project-1&limit=100");
    expect(workspaceLibraryQueryHref({
      kinds: ["email"],
      limit: 25,
      offset: 50,
    })).toBe("/api/library?kind=email&limit=25&offset=50");
  });

  it("uses human labels for canonical kinds", () => {
    expect(workspaceLibraryKindLabel("generated_artifact")).toBe("Generated");
    expect(workspaceLibraryKindLabel("spreadsheet")).toBe("Spreadsheet");
  });
});
