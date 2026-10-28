import { describe, expect, it } from "vitest";
import { createForgeWriteWindow } from "./forge-write-window";

const mutation = () => ({
  toolId: "app.projects.builder.file.edit", status: "executed" as const, dryRun: false,
  input: { path: "src/fixture.test.ts", expectedSha256: "a".repeat(64) },
  output: { update: { path: "src/fixture.test.ts", previousSha256: "a".repeat(64), sha256: "b".repeat(64) } },
});

describe("Forge write window within the existing run", () => {
  it("opens once with three remaining rounds, preserving exact reads and edit tools", () => {
    const window = createForgeWriteWindow(true);
    expect(window.enter(4)).toBeUndefined();
    expect(window.allows("app.projects.builder.search")).toBe(true);
    expect(window.enter(3)).toMatchObject({ label: "Forge write window", detail: expect.stringContaining("3 existing tool rounds") });
    expect(window.enter(2)).toBeUndefined();
    expect(window.allows("app.projects.builder.tree")).toBe(false);
    expect(window.allows("app.projects.builder.search")).toBe(false);
    for (const id of ["file.read", "framework-doc.read", "file.edit", "file.update", "file.delete"]) {
      expect(window.allows(`app.projects.builder.${id}`)).toBe(true);
    }
    expect(window.instructions(2)).toContain("2 existing tool rounds");
    expect(window.instructions(0)).toBe("");
  });

  it.each(["ordinary", "exhausted", "changed"] as const)("does not open for %s", mode => {
    const window = createForgeWriteWindow(mode !== "ordinary");
    if (mode === "changed") window.observeExecution(mutation());
    expect(window.enter(mode === "exhausted" ? 0 : 3)).toBeUndefined();
    expect(window.allows("app.projects.builder.search")).toBe(true);
  });

  it.each(["failed", "dry_run", "pending", "noop", "wrong_path", "wrong_hash"] as const)("does not mistake %s for a saved change", mode => {
    const window = createForgeWriteWindow(true), value = mutation();
    window.observeExecution({ ...value,
      status: mode === "failed" ? "failed" : mode === "pending" ? "approval_required" : value.status,
      dryRun: mode === "dry_run",
      output: { update: { ...value.output.update,
        ...(mode === "noop" ? { sha256: "a".repeat(64) } : {}),
        ...(mode === "wrong_path" ? { path: "src/other.test.ts" } : {}),
        ...(mode === "wrong_hash" ? { previousSha256: "c".repeat(64) } : {}),
      } },
    });
    expect(window.enter(3)?.label).toBe("Forge write window");
  });

  it("never reopens discovery after entering, even when a later edit succeeds", () => {
    const window = createForgeWriteWindow(true);
    window.enter(3); window.observeExecution(mutation());
    expect(window.enter(2)).toBeUndefined();
    expect(window.allows("app.projects.builder.search")).toBe(false);
  });
});
