import type { ToolDefinition } from "@/lib/tools/types";

/** Derived from the final admitted toolbox, never from connection metadata. */
export function formatRuntimeCapabilityAwareness(input: {
  tools: readonly Pick<ToolDefinition, "id">[];
  hasWebEvidence: boolean;
  computerUseTarget?: string;
}) {
  const ids = new Set(input.tools.map(tool => tool.id));
  const state = (id: string) => ids.has(id) ? "admitted" : "not admitted";
  return [
    "Current request capability state (execution still follows the governed executor):",
    `- Direct public web search: ${state("web.search")}; URL reading: ${state("web.read")}; tracked research: ${state("app.research.start")}.`,
    `- Durable availability watches: ${state("app.watches.create")}; watch evidence: ${state("app.watches.show")}. Supported source: public District cinema listings, exact cinema/date/film/language/seat class/time. A saved watch checks on its stated interval without a continuously running model. Never claim arbitrary-site monitoring or instant/closed-app Mac notifications; read the saved watch and actual delivery state.`,
    `- Public source material supplied for this request: ${input.hasWebEvidence ? "yes" : "no"}. Retrieval is not verification of a claim; missing evidence is not proof that a search tool is unavailable.`,
    `- Selected computer target: ${input.computerUseTarget || "none"}. Mac observation: ${state("local.macos.observe")}; Mac URL navigation: ${state("local.macos.open_url")}; approved-workspace commands: ${state("local.macos.command.run")}. Never switch devices as a recovery shortcut.`,
    `- Product capability inspection: ${state("app.capabilities.inspect")}. Catalog entries describe implemented product functions; only tools provided in this request can execute. A catalog entry does not enable itself.`,
    `- Existing work diagnosis: run history ${state("app.runs.list")}; run detail ${state("app.runs.show")}; workflow detail ${state("app.workflows.show")}; governed workflow controls ${state("app.workflows.signal")}. Follow the run's delegatedWork.workflowId or mission task's execution.workflowRunId to the executor. Read its recorded error and current step before explaining a stall. A root task without a direct executor does not prove its child work never started. Paused is not awaiting clarification; research questions are the agent's agenda, not questions for the user.`,
    "- When the user asks to resume or nudge paused work, submit one app.workflows.signal resume through normal approval; retry is for failed work. Preserve saved research and the original limits. An interrupted model call may require a new paid attempt with unknown prior usage. Read back the same workflow; queued is not running or complete. Do not create duplicate research, approve on the user's behalf, repeatedly resume after another failure, or claim success without a saved result.",
    `- Project source reading: ${state("app.projects.builder.file.read")}; source editing: ${state("app.projects.builder.file.update")}; project verification: ${state("app.projects.builder.verification.run")}. Repository access and release readiness must be inspected, never assumed.`,
    `- Asael improvement cycles: ${state("app.self_improvement.show")}; start an enrolled cycle: ${state("app.self_improvement.run")}; pause/resume: ${state("app.self_improvement.pause")}; exact candidate review: ${state("app.self_improvement.review")}. Read the saved owner policy, current cycle and release controller status first. A queued cycle or open PR is not a deployed change. Publishing currently requires the owner's trusted Mac controller to be online.`,
    "- When a route fails, use its specific error and another already-admitted route where the user's scope permits. Do not claim all web access is off or invent an enable-web switch. Preserve the original objective and outstanding questions across recovery.",
  ].join("\n");
}
