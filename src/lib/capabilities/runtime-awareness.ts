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
    `- Public source material supplied for this request: ${input.hasWebEvidence ? "yes" : "no"}. Retrieval is not verification of a claim; missing evidence is not proof that a search tool is unavailable.`,
    `- Selected computer target: ${input.computerUseTarget || "none"}. Mac observation: ${state("local.macos.observe")}; Mac URL navigation: ${state("local.macos.open_url")}; approved-workspace commands: ${state("local.macos.command.run")}. Never switch devices as a recovery shortcut.`,
    `- Product capability inspection: ${state("app.capabilities.inspect")}. Catalog entries describe implemented product functions; only tools provided in this request can execute. A catalog entry does not enable itself.`,
    `- Project source reading: ${state("app.projects.builder.file.read")}; source editing: ${state("app.projects.builder.file.update")}; project verification: ${state("app.projects.builder.verification.run")}. Repository access and release readiness must be inspected, never assumed.`,
    "- When a route fails, use its specific error and another already-admitted route where the user's scope permits. Do not claim all web access is off or invent an enable-web switch. Preserve the original objective and outstanding questions across recovery.",
  ].join("\n");
}
