import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  NotificationDispositionHistoryView,
  type NotificationDispositionView,
} from "@/components/app-shell/notification-disposition-history";

describe("content-free notification decision history", () => {
  it("explains send, defer, digest, and suppress outcomes without source content", () => {
    const dispositions: Array<NotificationDispositionView & { notificationContent?: string }> = [
      disposition("send", "approval_required", { deliveryBindingSha256: "b".repeat(64) }),
      disposition("defer", "quiet_hours", { dueAt: "2026-09-22T13:15:00.000Z" }),
      disposition("digest", "digest_nonurgent"),
      disposition("suppress", "routine_success", { notificationContent: "never-render-this" }),
    ];
    const markup = renderToStaticMarkup(createElement(NotificationDispositionHistoryView, {
      state: "ready",
      dispositions,
    }));
    expect(markup).toContain("Delivery decisions");
    expect(markup).toContain("This history is content-free");
    expect(markup).toContain("Sent directly");
    expect(markup).toContain("Held until later");
    expect(markup).toContain("Grouped into a digest");
    expect(markup).toContain("Skipped");
    expect(markup).toContain("Quiet hours delayed a required alert");
    expect(markup).toContain("Decision receipt");
    expect(markup).toContain("Delivery binding");
    expect(markup).not.toContain("Delivery receipt");
    expect(markup).not.toContain("never-render-this");
  });

  it("has explicit loading, unavailable, and empty states", () => {
    const loading = renderToStaticMarkup(createElement(NotificationDispositionHistoryView, {
      state: "loading", dispositions: [],
    }));
    const error = renderToStaticMarkup(createElement(NotificationDispositionHistoryView, {
      state: "error", dispositions: [], error: "Decision history unavailable.",
    }));
    const empty = renderToStaticMarkup(createElement(NotificationDispositionHistoryView, {
      state: "ready", dispositions: [],
    }));
    expect(loading).toContain('aria-busy="true"');
    expect(error).toContain('role="alert"');
    expect(error).toContain("Decision history unavailable");
    expect(empty).toContain("No proactive delivery decisions");
  });
});

function disposition(
  outcome: NotificationDispositionView["outcome"],
  reason: string,
  overrides: Partial<NotificationDispositionView> & { notificationContent?: string } = {},
): NotificationDispositionView & { notificationContent?: string } {
  return {
    dispositionId: `disposition-${outcome}`,
    sourceKind: "scheduled_routine",
    outcome,
    state: outcome === "defer" || outcome === "digest" ? "pending" : "terminal",
    reason,
    mustSend: outcome === "send" || outcome === "defer",
    critical: false,
    decisionReceiptSha256: "a".repeat(64),
    evaluatedAt: "2026-09-22T13:00:00.000Z",
    dueAt: null,
    deliveryKind: null,
    deliveryBindingSha256: null,
    updatedAt: "2026-09-22T13:00:00.000Z",
    terminalAt: outcome === "send" || outcome === "suppress" ? "2026-09-22T13:00:00.000Z" : null,
    contentIncluded: false,
    ...overrides,
  };
}
