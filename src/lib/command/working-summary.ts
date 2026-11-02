export type WorkingNote = { title: string; detail: string; state: "working" | "done" | "waiting" | "failed" | "preview" };

/** Translate known machine-facing progress labels, without inventing a model rationale. */
export function publicWorkStatus(label: string, detail: string): Pick<WorkingNote, "title" | "detail"> {
  const key = label.trim().toLowerCase();
  if (key === "retrieving memory" || key === "retrieving personal context") {
    return { title: "Finding relevant context", detail: "Looking for information that can help with your request." };
  }
  if (key === "workspace capabilities ready") {
    return { title: "Workspace ready", detail: "Checked the tools available for this task." };
  }
  if (key === "project memory isolated") {
    return { title: "Using this project's context", detail: "Keeping the request scoped to the selected project." };
  }
  if (/^thinking(?:\b|…)/.test(key)) {
    return { title: "Considering the next step", detail: "Working with the information collected so far." };
  }
  if (/routing selected|model route selected/i.test(detail)) {
    return { title: "Preparing the assistant", detail: "Selected a model for this task." };
  }
  return { title: label, detail };
}

/** Public execution metadata only. Never project model reasoning, inputs or outputs. */
export function workingNotes(events: readonly unknown[]): WorkingNote[] {
  const notes: WorkingNote[] = [];
  for (const value of events) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    const text = (field: unknown, limit: number) => typeof field === "string"
      ? field.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
    let note: WorkingNote | undefined;
    if (event.type === "status") {
      const title = text(event.label, 160);
      if (title) note = { ...publicWorkStatus(title, text(event.detail, 2_000)), state: "working" };
    } else if (event.type === "memory" && /^context pack ready\b/i.test(text(event.title, 160))) {
      const count = typeof event.count === "number" && Number.isSafeInteger(event.count) && event.count >= 0 ? event.count : undefined;
      note = { title: "Context reviewed", detail: count === undefined ? "Relevant context is ready."
        : `${count} relevant context item${count === 1 ? "" : "s"} found.`, state: "done" };
    } else if (event.type === "council_member") {
      const title = text(event.agentName, 160) || "Specialist";
      const status = text(event.lifecycleState || event.status, 100);
      note = { title, detail: text(event.summary || event.role, 2_000) || "Working on an assigned part of your request.",
        state: ["failed", "rejected", "canceled", "expired"].includes(status) ? "failed"
          : ["completed", "result_accepted"].includes(status) ? "done"
          : ["waiting", "challenged", "completed_proposed", "waiting_approval", "waiting_clarification", "blocked"].includes(status) ? "waiting" : "working" };
    } else if (event.type === "tool") {
      const tool = text(event.toolId, 160);
      const title = ({ "local.macos.command.run": "Working in your Mac folder", "web.search": "Searching the web",
        "web.read": "Reading a source", "knowledge.search": "Searching your library", "memory.search": "Checking saved context" } as Record<string, string>)[tool] || "Using a connected tool";
      const state = event.status === "executed" ? "done" : event.status === "approval_required" ? "waiting"
        : event.status === "failed" || event.status === "blocked" ? "failed" : event.status === "dry_run" ? "preview" : "working";
      note = { title, detail: state === "done" ? "Step completed" : state === "waiting" ? "Waiting for your review"
        : state === "failed" ? "This step needs attention. Open activity for details."
        : state === "preview" ? "Preview only; no action ran" : "In progress", state };
    }
    if (note && (notes.at(-1)?.title !== note.title || notes.at(-1)?.detail !== note.detail || notes.at(-1)?.state !== note.state)) notes.push(note);
  }
  return notes.slice(-8);
}
