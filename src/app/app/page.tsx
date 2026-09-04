import type { Metadata } from "next";
import { TodayWorkspace } from "@/components/today-workspace";
import { getServerWorkspaceSession } from "@/lib/auth/server-workspace-session";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import type { SecurityRole } from "@/lib/security/types";
import { loadTodaySnapshot } from "@/lib/today/snapshot";
import { loadWorkspaceSummary } from "@/lib/workspace/summary";

export const metadata: Metadata = {
  title: "Today",
};

export default async function AppDashboardPage() {
  const session = await getServerWorkspaceSession();
  const tenantId = session.context?.tenantId;
  const actorId = session.context?.actorId;
  const role = session.membership?.role || session.context?.role;
  const requestActorBinding = session.context
    ? canonicalRequestActorBindingFromSecurityContext(session.context)
    : undefined;
  if (!tenantId || !actorId || !role) {
    return <TodayWorkspace />;
  }

  const initial = await runWithDatabaseTenantScope(tenantId, async () => {
    const [today, summary] = await Promise.all([
      loadTodaySnapshot({ tenantId, actorId, requestActorBinding }),
      loadWorkspaceSummary({
        tenantId,
        role: role as SecurityRole,
        limit: 16,
        approvalLimit: 12,
      }),
    ]);
    return { today, summary };
  });

  return (
    <TodayWorkspace
      initialToday={initial.today}
      initialSummary={initial.summary}
    />
  );
}
