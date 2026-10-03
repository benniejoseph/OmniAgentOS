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

function attribute(element: string, name: string) {
  return element.split(">")[0].match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function textContent(element: string) {
  return element
    .replace(/<[^>]+>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function elements(html: string, tag: string) {
  return html.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g")) ?? [];
}

function button(html: string, name: string | RegExp) {
  const found = elements(html, "button").find((element) => {
    const label = textContent(element).trim();
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (!found) throw new Error(`Missing decision button: ${name}`);
  return found;
}

function approveButton(html: string) {
  return button(html, /^(Approve and run|Emergency approve|Record approval \d+ of \d+|Reconcile and continue)$/);
}

function input(html: string, label: string) {
  const found = html.match(/<input\b[^>]*>/g)?.find((element) =>
    attribute(element, "aria-label") === label,
  );
  if (!found) throw new Error(`Missing input: ${label}`);
  return found;
}

function description(html: string, control: string) {
  const ids = attribute(control, "aria-describedby");
  if (!ids) throw new Error("The control does not reference an explanation.");
  return ids.split(/\s+/).map((id) => {
    const paragraph = elements(html, "p").find((element) => attribute(element, "id") === id);
    if (!paragraph) throw new Error(`Missing explanation: ${id}`);
    return textContent(paragraph);
  }).join(" ");
}

function exactInputs(html: string, label = "Exact inputs (secrets redacted)") {
  const disclosure = elements(html, "details")[0];
  if (!disclosure) throw new Error("Missing input disclosure.");
  expect(attribute(disclosure, "open")).toBe("");
  const summary = elements(disclosure, "summary")[0];
  const region = elements(disclosure, "pre")[0];
  if (!summary || !region) throw new Error("Missing input label or region.");
  const labelId = attribute(summary, "id");
  expect(labelId).toBeTruthy();
  expect(textContent(summary)).toBe(label);
  expect(attribute(region, "role")).toBe("region");
  expect(attribute(region, "aria-labelledby")).toBe(labelId);
  expect(attribute(region, "tabindex")).toBe("0");
  return region;
}

describe("ApprovalCard", () => {
  it("shows an ordinary tool approval under a section heading", () => {
    const html = render();

    // Focus can be put on the heading once a decision is read back.
    const heading = elements(html, "h3")[0];
    const article = elements(html, "article")[0];
    if (!heading || !article) throw new Error("Missing approval heading or article.");
    expect(attribute(heading, "id")).toBe("approval-heading-tool:exec-1");
    expect(attribute(heading, "tabindex")).toBe("-1");
    expect(textContent(heading)).toBe("Send email");
    expect(attribute(article, "aria-labelledby"))
      .toBe(attribute(heading, "id"));
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
    expect(attribute(approveButton(html), "aria-describedby")).toBeUndefined();
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
    expect(elements(unknown, "dd").some((fact) =>
      textContent(fact).startsWith("The Send email tool executes"),
    )).toBe(true);
    // Other approvals keep the facts their risk gives.
    expect(fact({ kind: "workflow", riskLevel: 2 })).toContain("Side-effecting.");
  });

  it("shows the full exact inputs in an open, named keyboard region", () => {
    const reviewedInput = {
      to: "sam@example.com",
      body: "First line\nSecond line with <review> & exact text.",
      attachments: Array.from({ length: 24 }, (_, index) => ({
        name: `proof-${index}`,
        target: `https://example.com/${"x".repeat(128)}/${index}`,
      })),
    };
    const region = exactInputs(render({ item: item({ input: reviewedInput }) }));

    expect(textContent(region)).toBe(JSON.stringify(reviewedInput, null, 2));
  });

  it("omits the input region when there are no inputs to review", () => {
    for (const input of [undefined, {}]) {
      const html = render({ item: item({ input }) });
      expect(elements(html, "details")).toHaveLength(0);
      expect(html).not.toContain('role="region"');
    }
  });

  it("marks the item a link opened and links to the conversation it paused", () => {
    const html = render({
      focused: true,
      originHref: "/app/command?thread=thread-1&run=run-1",
    });

    expect(html).toContain('data-focused="true"');
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
    expect(textContent(exactInputs(html, "Bound inputs (secrets redacted)")))
      .toBe(JSON.stringify(item().input, null, 2));
    expect(html).toContain("If you continue");
    expect(html).not.toContain("Reject");
    expect(html).not.toContain("Decision reason");
    expect(html).toContain("No new approval is granted.");
    expect(elements(html, "button")).toHaveLength(1);
    expect(attribute(button(html, "Reconcile and continue"), "disabled")).toBeUndefined();
  });

  it("explains why a risk 3 tool call cannot be approved here", () => {
    const risk3 = item({ riskLevel: 3 });

    const operator = render({ item: risk3 });
    expect(description(operator, approveButton(operator)))
      .toBe("Risk 3 tool calls require an admin approval.");
    expect(approveButton(operator)).toContain("disabled");
    expect(attribute(button(operator, "Reject"), "disabled")).toBeUndefined();
    expect(operator).toContain("0/2 distinct approvals recorded.");
    expect(operator).toContain("Record approval 1 of 2");

    const requester = render({ item: risk3, approverRole: "admin", approverId: "owner-actor" });
    expect(description(requester, approveButton(requester)))
      .toBe("The requester cannot approve their own risk 3 tool call.");
    expect(attribute(approveButton(requester), "disabled")).toBe("");

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
    expect(attribute(approveButton(second), "aria-describedby")).toBeUndefined();

    const repeat = render({
      item: item({ record: { approvals: [{ actorId: "reviewer-actor" }] } }),
    });
    expect(description(repeat, approveButton(repeat)))
      .toBe("Your approval is already recorded. Another eligible approver must review this item.");
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
    const rationale = input(short, "Required break-glass rationale");
    expect(attribute(rationale, "aria-invalid")).toBe("true");
    expect(description(short, rationale))
      .toBe("Emergency approval requires at least 20 characters of rationale.");
    expect(description(short, approveButton(short))).toBe(description(short, rationale));
    const missingTicket = input(short, "Break-glass ticket reference");
    expect(attribute(missingTicket, "aria-invalid")).toBe("true");
    // The rationale message must not be announced as the ticket's error.
    expect(attribute(missingTicket, "aria-describedby")).toBeUndefined();

    const noTicket = render({
      item: policy,
      breakGlass: true,
      reason: "Paging storm; the SLO blocks the rollback.",
    });
    const ticket = input(noTicket, "Break-glass ticket reference");
    expect(attribute(ticket, "aria-invalid")).toBe("true");
    expect(description(noTicket, ticket)).toBe("Emergency approval requires a ticket reference.");
    expect(description(noTicket, approveButton(noTicket))).toBe(description(noTicket, ticket));
    expect(attribute(input(noTicket, "Required break-glass rationale"), "aria-invalid"))
      .toBeUndefined();
    expect(attribute(input(noTicket, "Required break-glass rationale"), "aria-describedby"))
      .toBeUndefined();

    const ready = render({
      item: policy,
      breakGlass: true,
      reason: "Paging storm; the SLO blocks the rollback.",
      ticket: "INC-7",
    });
    expect(approveButton(ready)).not.toContain("disabled");
    expect(attribute(approveButton(ready), "aria-describedby")).toBeUndefined();
    for (const label of ["Required break-glass rationale", "Break-glass ticket reference"]) {
      expect(attribute(input(ready, label), "aria-invalid")).toBeUndefined();
      expect(attribute(input(ready, label), "aria-describedby")).toBeUndefined();
    }
  });

  it("links required attestation to its error until the trimmed rationale is valid", () => {
    const policy = item({
      kind: "slo_policy",
      input: { approvalPolicy: { attestationRequired: true } },
    });
    const short = render({ item: policy, reason: "  too short  " });
    const attestation = input(short, "Required approval attestation");

    expect(attribute(attestation, "aria-invalid")).toBe("true");
    expect(description(short, attestation))
      .toBe("This approval requires an attestation of at least 12 characters.");
    expect(description(short, approveButton(short))).toBe(description(short, attestation));
    expect(attribute(approveButton(short), "disabled")).toBe("");

    const valid = render({ item: policy, reason: "Reviewed policy scope." });
    expect(attribute(input(valid, "Required approval attestation"), "aria-invalid"))
      .toBeUndefined();
    expect(attribute(input(valid, "Required approval attestation"), "aria-describedby"))
      .toBeUndefined();
    expect(attribute(approveButton(valid), "disabled")).toBeUndefined();
    expect(attribute(approveButton(valid), "aria-describedby")).toBeUndefined();
  });

  it("describes policy restrictions first while keeping the form error with its input", () => {
    const policy = item({
      kind: "slo_policy",
      input: { approvalPolicy: { requiredRoles: ["admin"], attestationRequired: true } },
    });
    const html = render({ item: policy });
    const approval = approveButton(html);
    const attestation = input(html, "Required approval attestation");

    expect(attribute(approval, "disabled")).toBe("");
    expect(description(html, approval)).toBe("This policy change requires one of these roles: admin.");
    expect(description(html, attestation))
      .toBe("This approval requires an attestation of at least 12 characters.");
    expect(attribute(approval, "aria-describedby"))
      .not.toBe(attribute(attestation, "aria-describedby"));

    const completedForm = render({ item: policy, reason: "Reviewed policy scope." });
    expect(attribute(approveButton(completedForm), "disabled")).toBe("");
    expect(description(completedForm, approveButton(completedForm)))
      .toBe("This policy change requires one of these roles: admin.");
    expect(attribute(input(completedForm, "Required approval attestation"), "aria-describedby"))
      .toBeUndefined();
  });

  it("keeps input labels and blocked explanations scoped to their own card", () => {
    const cards = ["exec-1", "exec-2"].map((id) => render({ item: item({ id, riskLevel: 3 }) }));
    const ids = [...cards.join("").matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(ids).size).toBe(ids.length);
    for (const card of cards) {
      exactInputs(card);
      expect(description(card, approveButton(card)))
        .toBe("Risk 3 tool calls require an admin approval.");
    }
    expect(attribute(exactInputs(cards[0]), "aria-labelledby"))
      .not.toBe(attribute(exactInputs(cards[1]), "aria-labelledby"));
    expect(attribute(approveButton(cards[0]), "aria-describedby"))
      .not.toBe(attribute(approveButton(cards[1]), "aria-describedby"));
  });

  it("disables both decisions while one is sent without a stale blocked explanation", () => {
    for (const inFlight of ["approve", "reject"]) {
      const html = render({ inFlight });

      expect(attribute(approveButton(html), "disabled")).toBe("");
      expect(attribute(button(html, "Reject"), "disabled")).toBe("");
      expect(attribute(approveButton(html), "aria-describedby")).toBeUndefined();
      expect(html).toContain("Recording decision…");
    }
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
    for (const tone of ["success", "warning", "neutral"] as const) {
      const html = region(
        { message: "Approved.", tone },
        createElement("button", null, "Provision"),
      );
      const [polite, alert] = html.split(alertRegion);
      expect(polite.startsWith(politeRegion)).toBe(true);
      expect(textContent(polite)).toBe("Approved.Provision");
      expect(button(polite, "Provision")).toBeDefined();
      expect(alert).toBe("</div>");
      expect(html.match(/role="(alert|status)"/g)).toHaveLength(2);
      expect(html.match(/Approved\./g)).toHaveLength(1);
    }
  });

  it("alerts at once on a failure", () => {
    const html = region({ message: "Execution failed.", tone: "danger" });
    const [polite, alert] = html.split(alertRegion);

    expect(polite).toBe(`${politeRegion}</div>`);
    expect(textContent(alert)).toBe("Execution failed.");
    expect(html.match(/role="(alert|status)"/g)).toHaveLength(2);
    expect(html.match(/Execution failed\./g)).toHaveLength(1);
  });
});
