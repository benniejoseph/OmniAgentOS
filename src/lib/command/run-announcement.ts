/**
 * What a run's stream announces to assistive technology: each change of
 * phase, and nothing for the steps between them, which the activity list
 * shows. Announcing every step buried the phases under them.
 */
export function runStreamAnnouncement(event: { type: string; message?: string }) {
  switch (event.type) {
    case "delegated":
      return "Task moved to a durable background workflow.";
    case "clarification":
      return "The agent needs an exact target before it can continue.";
    case "waiting_approval":
      return "Agent run paused for approval.";
    case "done":
      return "Agent run completed. Review the result and evidence.";
    case "error":
      return "Agent run failed.";
    case "canceled":
      return event.message || "Agent run stopped.";
    default:
      return undefined;
  }
}
