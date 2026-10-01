import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
  pathname: "/app/command",
  pending: 3 as number | undefined,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => shell.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/app-shell/session-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/app-shell/session-context")>();
  return {
    ...actual,
    useWorkspaceSession: () => ({
      session: {
        authEnabled: true,
        authenticated: true,
        context: { tenantId: "tenant-1", actorId: "reviewer", role: "operator" },
      },
      status: "ready",
      role: "operator",
      refresh: async () => undefined,
      signOut: async () => undefined,
    }),
  };
});

vi.mock("@/components/app-shell/use-inbox-count", () => ({
  useInboxCount: () => (shell.pending === undefined ? undefined : { pending: shell.pending }),
}));

vi.mock("@/components/app-shell/command-palette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/app-shell/notification-center", () => ({ NotificationCenter: () => null }));
vi.mock("@/components/theme/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/brand/asael-mark", () => ({ AsaelMark: () => null }));

const { AppShell, CompactNavigation, MobileNavigation } = await import(
  "@/components/app-shell/app-shell"
);

function renderShell(pathname: string, pending: number | undefined) {
  shell.pathname = pathname;
  shell.pending = pending;
  return renderToStaticMarkup(createElement(AppShell, null, createElement("p", null, "page")));
}

function linkTo(html: string, href: string) {
  return html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>[\\s\\S]*?</a>`, "g")) ?? [];
}

describe("the inbox count in the app shell", () => {
  it("offers the inbox from the header and counts it on a collapsed group", () => {
    const html = renderShell("/app/command", 3);

    const inboxLinks = linkTo(html, "/app/approvals");
    expect(inboxLinks).toHaveLength(1);
    expect(inboxLinks[0]).toContain('class="notification-trigger"');
    expect(inboxLinks[0]).toContain('aria-label="Inbox, 3 waiting"');
    expect(html).toContain('aria-label="Review, 3 waiting"');
    expect(html).toContain('data-nav-count="3"');
  });

  it("counts on the Inbox item inside the inbox, without the header link", () => {
    const html = renderShell("/app/approvals", 3);

    expect(html).not.toContain("notification-trigger");
    const inboxLinks = linkTo(html, "/app/approvals");
    expect(inboxLinks).toHaveLength(1);
    expect(inboxLinks[0]).toContain('aria-label="Inbox, 3 waiting"');
    expect(inboxLinks[0]).toContain('aria-current="page"');
    expect(inboxLinks[0]).toContain("bg-primary-ink text-primary");
    expect(html).not.toContain('aria-label="Review, 3 waiting"');
  });

  it("shows no count with nothing waiting", () => {
    for (const pending of [0, undefined]) {
      const html = renderShell("/app/command", pending);

      expect(html).not.toContain("notification-trigger");
      expect(html).not.toContain("data-nav-count");
      expect(html).not.toContain("waiting");
    }
  });
});

describe("the inbox count in the other navigations", () => {
  it("marks the Inbox icon in the compact navigation", () => {
    const html = renderToStaticMarkup(createElement(CompactNavigation, {
      pathname: "/app/command",
      inboxCount: 12,
    }));

    const inbox = linkTo(html, "/app/approvals")[0] ?? "";
    expect(inbox).toContain('aria-label="Inbox, 12 waiting"');
    expect(inbox).toContain("absolute right-1 top-1");
    expect(inbox).toContain('data-nav-count="12"');
    expect(linkTo(html, "/app/command")[0]).toContain('aria-label="Command"');
    expect(html.match(/data-nav-count/g)).toHaveLength(1);

    const none = renderToStaticMarkup(createElement(CompactNavigation, { pathname: "/app/command" }));
    expect(linkTo(none, "/app/approvals")[0]).toContain('aria-label="Inbox"');
    expect(none).not.toContain("data-nav-count");
  });

  it("counts the Inbox in the mobile menu", () => {
    const html = renderToStaticMarkup(createElement(MobileNavigation, {
      pathname: "/app/command",
      inboxCount: 5,
      onNavigate: () => undefined,
    }));

    const inbox = linkTo(html, "/app/approvals")[0] ?? "";
    expect(inbox).toContain('aria-label="Inbox, 5 waiting"');
    expect(inbox).toContain('data-nav-count="5"');
    expect(inbox).toContain("bg-primary text-primary-ink");
    expect(html.match(/data-nav-count/g)).toHaveLength(1);
    expect(linkTo(html, "/app/command")[0]).not.toContain("aria-label");

    const inside = linkTo(renderToStaticMarkup(createElement(MobileNavigation, {
      pathname: "/app/approvals",
      inboxCount: 5,
      onNavigate: () => undefined,
    })), "/app/approvals")[0] ?? "";
    expect(inside).toContain('aria-current="page"');
    expect(inside).toContain("bg-primary-ink text-primary");
  });
});

describe("the desktop navigation width", () => {
  function shellWith(initialDesktopNavCollapsed: boolean | undefined) {
    shell.pathname = "/app/command";
    shell.pending = undefined;
    return renderToStaticMarkup(createElement(
      AppShell,
      { initialDesktopNavCollapsed } as Parameters<typeof AppShell>[0],
      createElement("p", null, "page"),
    ));
  }

  it("renders at the width the request's cookie remembers", () => {
    const collapsed = shellWith(true);
    expect(collapsed).toContain("lg:pl-20");
    expect(collapsed).not.toContain("lg:pl-60");
    expect(collapsed).toContain('aria-label="Expand workspace navigation"');

    for (const value of [false, undefined]) {
      const expanded = shellWith(value);
      expect(expanded).toContain("lg:pl-60");
      expect(expanded).not.toContain("lg:pl-20");
      expect(expanded).toContain('aria-label="Collapse workspace navigation"');
    }
  });
});
