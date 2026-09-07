import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { publicAgentRun } from "@/lib/runs/public";
import { getRunStats, listAgentRuns } from "@/lib/runs/store";

export const runListServiceInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  includeStats: z.boolean().default(false),
}).strict();

export async function listRunsService(
  caller: AppServiceCaller,
  input: z.input<typeof runListServiceInputSchema>,
) {
  const value = runListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("runs.list"),
  );
  const owner = { tenantId: caller.context.tenantId };
  const [runs, stats] = await Promise.all([
    listAgentRuns(value.limit, owner),
    value.includeStats ? getRunStats(owner) : Promise.resolve(undefined),
  ]);
  const publicRuns = runs.map(publicAgentRun);
  return completeAppServiceCall(authorized, {
    runs: publicRuns,
    ...(stats
      ? {
          stats: {
            ...stats,
            latest: stats.latest.map(publicAgentRun),
          },
        }
      : {}),
  }, { resourceCount: publicRuns.length });
}
