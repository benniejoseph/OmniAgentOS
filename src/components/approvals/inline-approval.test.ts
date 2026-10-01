import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/components/app-shell/session-context";
import type { ApprovalItem, TrustResponse } from "@/components/approvals/approval-decision";

const session = vi.hoisted(() => ({
  role: "operator" as WorkspaceRole,
  status: "ready" as "loading" | "ready" | "error",
}));

vi.mock("@/components/app-shell/session-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/app-shell/session-context")>();
  return {
    ...actual,
    useWorkspaceSession: () => ({
      session: session.status === "ready"
        ? {
            authEnabled: true,
            authenticated: true,
            context: { actorId: "reviewer", role: session.role },
          }
        : undefined,
      status: session.status,
      role: session.role,
      refresh: async () => undefined,
      signOut: async () => undefined,
    }),
  };
});

const { InlineApproval, InlineApprovalView, inlineApprovalState } = await import(
  "@/components/approvals/inline-approval"
);

const pending: ApprovalItem = {
  kind: "tool",
  id: "exec-1",
  title: "Send email",
  status: "approval_required",
  riskLevel: 2,
  createdAt: "2026-09-29T08:00:00.000Z",
};

const trust: TrustResponse = { enabled: true, threshold: 20, profiles: [] };

const politeRegion = '<div role="status" aria-live="polite" aria-atomic="true">';
const alertRegion = '<div role="alert" aria-atomic="true">';

const deepLink =
  "/app/approvals?id=exec-1&amp;kind=tool&amp;returnTo=%2Fapp%2Fcommand%3Fthread%3Dthread-1%26run%3Drun-1";

function view(overrides: Partial<ComponentProps<typeof InlineApprovalView>> = {}) {
  return renderToStaticMarkup(createElement(InlineApprovalView, {
    summary: "Waiting for approval: email.send",
    inboxHref: "/app/approvals?id=exec-1&kind=tool",
    ...overrides,
  }));
}

function inline() {
  return renderToStaticMarkup(createElement(InlineApproval, {
    executionId: "exec-1",
    summary: "Waiting for approval: email.send",
    returnTo: "/app/command?thread=thread-1&run=run-1",
  }));
}

describe("the inline approval banner", () => {
  it("links to the inbox when there is no card", () => {
    const html = view();

    expect(html).toContain('aria-label="Approval needed"');
    expect(html).toContain('data-inline-approval="link"');
    expect(html).toContain("Approval needed");
    expect(html).toContain("Waiting for approval: email.send");
    expect(html).toContain('href="/app/approvals?id=exec-1&amp;kind=tool"');
    expect(html).toContain(">Review</a>");
    expect(html).not.toContain("Open in Inbox");
    expect(html).not.toContain("Loading the approval…");
    // The regions a decision is announced in are there, empty, before it.
    expect(html).toContain(`${politeRegion}</div>${alertRegion}</div>`);
    expect(html.match(/role="(alert|status)"/g)).toHaveLength(2);
  });

  it("says it is loading and why there is no card", () => {
    const loading = view({ loading: true });
    expect(loading).toContain("Loading the approval…");
    expect(loading).toContain("animate-spin");

    const gone = view({ unavailable: "This approval is no longer waiting." });
    expect(gone).toContain("This approval is no longer waiting.");
    expect(gone).not.toContain("Loading the approval…");
  });

  it("shows the card with the inbox one step away", () => {
    const html = view({ card: createElement("div", { id: "card" }, "card body") });

    expect(html).toContain('data-inline-approval="card"');
    expect(html).toContain('<div class="mt-3"><div id="card">card body</div></div>');
    expect(html).toContain(">Open in Inbox</a>");
    expect(html).not.toContain(">Review</a>");
  });

  it("announces a decision and alerts on a failure", () => {
    const released = view({ notice: { message: "Approved and released: Send email.", tone: "success" } });
    expect(released).toMatch(new RegExp(
      `${politeRegion}<div class="mt-3 rounded-md border px-3 py-2 text-sm border-success/40[^"]*"><p>Approved and released: Send email\\.</p></div></div>${alertRegion}</div>`,
    ));

    const failed = view({ notice: { message: "Execution failed.", tone: "danger" } });
    expect(failed).toMatch(new RegExp(
      `${politeRegion}</div>${alertRegion}<div class="mt-3 rounded-md border px-3 py-2 text-sm border-danger/40[^"]*"><p>Execution failed\\.</p></div></div>`,
    ));

    const refused = view({ decisionError: "Already decided." });
    expect(refused).toContain(`${politeRegion}</div>${alertRegion}</div>`);
    expect(refused).toMatch(/<p class="[^"]*" role="alert">Already decided\.<\/p>/);
  });
});

describe("what the inline approval shows", () => {
  it("shows only the link without the permission to decide", () => {
    expect(inlineApprovalState("A operator role is required.", undefined, undefined))
      .toEqual({ loading: false });
    expect(inlineApprovalState(
      "A operator role is required.",
      { status: "ready", item: pending, trust },
      undefined,
    )).toEqual({ loading: false });
  });

  it("loads, then shows the card or says why there is none", () => {
    expect(inlineApprovalState(undefined, undefined, undefined)).toEqual({ loading: true });
    expect(inlineApprovalState(undefined, { status: "error" }, undefined)).toEqual({
      loading: false,
      unavailable: "The approval could not be loaded here. Review it in the inbox.",
    });
    expect(inlineApprovalState(undefined, { status: "ready", item: pending, trust }, undefined))
      .toEqual({ loading: false, item: pending, trust, unavailable: undefined });
    expect(inlineApprovalState(undefined, { status: "ready" }, undefined)).toMatchObject({
      loading: false,
      item: undefined,
      unavailable: "This approval is no longer waiting.",
    });
  });

  it("lets the notice speak once a decision went through", () => {
    expect(inlineApprovalState(
      undefined,
      { status: "ready", trust },
      { message: "Approved and released: Send email.", tone: "success" },
    )).toEqual({ loading: false, item: undefined, trust, unavailable: undefined });
  });
});

describe("the inline approval in a run", () => {
  it("loads the call for someone who may decide it", () => {
    session.role = "operator";
    session.status = "ready";
    const html = inline();

    expect(html).toContain("Loading the approval…");
    expect(html).toContain(`href="${deepLink}"`);
    expect(html).toContain('data-inline-approval="link"');
  });

  it("links a viewer, or a session still loading, to the inbox", () => {
    for (const [role, status] of [["viewer", "ready"], ["operator", "loading"]] as const) {
      session.role = role;
      session.status = status;
      const html = inline();

      expect(html).toContain(`href="${deepLink}"`);
      expect(html).toContain(">Review</a>");
      expect(html).not.toContain("Loading the approval…");
    }
  });
});
