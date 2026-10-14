import { describe, expect, it } from "vitest";
import { calendarDateLabel, savedTaskCommitmentMatches, taskCommitmentChanges, taskCommitmentDraft, taskDeadlineLabel, validTaskCommitment } from "./project-task-commitment-fields";

describe("Project commitment forms", () => {
  it("confirms the exact task and saved fields before reporting a successful edit", () => {
    const original = { id: "mapping", dueAt: "2026-10-15T10:00:00+05:30" };
    const submitted = taskCommitmentChanges({ humanOwner: "Jonah Patel", deadline: "date", dueDate: "2026-10-17", dueTimeZone: "", dependsOn: ["sandbox"] });
    const saved = { id: "mapping", humanOwner: "Jonah Patel", dueDate: "2026-10-17", dependsOn: ["sandbox"] };
    expect(savedTaskCommitmentMatches(saved, original, submitted)).toBe(true);
    for (const mismatch of [{ id: "other-task" }, { humanOwner: "Someone else" }, { dueDate: "2026-10-18" }, { dueTimeZone: "Asia/Kolkata" }, { dependsOn: [] }, { dueAt: original.dueAt }]) {
      expect(savedTaskCommitmentMatches({ ...saved, ...mismatch }, original, submitted), JSON.stringify(mismatch)).toBe(false);
    }
    const keep = taskCommitmentChanges(taskCommitmentDraft(original));
    expect(savedTaskCommitmentMatches({ id: "mapping", dueAt: "2026-10-15T04:30:00Z", dependsOn: [] }, original, keep)).toBe(true);
    expect(savedTaskCommitmentMatches({ id: "mapping", dependsOn: [] }, original, keep)).toBe(false);
  });
  it("keeps date-only days and unknown zones without fabricating an instant", () => {
    const draft = taskCommitmentDraft({ humanOwner: "Elena Ruiz", dueDate: "2026-10-16", dependsOn: ["sandbox"] });
    expect(taskCommitmentChanges(draft)).toEqual({ humanOwner: "Elena Ruiz", dueAt: null, dueDate: "2026-10-16", dueTimeZone: null, dependsOn: ["sandbox"] });
    expect(calendarDateLabel("2026-10-16")).toContain("16");
    expect(taskDeadlineLabel({ dueDate: "2026-10-16" })).toContain("date only · time zone not specified");
  });
  it("shows the same calendar day for readers west and east of UTC", () => {
    const before = process.env.TZ;
    try {
      for (const zone of ["America/Los_Angeles", "Pacific/Honolulu", "Asia/Kolkata", "Pacific/Kiritimati"]) {
        process.env.TZ = zone;
        expect(calendarDateLabel("2026-10-16"), zone).toMatch(/16/);
        expect(calendarDateLabel("2026-10-16"), zone).not.toMatch(/15|17/);
      }
    } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  });
  it("preserves timed deadlines until an explicit date-only replacement or clear", () => {
    const draft = taskCommitmentDraft({ dueAt: "2026-10-16T10:00:00+05:30" });
    expect(taskCommitmentChanges(draft)).not.toHaveProperty("dueAt");
    expect(taskCommitmentChanges({ ...draft, deadline: "date", dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata" })).toMatchObject({ dueAt: null, dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata" });
    expect(taskCommitmentChanges({ ...draft, deadline: "none" })).toMatchObject({ dueAt: null, dueDate: null, dueTimeZone: null });
  });
  it("does not mutate saved dependency arrays or treat unknown ownership as the AI agent", () => {
    const dependsOn = ["sandbox"];
    const draft = taskCommitmentDraft({ dependsOn });
    draft.dependsOn.push("knowledge");
    expect(dependsOn).toEqual(["sandbox"]);
    expect(taskCommitmentChanges(draft).humanOwner).toBeNull();
    expect(taskDeadlineLabel({})).toBe("No agreed deadline");
  });
  it("rejects conflicting deadlines, impossible days and malformed structured fields", () => {
    for (const task of [{ dueDate: "2026-02-30" }, { dueDate: "2026-10-16", dueAt: "2026-10-16T00:00:00Z" }, { dueTimeZone: "Asia/Kolkata" }, { humanOwner: {} }, { dependsOn: ["a", "a"] }]) expect(validTaskCommitment(task)).toBe(false);
    expect(validTaskCommitment({ dueDate: "2028-02-29", humanOwner: "Elena Ruiz", dueTimeZone: "Pacific/Honolulu", dependsOn: ["sandbox"] })).toBe(true);
    expect(validTaskCommitment({})).toBe(true);
  });
});
