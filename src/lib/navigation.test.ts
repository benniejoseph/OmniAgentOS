import { describe, expect, it } from "vitest";
import { appNav, appNavGroups, primaryNavItems } from "@/lib/navigation";

describe("everyday workspace navigation", () => {
  it("exposes the working Activity destination beside Assistant, Work, Memory and Capabilities", () => {
    expect(primaryNavItems.map(({ label, href }) => [label, href])).toEqual([
      ["Assistant", "/app/command"], ["Work", "/app/projects"],
      ["Activity", "/app/activity"], ["Memory", "/app/memory"],
      ["Capabilities", "/app/automation"],
    ]);
  });

  it("retains every catalog destination exactly once across Workspace and More", () => {
    const destinations = appNavGroups.flatMap(({ items }) => items.map(({ href }) => href));
    expect(destinations.toSorted()).toEqual(appNav.map(({ href }) => href).toSorted());
    expect(new Set(destinations).size).toBe(destinations.length);
    const more = appNavGroups.find(({ label }) => label === "More")!;
    expect(more.collapsible).toBe(true);
    expect(more.items.map(({ href }) => href)).toEqual(expect.arrayContaining([
      "/app", "/app/capture", "/app/approvals", "/app/results", "/app/workflows", "/app/responsibilities",
      "/app/connectors", "/app/meetings", "/app/accounts", "/app/markets",
      "/app/agents", "/app/payments", "/app/evaluations", "/app/observability",
      "/app/security", "/app/settings",
    ]));
  });

  it("exposes Responsibilities once in More and command search without replacing Work or Activity", () => {
    expect(appNav.filter(({ href }) => href === "/app/responsibilities").map(({ label }) => label)).toEqual(["Responsibilities"]);
    expect(appNavGroups.find(({ label }) => label === "More")?.items.some(({ href }) => href === "/app/responsibilities")).toBe(true);
    expect(primaryNavItems.map(({ href }) => href)).toEqual(expect.arrayContaining(["/app/projects", "/app/activity"]));
  });
});
