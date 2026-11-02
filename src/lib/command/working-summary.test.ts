import { describe, expect, it } from "vitest";
import { workingNotes } from "./working-summary";

describe("public working notes", () => {
  it("shows recorded statuses and tools while excluding model reasoning and payloads", () => {
    expect(workingNotes([
      { type: "model", reasoning: "private", output: "secret" },
      { type: "reasoning", text: "private" },
      { type: "status", label: "Reading the project", detail: "Checking the adjacent tests." },
      { type: "tool", toolId: "local.macos.command.run", status: "executed", input: { secret: "hidden" }, output: "raw output" },
    ])).toEqual([
      { title: "Reading the project", detail: "Checking the adjacent tests.", state: "working" },
      { title: "Working in your Mac folder", detail: "Step completed", state: "done" },
    ]);
  });
  it("does not report approval, failure or dry run as a completed action", () => {
    const notes = workingNotes(["approval_required", "failed", "dry_run"].map(status => ({ type: "tool", toolId: "test", status })));
    expect(notes.map(note => note.state)).toEqual(["waiting", "failed", "preview"]);
    expect(notes[2].detail).toBe("Preview only; no action ran");
  });
  it("deduplicates consecutive notes and bounds the public projection", () => {
    const event = { type: "status", label: "Reading", detail: "One source" };
    expect(workingNotes([event, event])).toHaveLength(1);
    const notes = workingNotes(Array.from({ length: 100 }, (_, index) => ({ type: "status", label: String(index), detail: "x".repeat(4_000) })));
    expect(notes).toHaveLength(8);
    expect(notes[0].title).toBe("92");
    expect(notes.every(note => note.detail.length <= 2_000)).toBe(true);
  });
});
