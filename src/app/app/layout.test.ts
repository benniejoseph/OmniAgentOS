import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = request.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

vi.mock("@/lib/auth/server-workspace-session", () => ({
  getServerWorkspaceSession: async () => ({
    authEnabled: true,
    authenticated: true,
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
  it("renders the shell at the navigation width the request's cookie holds", async () => {
    for (const [cookie, collapsed] of [["true", true], ["false", false], [undefined, undefined], ["on", undefined]] as const) {
      request.cookies.clear();
      if (cookie !== undefined) request.cookies.set("omni-desktop-nav-collapsed", cookie);

      const shell = shellIn(await AppLayout({ children: "page" }));

      expect(shell).toBeDefined();
      expect(shell!.props.initialDesktopNavCollapsed).toBe(collapsed);
    }
  });
});
