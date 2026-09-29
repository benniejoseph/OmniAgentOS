import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  INBOX_HREF,
  InboxHeaderLink,
  NavCountPill,
  navBadgeLabel,
  navGroupBadgeLabel,
  navItemAccessibleName,
} from "@/components/app-shell/inbox-badge";

describe("navigation counts", () => {
  it("puts the inbox count on the Inbox alone", () => {
    expect(navBadgeLabel(INBOX_HREF, 3)).toBe("3");
    expect(navBadgeLabel(INBOX_HREF, 120)).toBe("99+");
    expect(navBadgeLabel(INBOX_HREF, 0)).toBe("");
    expect(navBadgeLabel(INBOX_HREF, undefined)).toBe("");
    expect(navBadgeLabel("/app/results", 3)).toBe("");
    expect(navBadgeLabel("/app/approvals/history", 3)).toBe("");
  });

  it("shows the count on a collapsed group that holds the Inbox", () => {
    expect(navGroupBadgeLabel([{ href: "/app/results" }, { href: INBOX_HREF }], 4)).toBe("4");
    expect(navGroupBadgeLabel([{ href: "/app/results" }], 4)).toBe("");
    expect(navGroupBadgeLabel([{ href: INBOX_HREF }], 0)).toBe("");
  });

  it("says the count in the item's name", () => {
    expect(navItemAccessibleName("Inbox", "3")).toBe("Inbox, 3 waiting");
    expect(navItemAccessibleName("Inbox", "")).toBe("Inbox");
  });
});

describe("the header way into the inbox", () => {
  function render(count: number | undefined, pathname = "/app/command") {
    return renderToStaticMarkup(createElement(InboxHeaderLink, { count, pathname }));
  }

  it("shows while something waits", () => {
    const html = render(3);

    expect(html).toContain('href="/app/approvals"');
    expect(html).toContain('class="notification-trigger"');
    expect(html).toContain('aria-label="Inbox, 3 waiting"');
    expect(html).toContain('title="Inbox"');
    expect(html).toContain('<span aria-hidden="true">3</span>');
    expect(render(250)).toContain('aria-label="Inbox, 99+ waiting"');
  });

  it("is absent with nothing waiting or inside the inbox", () => {
    expect(render(0)).toBe("");
    expect(render(undefined)).toBe("");
    expect(render(3, "/app/approvals")).toBe("");
    expect(render(3, "/app/approvals/history")).toBe("");
    expect(render(3, "/app/approvals-archive")).toContain("Inbox, 3 waiting");
  });
});

describe("the count pill", () => {
  function render(props: { badge: string; active?: boolean; compact?: boolean }) {
    return renderToStaticMarkup(createElement(NavCountPill, props));
  }

  it("shows the count beside a label, or on an icon's corner", () => {
    const pill = render({ badge: "3" });
    expect(pill).toContain('data-nav-count="3"');
    expect(pill).toContain('aria-hidden="true"');
    expect(pill).toContain("bg-primary text-primary-ink");
    expect(pill).toContain("min-w-5");
    expect(pill).not.toContain("absolute");

    expect(render({ badge: "3", active: true })).toContain("bg-primary-ink text-primary");
    const compact = render({ badge: "3", compact: true });
    expect(compact).toContain("absolute right-1 top-1");
    expect(compact).not.toContain("min-w-5");
  });

  it("is absent without a count", () => {
    expect(render({ badge: "" })).toBe("");
  });
});
