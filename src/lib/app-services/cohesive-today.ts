import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { showCustomerSuccessPortfolioService } from "@/lib/app-services/customer-success-intelligence";
import { listMeetingsService } from "@/lib/app-services/meetings";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import {
  buildCohesiveTodayProjection,
  type CohesiveTodayProjection,
} from "@/lib/today/cohesive-projection";
import { normalizeTodaySections } from "@/lib/today/sections";
import { loadTodaySnapshot, type TodaySnapshot } from "@/lib/today/snapshot";
import { loadUsageSummary } from "@/lib/usage/summary";
import { loadWorkspaceSummary } from "@/lib/workspace/summary";

export const cohesiveTodayServiceInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(240).optional(),
  workLimit: z.number().int().min(1).max(50).default(16),
  approvalLimit: z.number().int().min(1).max(25).default(12),
  meetingLimit: z.number().int().min(1).max(200).default(50),
  accountLimit: z.number().int().min(1).max(200).default(50),
}).strict();

type CohesiveTodayDependencies = Readonly<{
  loadToday: typeof loadTodaySnapshot;
  loadWorkspace: typeof loadWorkspaceSummary;
  listMeetings: typeof listMeetingsService;
  loadCustomerPortfolio: typeof showCustomerSuccessPortfolioService;
  loadUsage: typeof loadUsageSummary;
}>;

const defaultDependencies: CohesiveTodayDependencies = Object.freeze({
  loadToday: loadTodaySnapshot,
  loadWorkspace: loadWorkspaceSummary,
  listMeetings: listMeetingsService,
  loadCustomerPortfolio: showCustomerSuccessPortfolioService,
  loadUsage: loadUsageSummary,
});

export async function showCohesiveTodayService(
  caller: AppServiceCaller,
  input: z.input<typeof cohesiveTodayServiceInputSchema>,
  dependencies: CohesiveTodayDependencies = defaultDependencies,
) {
  const value = cohesiveTodayServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.today.agenda.show"),
  );
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  return runWithDatabaseActorScope(
    caller.context.tenantId,
    actorBinding?.readableOwnerActorIds || [caller.context.actorId],
    async () => {
      const today = await dependencies.loadToday({
        tenantId: caller.context.tenantId,
        actorId: caller.context.actorId,
        requestActorBinding: actorBinding,
      });
      const visible = new Set(normalizeTodaySections(today.preferences.visibleSections));
      const [workspaceSummary, meetings, customerPortfolio, usage] = await Promise.all([
        visible.has("approvals") || visible.has("active_agents") || visible.has("work")
          ? optionalSource(
              "workspace",
              () => dependencies.loadWorkspace({
                tenantId: caller.context.tenantId,
                role: caller.context.role,
                limit: value.workLimit,
                approvalLimit: value.approvalLimit,
              }),
              "Work, agents, or approvals are temporarily unavailable.",
            )
          : hiddenSource("Work, agents, and approvals are hidden in Today preferences."),
        visible.has("agenda")
          ? optionalSource(
              "meetings",
              async () => (await dependencies.listMeetings(caller, {
                workspaceId: value.workspaceId,
                limit: value.meetingLimit,
              })).data.meetings,
              "Meetings and commitments are temporarily unavailable.",
            )
          : hiddenSource("Meetings and commitments are hidden in Today preferences."),
        visible.has("customers")
          ? optionalSource(
              "customer_risks",
              async () => (await dependencies.loadCustomerPortfolio(caller, {
                workspaceId: value.workspaceId,
                limit: value.accountLimit,
              })).data.portfolio,
              "Customer risks are temporarily unavailable.",
            )
          : hiddenSource("Customer risks are hidden in Today preferences."),
        visible.has("consumption")
          ? optionalSource(
              "consumption",
              () => dependencies.loadUsage({ tenantId: caller.context.tenantId }),
              "AI consumption is temporarily unavailable.",
            )
          : hiddenSource("AI consumption is hidden in Today preferences."),
      ]);
      const projection = buildCohesiveTodayProjection({
        today,
        workspaceSummary,
        meetings,
        customerPortfolio,
        usage,
      });
      return completeAppServiceCall(authorized, { projection }, {
        resourceCount: projection.agenda.length,
      });
    },
  );
}

type OptionalSourceName = "workspace" | "meetings" | "customer_risks" | "consumption";

async function optionalSource<T>(
  source: OptionalSourceName,
  read: () => Promise<T>,
  publicError: string,
): Promise<{ status: "ready"; value: T } | { status: "error"; detail: string }> {
  try {
    return { status: "ready", value: await read() };
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "today.projection_source_failed",
      source,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: safeErrorCode(error),
      timestamp: new Date().toISOString(),
    }));
    return { status: "error", detail: publicError };
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String(error.code);
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : undefined;
}

function hiddenSource(detail: string): { status: "hidden"; detail: string } {
  return { status: "hidden", detail };
}

export type { CohesiveTodayProjection, CohesiveTodayDependencies, TodaySnapshot };
