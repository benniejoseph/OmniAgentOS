import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard, DecisionNoticeRegion } from "@/components/approvals/approval-card";
import type { ApprovalItem, DecisionNotice } from "@/components/approvals/approval-decision";

function item(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: "tool",
    id: "exec-1",
    title: "Send email",
    status: "approval_required",
    riskLevel: 2,
    requestedBy: "owner-actor",
    reason: "Email leaves the workspace.",
    createdAt: "2026-09-29T08:00:00.000Z",
    input: { to: "sam@example.com" },
    ...overrides,
  };
}

function render(overrides: Partial<ComponentProps<typeof ApprovalCard>> = {}) {
  return renderToStaticMarkup(createElement(ApprovalCard, {
    item: item(),
    approverRole: "operator",
    approverId: "reviewer-actor",
    reason: "",
    onReason: () => undefined,
    breakGlass: false,
    onBreakGlass: () => undefined,
    ticket: "",
    onTicket: () => undefined,
    onDecide: () => undefined,
    ...overrides,
  }));
}

function approveButton(html: string) {
  return html.match(/<button[^>]*class="primary-button"[^>]*>/)?.[0] ?? "";
}

describe("ApprovalCard", () => {
  it("shows an ordinary tool approval under a section heading", () => {
    const html = render();

    // Focus can be put on the heading once a decision is read back.
    expect(html).toContain(
      '<h3 id="approval-heading-tool:exec-1" tabindex="-1" class="text-base font-semibold">Send email</h3>',
    );
    expect(html).toContain("tool call");
    expect(html).toContain("risk 2");
    expect(html).toContain("Requested ");
    expect(html).toContain(" by owner-actor");
    expect(html).toContain("Email leaves the workspace.");
    expect(html).toContain("Exact inputs");
    expect(html).toContain("Reject");
    expect(html).toContain("Approve and run");
    expect(html).toContain('aria-label="Decision reason"');
    expect(approveButton(html)).not.toContain("disabled");
    expect(html).not.toContain("data-focused");
    expect(html).not.toContain("Open conversation");
    expect(html).toContain("border-line");
  });

  it("states a tool's reversibility from its contract, not its risk", () => {
    const fact = (overrides: Partial<ApprovalItem>) =>
      render({ item: item(overrides) });

    const permanent = fact({
      riskLevel: 1,
      contract: { reversible: false, readOnly: false, effect: "Runs the checks." },
    });
    expect(permanent).toContain("Not reversible.");
    expect(permanent).not.toContain("can be edited or removed");
    expect(permanent).toContain("Runs the checks. The Send email tool executes for real");
    expect(fact({ riskLevel: 3, contract: { reversible: true, readOnly: false } }))
      .toContain("Reversible. Its tool contract declares");
    expect(fact({ riskLevel: 2, contract: { reversible: true, readOnly: true } }))
      .toContain("Read-only.");
    const unknown = fact({ riskLevel: 0 });
    expect(unknown).toContain("Not reversible.");
    expect(unknown).toContain("<p class=\"mt-1 text-sm leading-5\">The Send email tool executes");
    // Other approvals keep the facts their risk gives.
    expect(fact({ kind: "workflow", riskLevel: 2 })).toContain("Side-effecting.");
  });

  it("shows the exact inputs without a click", () => {
    expect(render()).toContain('<details open="" class="mt-4');
  });

  it("marks the item a link opened and links to the conversation it paused", () => {
    const html = render({
      focused: true,
      originHref: "/app/command?thread=thread-1&run=run-1",
    });

    expect(html).toContain('data-focused="true"');
    expect(html).toContain("border-primary ring-2");
    expect(html).toContain('href="/app/command?thread=thread-1&amp;run=run-1"');
    expect(html).toContain("Open conversation");
  });

  it("offers only reconciliation for an unresolved memory deletion", () => {
    const html = render({
      item: item({
        title: "Forget memory",
        status: "reconciliation_required",
        record: { toolId: "memory.forget" },
      }),
    });

    expect(html).toContain("reconciliation required");
    expect(html).toContain("Reconcile and continue");
    expect(html).toContain("Bound inputs");
    expect(html).toContain("If you continue");
    expect(html).not.toContain("Reject");
    expect(html).not.toContain("Decision reason");
  });

  it("explains why a risk 3 tool call cannot be approved here", () => {
    const risk3 = item({ riskLevel: 3 });

    const operator = render({ item: risk3 });
    expect(operator).toContain("Risk 3 tool calls require an admin approval.");
    expect(approveButton(operator)).toContain("disabled");
    expect(operator).toContain("0/2 distinct approvals recorded.");
    expect(operator).toContain("Record approval 1 of 2");

    const requester = render({ item: risk3, approverRole: "admin", approverId: "owner-actor" });
    expect(requester).toContain("The requester cannot approve their own risk 3 tool call.");

    const second = render({
      item: item({
        riskLevel: 3,
        record: { approvals: [{ by: "first-admin", role: "admin" }] },
      }),
      approverRole: "admin",
    });
    expect(second).toContain("1/2 distinct approvals recorded.");
    expect(second).toContain("Approve and run");
    expect(approveButton(second)).not.toContain("disabled");

    const repeat = render({
      item: item({ record: { approvals: [{ actorId: "reviewer-actor" }] } }),
    });
    expect(repeat).toContain("Your approval is already recorded.");
    expect(approveButton(repeat)).toContain("disabled");
  });

  it("asks for the emergency rationale and ticket a break-glass approval needs", () => {
    const policy = item({
      kind: "slo_policy",
      title: "Latency SLO",
      input: {
        approvalPolicy: { breakGlassAllowed: true },
        breakGlassPolicy: {
          enabled: true,
          requireTicket: true,
          reasonMinLength: 20,
          requiredRole: "operator",
        },
      },
    });

    const offered = render({ item: policy });
    expect(offered).toContain("SLO policy");
    expect(offered).toContain("Use emergency break-glass approval");
    expect(offered).not.toContain("Break-glass ticket reference");

    const short = render({ item: policy, breakGlass: true, reason: "too short" });
    expect(short).toContain("Emergency approve");
    expect(short).toContain("Required emergency rationale (20+ characters)");
    expect(short).toContain("Emergency approval requires at least 20 characters of rationale.");
    expect(short).toContain("Break-glass ticket reference");
    expect(approveButton(short)).toContain("disabled");

    const noTicket = render({
      item: policy,
      breakGlass: true,
      reason: "Paging storm; the SLO blocks the rollback.",
    });
    expect(noTicket).toContain("Emergency approval requires a ticket reference.");

    const ready = render({
      item: policy,
      breakGlass: true,
      reason: "Paging storm; the SLO blocks the rollback.",
      ticket: "INC-7",
    });
    expect(approveButton(ready)).not.toContain("disabled");
  });

  it("disables both decisions while one is sent", () => {
    const html = render({ inFlight: "approve" });

    expect(approveButton(html)).toContain("disabled");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*class="action-button"/);
    expect(html).toContain("animate-spin");
  });

  it("shows the evidence gate a reversible tool is earning", () => {
    const html = render({
      trust: {
        toolId: "email.send",
        cleanStreak: 5,
        successes: 9,
        failures: 1,
        autonomyMode: "approve_each",
        reversible: true,
      },
      threshold: 20,
    });

    expect(html).toContain("shadow evidence gate");
    expect(html).toContain("9 ok · 1 failed · streak 5");
    expect(html).toContain("5/20 clean executions toward earning autonomy.");
  });
});

