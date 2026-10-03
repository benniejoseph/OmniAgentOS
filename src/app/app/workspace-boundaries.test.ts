import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { redirect } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";

const today = vi.hoisted(() => ({
  show: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // The boundaries are called as plain functions below, so their effect runs
  // as they are called.
  useEffect: (effect: () => void) => {
    effect();
  },
}));

vi.mock("@/lib/auth/server-workspace-session", () => ({
  getServerWorkspaceSession: async () => ({
    authEnabled: true,
    authenticated: true,
    context: { tenantId: "tenant-1", actorId: "owner", role: "owner" },
  }),
}));

vi.mock("@/lib/app-services/contracts", () => ({
  createAppServiceCaller: (caller: unknown) => caller,
}));

vi.mock("@/lib/app-services/cohesive-today", () => ({
  showCohesiveTodayService: today.show,
}));

vi.mock("@/components/today-workspace", () => ({
  TodayWorkspace: () => null,
}));

const { default: AppDashboardPage } = await import("@/app/app/page");
const { default: WorkspaceLoading } = await import("@/app/app/loading");
const { default: WorkspaceError } = await import("@/app/app/error");
const { default: CommandError } = await import("@/app/app/command/error");
const { default: GlobalError } = await import("@/app/global-error");
const { default: PageError } = await import("@/app/error");
const { TodayWorkspace } = await import("@/components/today-workspace");

afterEach(() => {
  vi.restoreAllMocks();
  today.show.mockReset();
});

type Props = { children?: ReactNode; onClick?: () => void; href?: string };

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function buttons(node: ReactNode) {
  return elements(node).filter((element) => element.type === "button");
}

describe("Today when its server projection fails", () => {
  it("opens Today to load in the browser, and logs no error detail", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    today.show.mockRejectedValueOnce(new Error("connection to db.internal refused"));

    const page = (await AppDashboardPage()) as ReactElement<{ initialProjection?: unknown }>;

    expect(page.type).toBe(TodayWorkspace);
    expect(page.props.initialProjection).toBeUndefined();
    expect(logged.mock.calls).toEqual([["Today could not be prepared on the server.", "Error"]]);
  });

  it("passes on the projection it prepared", async () => {
    const projection = { today: {}, sources: [] };
    today.show.mockResolvedValueOnce({ data: { projection } });

    const page = (await AppDashboardPage()) as ReactElement<{ initialProjection?: unknown }>;

    expect(page.type).toBe(TodayWorkspace);
    expect(page.props.initialProjection).toBe(projection);
  });

  it("still redirects when preparing it redirects", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    today.show.mockImplementationOnce(async () => redirect("/login"));

    await expect(AppDashboardPage()).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("the workspace loading state", () => {
  it("tells assistive technology the view is loading", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceLoading));
    expect(html).toContain('role="status" aria-busy="true"');
    expect(html).toContain("Loading the workspace.");
  });
});

describe("recovering from a view that fails to render", () => {
  for (const [name, Boundary, destination] of [
    ["the workspace", WorkspaceError, "/app"],
    ["Command", CommandError, "/app"],
    ["the page", PageError, "/"],
  ] as const) {
    it(`fetches ${name} view again on retry, and offers a way back`, () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const error = new Error("render failed");
      const retry = vi.fn();
      const reset = vi.fn();

      const tree = Boundary({ error, retry, reset } as Parameters<typeof Boundary>[0]);
      const [retryButton] = buttons(tree);
      retryButton!.props.onClick!();

      expect(retry).toHaveBeenCalledTimes(1);
      expect(reset).not.toHaveBeenCalled();
      expect(elements(tree).some((element) => element.type === "a" && element.props.href === destination))
        .toBe(true);
      expect(logged).toHaveBeenCalledWith(expect.any(String), error);
    });
  }

  it("replaces the whole document when the root layout fails, and retries", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const retry = vi.fn();
    const props = { error: new Error("layout failed"), retry };

    const tree = GlobalError(props);
    expect(tree.type).toBe("html");
    const [retryButton] = buttons(tree);
    retryButton!.props.onClick!();
    expect(retry).toHaveBeenCalledTimes(1);

    const html = renderToStaticMarkup(createElement(GlobalError, props));
    expect(html).toMatch(/^<html lang="en"[^>]*><head><title>Asael is unavailable<\/title><\/head><body/);
    expect(html).toContain("Try again");
  });
});
