export type WorkingNote = { title: string; detail: string; state: "working" | "done" | "waiting" | "failed" | "preview" };

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
      if (title) note = { title, detail: text(event.detail, 2_000), state: "working" };
    } else if (event.type === "tool") {
      const tool = text(event.toolId, 160);
      const title = ({ "local.macos.command.run": "Working in your Mac folder", "web.search": "Searching the web",
        "web.read": "Reading a source" } as Record<string, string>)[tool] || tool.replace(/[._]/g, " ") || "Using a tool";
      const state = event.status === "executed" ? "done" : event.status === "approval_required" ? "waiting"
        : event.status === "failed" || event.status === "blocked" ? "failed" : event.status === "dry_run" ? "preview" : "working";
      note = { title, detail: state === "done" ? "Step completed" : state === "waiting" ? "Waiting for your review"
        : state === "failed" ? "This step needs attention. Open activity for details."
        : state === "preview" ? "Preview only; no action ran" : "In progress", state };
    }
    if (note && (notes.at(-1)?.title !== note.title || notes.at(-1)?.detail !== note.detail)) notes.push(note);
  }
  return notes.slice(-8);
}