describe("DecisionNoticeRegion", () => {
  const politeRegion = '<div role="status" aria-live="polite" aria-atomic="true">';
  const alertRegion = '<div role="alert" aria-atomic="true">';

  function region(notice?: DecisionNotice, next?: ReactNode) {
    return renderToStaticMarkup(createElement(
      DecisionNoticeRegion,
      { notice, className: "notice" },
      next,
    ));
  }

  it("is in the page, empty, before there is an outcome", () => {
    expect(region()).toBe(`${politeRegion}</div>${alertRegion}</div>`);
    expect(region(undefined, createElement("button", null, "Provision"))).toBe(
      `${politeRegion}</div>${alertRegion}</div>`,
    );
  });

  it("says an outcome politely, with what can be done next", () => {
    for (const [tone, classes] of [
      ["success", "border-success/40"],
      ["warning", "border-warning/45 bg-warning/10"],
      ["neutral", "border-line"],
    ] as const) {
      const html = region(
        { message: "Approved.", tone },
        createElement("button", null, "Provision"),
      );
      expect(html).toMatch(new RegExp(
        `^${politeRegion}<div class="notice ${classes}[^"]*"><p>Approved\\.</p><button>Provision</button></div></div>${alertRegion}</div>$`,
      ));
    }
  });

  it("alerts at once on a failure", () => {
    expect(region({ message: "Execution failed.", tone: "danger" })).toBe(
      `${politeRegion}</div>${alertRegion}<div class="notice border-danger/40 bg-danger/10 text-danger"><p>Execution failed.</p></div></div>`,
    );
  });
});
