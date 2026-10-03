import { describe, expect, it } from "vitest";
import {
  createUniverseSelectionGuard,
  universeDetailForSelection,
} from "@/components/memory-universe-selection";

describe("Universe explicit detail selection", () => {
  it("ignores an older completion after a newer point has been selected", async () => {
    const guard = createUniverseSelectionGuard();
    const shown: string[] = [];
    let finishFirst!: () => void;
    const first = guard.begin("evidence", "first");
    const firstRead = new Promise<void>((resolve) => { finishFirst = resolve; })
      .then(() => { if (guard.isCurrent(first)) shown.push(first.id); });
    const second = guard.begin("evidence", "second");
    if (guard.isCurrent(second)) shown.push(second.id);
    finishFirst();
    await firstRead;
    expect(first.controller.signal.aborted).toBe(true);
    expect(shown).toEqual(["second"]);
  });

  it("separates the same opaque ID in different layers and invalidates cleared requests", () => {
    const guard = createUniverseSelectionGuard();
    const evidence = guard.begin("evidence", "same-id");
    const explicit = guard.begin("verified", "same-id");
    expect(guard.isCurrent(evidence)).toBe(false);
    expect(guard.isCurrent(explicit)).toBe(true);
    guard.clear();
    expect(explicit.controller.signal.aborted).toBe(true);
    expect(guard.isCurrent(explicit)).toBe(false);
    const reopened = guard.begin("verified", "same-id");
    expect(guard.isCurrent(explicit)).toBe(false);
    expect(guard.isCurrent(reopened)).toBe(true);
  });

  it("requires the selected ID, matching response layer and version", () => {
    const selected = { mode: "evidence" as const, id: "chosen/point" };
    const detail = { id: selected.id, label: "Selected only" };
    expect(universeDetailForSelection({ version: "memory-universe-node:1", node: detail }, selected)).toBe(detail);
    for (const body of [
      { version: "memory-universe-node:1", node: { id: "different" } },
      { version: "memory-universe-node:1", node: null },
      { version: "memory-universe-entity:1", entity: detail },
      { version: "memory-universe-node:2", node: detail },
    ]) {
      expect(() => universeDetailForSelection(body, selected)).toThrow();
    }
    expect(universeDetailForSelection(
      { version: "memory-universe-entity:1", entity: detail },
      { mode: "verified", id: detail.id },
    )).toBe(detail);
  });
});
