import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/components/app-shell/session-context";

const session = vi.hoisted(() => ({
  role: "operator" as WorkspaceRole,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/app-shell/session-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/app-shell/session-context")>();
  return {
    ...actual,
    useWorkspaceSession: () => ({
      session: {
        authEnabled: true,
        authenticated: true,
        context: { actorId: "reviewer", role: session.role },
      },
      status: "ready",
      role: session.role,
      refresh: async () => undefined,
      signOut: async () => undefined,
    }),
  };
});

const { ApprovalsWorkspace } = await import("@/components/approvals-workspace");

function render(props: Parameters<typeof ApprovalsWorkspace>[0] = {}) {
  return renderToStaticMarkup(createElement(ApprovalsWorkspace, props));
}

describe("ApprovalsWorkspace", () => {
  it("opens on the linked item and offers the way back", () => {
    session.role = "operator";
    const html = render({
      focusId: "exec-1",
      focusKind: "tool",
      returnTo: "/app/command?thread=thread-1&run=run-1",
    });

    expect(html).toContain('data-testid="inbox-workspace"');
    expect(html).toContain("The approval you opened");
    expect(html).toContain("Loading the approval you opened…");
    expect(html).toContain("Once the decision goes through, you go back to where you came from.");
    expect(html).toContain('href="/app/command?thread=thread-1&amp;run=run-1"');
    expect(html).toContain("Back to conversation");
    expect(html).toContain("Agent and workflow actions");
  });

  it("shows the queue alone without a link", () => {
    session.role = "operator";
    const html = render();

    expect(html).not.toContain("The approval you opened");
    expect(html).not.toContain("Back to conversation");
    expect(html).not.toContain("Go back");
    expect(html).toContain("Loading decisions…");
  });

  it("says the rest follows when there is no way back", () => {
    session.role = "operator";
    const html = render({ focusId: "exec-1" });

    expect(html).toContain("Decide it here. The rest of the queue follows.");
    expect(html).not.toContain("Back to conversation");
  });

  it("shows no linked item to a role that cannot decide it", () => {
    session.role = "viewer";
    const html = render({ focusId: "exec-1", focusKind: "tool", returnTo: "/app/today" });

    expect(html).not.toContain("The approval you opened");
    expect(html).toContain("Approval access is limited");
    expect(html).toContain("Go back");
  });
});
