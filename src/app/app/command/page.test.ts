import { describe, expect, it } from "vitest";

import CommandPage from "@/app/app/command/page";

describe("Command page project context entry", () => {
  it("passes a validated project and explicit shared scope to the workspace", async () => {
    const element = await CommandPage({
      searchParams: Promise.resolve({
        agent: "atlas",
        project: "project-a",
        context: "project",
        prompt: "Use the project launch notes.",
      }),
    });

    expect(element.props).toMatchObject({
      initialAgentId: "atlas",
      initialProjectId: "project-a",
      initialContextScope: "project",
      initialGoal: "Use the project launch notes.",
    });
  });

  it("does not activate project scope for an invalid project coordinate", async () => {
    const element = await CommandPage({
      searchParams: Promise.resolve({
        project: "not allowed/with spaces",
        context: "project",
      }),
    });

    expect(element.props.initialProjectId).toBeUndefined();
    expect(element.props.initialContextScope).toBeUndefined();
  });
});
