import { describe, expect, it } from "vitest";
import { appNav, appNavGroups, navigationItems, primaryNavItems } from "@/lib/navigation";

describe("personal partner navigation", () => {
  it("puts the four everyday places in a consistent order", () => {
    expect(primaryNavItems.map(({ label, href }) => [label, href])).toEqual([
      ["Today", "/app"], ["Assistant", "/app/command"],
      ["My work", "/app/projects"], ["Library", "/app/memory"],
    ]);
  });

  it("keeps canonical destinations reachable exactly once without duplicating nested tools", () => {
    const destinations = appNavGroups.flatMap(({ items }) => items.map(({ href }) => href));
    expect(destinations).toEqual(navigationItems.map(({ href }) => href));
    expect(destinations).toEqual(expect.arrayContaining(["/app/history", "/app/approvals", "/app/settings", "/app/security"]));
    expect(destinations).not.toEqual(expect.arrayContaining(["/app/evaluations", "/app/observability"]));
    expect(new Set(destinations).size).toBe(destinations.length);
    const more = appNavGroups.find(({ label }) => label === "More")!;
    expect(more.collapsible).toBe(true);
    expect(more.items.map(({ href }) => href)).toEqual(expect.arrayContaining([
      "/app/capture", "/app/automation", "/app/responsibilities",
      "/app/meetings", "/app/markets", "/app/agents",
    ]));
    expect(more.items.some(({ href }) => primaryNavItems.some((item) => item.href === href))).toBe(false);
  });

  it("uses one Needs you inbox and keeps disabled Payments out of navigation and command search", () => {
    expect(appNav.filter(({ href }) => href === "/app/approvals").map(({ label }) => label)).toEqual(["Needs you"]);
    expect(appNav.some(({ href }) => href === "/app/payments")).toBe(false);
    expect(appNav.filter(({ href }) => href === "/app/responsibilities")).toHaveLength(1);
  });
});
