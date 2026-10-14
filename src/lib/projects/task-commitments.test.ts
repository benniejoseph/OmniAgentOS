import { describe, expect, it } from "vitest";
import { applyProjectTaskDeadlinePatch, assertProjectTaskDependencyGraph, projectTaskDueDateSchema, projectTaskDueTimeZoneSchema } from "./task-commitments";

describe("structured task commitments", () => {
  it("preserves a calendar date without inventing a clock time or time zone", () => {
    expect(applyProjectTaskDeadlinePatch({}, { dueDate: "2026-10-17" })).toEqual({ dueDate: "2026-10-17", dueAt: undefined, dueTimeZone: undefined });
    expect(projectTaskDueDateSchema.safeParse("2026-02-29").success).toBe(false);
    expect(projectTaskDueDateSchema.safeParse("2028-02-29").success).toBe(true);
    for (const date of ["2026-13-01", "2026-04-31", "2026-1-01", "0000-01-01", "2026-10-17T00:00:00Z"]) expect(projectTaskDueDateSchema.safeParse(date).success).toBe(false);
    expect(projectTaskDueTimeZoneSchema.safeParse("Asia/Kolkata").success).toBe(true);
    for (const zone of ["Mars/Base", "+05:30"]) expect(projectTaskDueTimeZoneSchema.safeParse(zone).success).toBe(false);
  });
  it("switches deadline precision explicitly and preserves untouched deadlines", () => {
    const date = { dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata" };
    expect(applyProjectTaskDeadlinePatch(date, {})).toEqual({ ...date, dueAt: undefined });
    expect(applyProjectTaskDeadlinePatch(date, { dueDate: null })).toEqual({ dueAt: undefined, dueDate: undefined, dueTimeZone: undefined });
    expect(applyProjectTaskDeadlinePatch(date, { dueAt: "2026-10-17T10:00:00+05:30" })).toEqual({ dueAt: "2026-10-17T04:30:00.000Z", dueDate: undefined, dueTimeZone: undefined });
    expect(applyProjectTaskDeadlinePatch({ dueAt: "2026-10-17T04:30:00.000Z" }, { dueDate: "2026-10-18" })).toEqual({ dueAt: undefined, dueDate: "2026-10-18", dueTimeZone: undefined });
    expect(() => applyProjectTaskDeadlinePatch({}, { dueAt: "2026-10-17T10:00:00.000Z", dueDate: "2026-10-17" })).toThrow();
    expect(() => applyProjectTaskDeadlinePatch({}, { dueTimeZone: "Asia/Kolkata" })).toThrow("requires a calendar-date");
  });
  it("refuses missing, self, cyclic and duplicate identities without dropping edges", () => {
    expect(() => assertProjectTaskDependencyGraph([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: [] }])).not.toThrow();
    expect(() => assertProjectTaskDependencyGraph([{ id: "a", dependsOn: ["foreign"] }])).toThrow("existing task");
    expect(() => assertProjectTaskDependencyGraph([{ id: "a", dependsOn: ["a"] }])).toThrow("itself");
    expect(() => assertProjectTaskDependencyGraph([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }])).toThrow("cycle");
    expect(() => assertProjectTaskDependencyGraph([{ id: "a", dependsOn: [] }, { id: "a", dependsOn: [] }])).toThrow("unique");
  });
  it("handles a long chain without recursive stack use", () => {
    const chain = Array.from({ length: 10_000 }, (_, index) => ({ id: `task-${index}`, dependsOn: index ? [`task-${index - 1}`] : [] }));
    expect(() => assertProjectTaskDependencyGraph(chain)).not.toThrow();
    chain[0].dependsOn = [chain.at(-1)!.id];
    expect(() => assertProjectTaskDependencyGraph(chain)).toThrow("cycle");
  });
});
