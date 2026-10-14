"use client";

import type { CSSProperties } from "react";
import { projectTaskDueDateSchema, projectTaskDueTimeZoneSchema, projectTaskHumanOwnerSchema, projectTaskDependenciesSchema } from "@/lib/projects/task-commitments";

export type TaskCommitment = {
  humanOwner?: string;
  dueDate?: string;
  dueTimeZone?: string;
  dueAt?: string;
  dependsOn?: string[];
};

export type TaskCommitmentDraft = {
  humanOwner: string;
  deadline: "none" | "date" | "existing";
  dueDate: string;
  dueTimeZone: string;
  dependsOn: string[];
};

export function validTaskCommitment(value: Record<string, unknown>) {
  return (value.humanOwner == null || projectTaskHumanOwnerSchema.safeParse(value.humanOwner).success) &&
    (value.dueDate == null || projectTaskDueDateSchema.safeParse(value.dueDate).success) &&
    (value.dueTimeZone == null || projectTaskDueTimeZoneSchema.safeParse(value.dueTimeZone).success) &&
    (value.dependsOn == null || projectTaskDependenciesSchema.safeParse(value.dependsOn).success) &&
    !(value.dueDate && value.dueAt) && !(value.dueTimeZone && !value.dueDate);
}

export function taskCommitmentDraft(task: TaskCommitment = {}): TaskCommitmentDraft {
  return {
    humanOwner: task.humanOwner || "",
    deadline: task.dueDate ? "date" : task.dueAt ? "existing" : "none",
    dueDate: task.dueDate || "",
    dueTimeZone: task.dueTimeZone || "",
    dependsOn: [...task.dependsOn || []],
  };
}

export function taskCommitmentChanges(draft: TaskCommitmentDraft) {
  return {
    humanOwner: draft.humanOwner.trim() || null,
    ...(draft.deadline === "existing" ? {} : { dueAt: null }),
    dueDate: draft.deadline === "date" ? draft.dueDate : null,
    dueTimeZone: draft.deadline === "date" ? draft.dueTimeZone.trim() || null : null,
    dependsOn: [...draft.dependsOn],
  };
}

export function savedTaskCommitmentMatches(
  saved: TaskCommitment & { id: string },
  original: TaskCommitment & { id: string },
  submitted: ReturnType<typeof taskCommitmentChanges>,
) {
  if (saved.id !== original.id) return false;
  for (const key of ["humanOwner", "dueDate", "dueTimeZone"] as const) {
    if ((saved[key] ?? null) !== submitted[key]) return false;
  }
  if (JSON.stringify(saved.dependsOn ?? []) !== JSON.stringify(submitted.dependsOn)) return false;
  if ("dueAt" in submitted) return saved.dueAt == null;
  // An omitted instant means preserve it, including across equivalent offsets.
  return original.dueAt == null ? saved.dueAt == null
    : saved.dueAt != null && Date.parse(saved.dueAt) === Date.parse(original.dueAt);
}

export function calendarDateLabel(value: string): string {
  // A calendar date is not an instant. UTC is only a formatting coordinate;
  // the supplied day is never interpreted in the viewer's time zone.
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return value;
  const date = new Date(0);
  date.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return date.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

export function taskDeadlineLabel(task: TaskCommitment): string {
  if (task.dueDate) return `${calendarDateLabel(task.dueDate)} · date only${task.dueTimeZone ? ` · ${task.dueTimeZone}` : " · time zone not specified"}`;
  if (task.dueAt) return new Date(task.dueAt).toLocaleString();
  return "No agreed deadline";
}

const fieldStyle: CSSProperties = { display: "grid", gap: "0.4rem", minWidth: 0 };

export function ProjectTaskCommitmentFields({ draft, onChange, tasks, taskId, disabled, existingDueAt }: {
  draft: TaskCommitmentDraft;
  onChange: (value: TaskCommitmentDraft) => void;
  tasks: readonly { id: string; title: string }[];
  taskId?: string;
  disabled?: boolean;
  existingDueAt?: string;
}) {
  const choices = tasks.filter((task) => task.id !== taskId);
  const unavailable = draft.dependsOn.filter((id) => !choices.some((task) => task.id === id));
  return <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "0.75rem", minWidth: 0 }}>
    <legend style={{ marginBottom: "0.5rem", fontWeight: 600 }}>Commitment</legend>
    <label style={fieldStyle}>Responsible person<input value={draft.humanOwner} maxLength={160} placeholder="Name, if agreed" onChange={(event) => onChange({ ...draft, humanOwner: event.currentTarget.value })} /></label>
    <label style={fieldStyle}>Deadline<select value={draft.deadline} onChange={(event) => onChange({ ...draft, deadline: event.currentTarget.value as TaskCommitmentDraft["deadline"] })}>
      <option value="none">No agreed deadline</option><option value="date">Calendar date — no time</option>{existingDueAt ? <option value="existing">Keep existing date and time</option> : null}
    </select></label>
    {draft.deadline === "existing" && existingDueAt ? <p>Saved deadline: {new Date(existingDueAt).toLocaleString()}</p> : null}
    {draft.deadline === "date" ? <>
      <label style={fieldStyle}>Agreed due date<input type="date" required value={draft.dueDate} onChange={(event) => onChange({ ...draft, dueDate: event.currentTarget.value })} /></label>
      <label style={fieldStyle}>Deadline time zone, if agreed<input value={draft.dueTimeZone} maxLength={80} placeholder="For example, Asia/Kolkata" onChange={(event) => onChange({ ...draft, dueTimeZone: event.currentTarget.value })} /></label>
      <small>A date-only commitment has no clock time. Leave the time zone blank if it has not been agreed.</small>
    </> : null}
    <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend>Depends on</legend>
      {choices.length ? <div style={{ display: "grid", gap: "0.4rem", maxHeight: "12rem", overflowY: "auto" }}>{choices.map((task) => <label key={task.id} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}><input type="checkbox" disabled={!draft.dependsOn.includes(task.id) && draft.dependsOn.length >= 20} checked={draft.dependsOn.includes(task.id)} onChange={(event) => onChange({ ...draft, dependsOn: event.currentTarget.checked ? [...draft.dependsOn, task.id] : draft.dependsOn.filter((id) => id !== task.id) })} />{task.title}</label>)}</div> : <small>No other tasks in this project.</small>}
      {unavailable.length ? <p>{unavailable.length} saved dependenc{unavailable.length === 1 ? "y is" : "ies are"} outside this loaded view and will be preserved.</p> : null}
    </fieldset>
  </fieldset>;
}
