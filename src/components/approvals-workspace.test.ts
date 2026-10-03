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

    expect(html).toMatch(/<h1\b[^>]*>Inbox<\/h1>/);
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

  it("is busy until it first reads the queues, with its announcers in place", () => {
    session.role = "admin";
    const html = render();

    expect(html).toMatch(/^<div\b[^>]*aria-busy="true"[^>]*data-testid="inbox-workspace"/);
    expect(html).toContain("Loading decisions…");
    // A decision is announced in regions already in the page.
    expect(html).toContain(
      '<div role="status" aria-live="polite" aria-atomic="true"></div><div role="alert" aria-atomic="true"></div>',
    );
    // Focus can be put on a list's heading once its last card is decided.
    expect(html).toMatch(
      /<h2\b[^>]*id="access-request-heading"[^>]*tabindex="-1"[^>]*>Workspace access<\/h2>/,
    );
    expect(html).toMatch(
      /<h2\b[^>]*id="action-approval-heading"[^>]*tabindex="-1"[^>]*>Agent and workflow actions<\/h2>/,
    );
    expect(html).toMatch(/<section\b[^>]*aria-labelledby="access-request-heading"/);
    expect(html).toMatch(/<section\b[^>]*aria-labelledby="action-approval-heading"/);
  });

  it("shows no linked item to a role that cannot decide it", () => {
    session.role = "viewer";
    const html = render({ focusId: "exec-1", focusKind: "tool", returnTo: "/app/today" });

    expect(html).not.toContain("The approval you opened");
    expect(html).toContain("Approval access is limited");
    expect(html).toContain("Go back");
  });
});
