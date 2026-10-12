import "server-only";
import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { loadUsageSummary } from "@/lib/usage/summary";

const usageSummaryInputSchema = z.object({
  period: z.enum(["day", "week", "month"]).default("week"),
  breakdownLimit: z.number().int().min(1).max(20).default(10),
}).strict();

export async function showUsageSummaryService(caller: AppServiceCaller, input: unknown) {
  const value = usageSummaryInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.usage.summary.show"));
  const summary = await loadUsageSummary({ tenantId: caller.context.tenantId });
  const selected = summary.periods[value.period];
  return completeAppServiceCall(authorized, {
    generatedAt: summary.generatedAt,
    scope: "workspace",
    scopeLabel: summary.scopeLabel,
    disclosure: summary.disclosure,
    sourceEventLimitReached: summary.sourceEventLimitReached,
    period: {
      key: selected.key, label: selected.label,
      currentLabel: selected.currentLabel, previousLabel: selected.previousLabel,
      currentStartAt: selected.currentStartAt, currentEndAt: selected.currentEndAt,
      previousStartAt: selected.previousStartAt, previousEndAt: selected.previousEndAt,
      current: selected.current, previous: selected.previous,
      providers: selected.providers.slice(0, value.breakdownLimit),
      models: selected.models.slice(0, value.breakdownLimit),
      providersTruncated: selected.providers.length > value.breakdownLimit,
      modelsTruncated: selected.models.length > value.breakdownLimit,
    },
  });
}
