import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>(), authEnabled: true, authenticated: true }));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => request.headers.get(name) ?? null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = request.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

vi.mock("@/lib/auth/server-workspace-session", () => ({
  getServerWorkspaceSession: async () => ({
    authEnabled: request.authEnabled,
    authenticated: request.authenticated,
    context: { tenantId: "tenant-1", actorId: "owner", role: "owner" },
  }),
}));

vi.mock("@/components/app-shell/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/app-shell/storage-warning", () => ({ StorageWarning: () => null }));
vi.mock("@/components/app-shell/session-context", () => ({
  WorkspaceSessionProvider: ({ children }: { children: ReactNode }) => children,
}));

const { default: AppLayout } = await import("@/app/app/layout");
const { AppShell } = await import("@/components/app-shell/app-shell");

function shellIn(node: ReactNode): ReactElement<{ initialDesktopNavCollapsed?: boolean }> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === AppShell) return node as ReactElement<{ initialDesktopNavCollapsed?: boolean }>;
  return shellIn(node.props.children);
}

describe("the workspace layout", () => {
  beforeEach(() => {
    request.cookies.clear(); request.headers.clear(); request.authEnabled = true; request.authenticated = true;
  });
  it("renders the shell at the navigation width the request's cookie holds", async () => {
    for (const [cookie, collapsed] of [["true", true], ["false", false], [undefined, undefined], ["on", undefined]] as const) {
      request.cookies.clear();
      if (cookie !== undefined) request.cookies.set("omni-desktop-nav-collapsed", cookie);

      const shell = shellIn(await AppLayout({ children: "page" }));

      expect(shell).toBeDefined();
      expect(shell!.props.initialDesktopNavCollapsed).toBe(collapsed);
    }
  });

  it("keeps an exact validated private route when redirecting an anonymous request", async () => {
    request.authenticated = false;
    const path = "/app/results/agent%3Arun%2Fopaque.v2?view=evidence&source=a%2Fb";
    request.headers.set("x-asael-return-path", path);
    await expect(AppLayout({ children: "private page" })).rejects.toMatchObject({
      digest: `NEXT_REDIRECT;replace;/login?next=${encodeURIComponent(path)};307;`,
    });
  });

  it("rejects malformed or external forwarded destinations before rendering private children", async () => {
    request.authenticated = false;
    for (const path of [undefined, "https://outside.invalid/app", "//outside.invalid/app", "/login", "/app/../security", "/app/%252e%252e/security"]) {
      request.headers.clear();
      if (path) request.headers.set("x-asael-return-path", path);
      await expect(AppLayout({ children: "private page" })).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/login;307;" });
    }
  });

  it("preserves authenticated and local-mode entry regardless of return metadata", async () => {
    request.headers.set("x-asael-return-path", "/app/command?thread=other");
    expect(shellIn(await AppLayout({ children: "page" }))).toBeDefined();
    request.authEnabled = false; request.authenticated = false;
    expect(shellIn(await AppLayout({ children: "local page" }))).toBeDefined();
  });
});
