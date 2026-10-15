import "server-only";
import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { listStreamEvents } from "@/lib/events/store";
import { getAgentRun, getAgentRunIdentityPin } from "@/lib/runs/store";
import { getGovernedTools } from "@/lib/tools/registry";

const inputSchema = z.object({
  query: z.string().trim().max(160).default(""),
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(40).default(20),
}).strict();

/** Product metadata plus the caller's own recorded admission, not new authority. */
export async function inspectCapabilitiesService(caller: AppServiceCaller, input: unknown) {
  const value = inputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.capabilities.inspect"));
  const scope = caller.executionScope;
  let admitted: Set<string> | undefined;
  if (scope?.purpose === "agent.tool.execute" && scope.executingPrincipalType === "agent" &&
    scope.tenantId === caller.context.tenantId && scope.initiatingActorId === caller.context.actorId) {
    const owner = { tenantId: caller.context.tenantId, actorId: caller.context.actorId };
    const run = await getAgentRun(scope.correlationId, owner);
    const identity = run?.ownerActorId === owner.actorId
      ? await getAgentRunIdentityPin(run.id, owner) : undefined;
    if (run?.ownerActorId === owner.actorId && identity?.principalId === scope.executingPrincipalId) {
      const harnesses = (await listStreamEvents(`run:${run.id}`, { ...owner, limit: 2_000 }))
        .filter(event => event.type === "run.harness");
      if (harnesses.length === 1 && Array.isArray(harnesses[0].payload.toolIds)) {
        admitted = new Set(harnesses[0].payload.toolIds.filter((id): id is string => typeof id === "string"));
      }
    }
  }
  // Only built-in product definitions: no connector records, secrets, paths,
  // private records, prompts or schemas enter this discoverable catalog.
  const terms = value.query.toLowerCase().split(/\s+/).filter(Boolean);
  const catalog = getGovernedTools().filter(tool => tool.status === "active" &&
    tool.category !== "mcp" && tool.category !== "openapi");
  const matches = catalog.filter(tool => !terms.length || terms.every(term =>
    `${tool.id} ${tool.name} ${tool.description}`.toLowerCase().includes(term)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const candidates = matches.slice(value.offset, value.offset + value.limit).map(tool => ({
    id: tool.id, name: tool.name, description: tool.description.slice(0, 400),
    category: tool.category, riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    admission: admitted?.has(tool.id) ? "admitted_for_this_run" as const : "catalog_only" as const,
  }));
  // The model tool-output budget is 8,000 characters. Reserve the receipt and
  // explanatory envelope so pagination remains parseable rather than cut off.
  const entries: typeof candidates = [];
  for (const candidate of candidates) {
    if (JSON.stringify([...entries, candidate]).length > 5_000) break;
    entries.push(candidate);
  }
  return completeAppServiceCall(authorized, {
    catalogScope: "built_in_product" as const,
    runAdmission: admitted ? "recorded" as const : "unavailable" as const,
    admissionMeaning: "Recorded admission is not a health check or execution grant. Current policy, device readiness and approvals are checked on every execution. Catalog-only entries cannot be called in this run.",
    catalogCount: catalog.length, matchedCount: matches.length, entries,
    nextOffset: value.offset + entries.length < matches.length ? value.offset + entries.length : null,
    connectionDiscovery: "Use the admitted app.integrations.overview.show and app.connectors.list operations for current connections; this product catalog does not inspect connected accounts.",
  });
}
