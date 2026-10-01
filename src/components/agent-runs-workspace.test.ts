import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/app-shell/session-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/app-shell/session-context")>();
  return {
    ...actual,
    useWorkspaceSession: () => ({
      session: {
        authEnabled: true,
        authenticated: true,
        context: { actorId: "owner", role: "operator" },
      },
      status: "ready",
      role: "operator",
      refresh: async () => undefined,
      signOut: async () => undefined,
    }),
  };
});

const { AgentRunsWorkspace } = await import("@/components/agent-runs-workspace");

const source = readFileSync("src/components/agent-runs-workspace.tsx", "utf8");

describe("Command routing preference", () => {
  it("lets the server choose between a direct run and a workflow", () => {
    expect(source.match(/strategy: "auto",/g)).toHaveLength(2);
    expect(source).not.toContain('strategy: "direct",');
    expect(source).not.toContain('"auto" : "direct"');
  });
});

describe("announcing a run", () => {
  it("announces from outside the view that is busy while a run streams", () => {
    const html = renderToStaticMarkup(createElement(AgentRunsWorkspace));

    // Assistive technology may hold back what changes in a busy view, so the
    // announcer is its sibling, not inside it.
    expect(html).toMatch(
      /^<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">Run workspace ready\.<\/p><div class="[^"]*" aria-busy="(true|false)" data-testid="work-workspace">/,
    );
    expect(html.match(/role="status" aria-live="polite" aria-atomic="true">Run workspace ready\./g))
      .toHaveLength(1);
  });

  it("announces each phase of a streamed run once, and none of the steps between", () => {
    const handler = source.slice(
      source.indexOf("const handleStreamEvent = (event: StreamEvent) => {"),
      source.indexOf("const cursor: SseCursor"),
    );
    expect(handler.match(/setRunAnnouncement\(/g)).toHaveLength(1);
    expect(handler).toContain("const announcement = runStreamAnnouncement(event);");
  });
});
