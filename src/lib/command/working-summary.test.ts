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
  it("translates public setup labels without exposing model details", () => {
    expect(workingNotes([
      { type: "status", label: "Retrieving memory", detail: "internal setup" },
      { type: "status", label: "Thinking…", detail: "private model field is not the user update" },
      { type: "memory", title: "Context pack ready", count: 2, items: ["hidden"] },
    ])).toEqual([
      { title: "Finding relevant context", detail: "Looking for information that can help with your request.", state: "working" },
      { title: "Considering the next step", detail: "Working with the information collected so far.", state: "working" },
      { title: "Context reviewed", detail: "2 relevant context items found.", state: "done" },
    ]);
  });
  it("distinguishes accepting an assignment, submitting a result, and accepting that result", () => {
    const events = ["accepted", "working", "completed_proposed", "result_accepted", "expired"].map(lifecycleState => ({
      type: "council_member", agentName: "Scout", role: "Research", summary: "Read the project sources.",
      status: "completed", lifecycleState, reasoning: "private", input: "hidden",
    }));
    expect(workingNotes(events).map(note => note.state)).toEqual(["working", "waiting", "done", "failed"]);
    expect(JSON.stringify(workingNotes(events))).not.toMatch(/private|hidden/);
  });
  it("does not manufacture a count from malformed context metadata", () => {
    for (const count of [-1, 2.5, "3", Number.NaN]) {
      expect(workingNotes([{ type: "memory", title: "Context pack ready", count }])[0].detail).toBe("Relevant context is ready.");
    }
  });
});
