import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { listCorrelatedEvents, listStreamEvents } from "@/lib/events/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { buildWorkflowTraceHierarchy } from "@/lib/trajectories/hierarchy";
import { getWorkflowRunDetail, getWorkflowRunExecutionAuthority } from "@/lib/workflows/store";

const inputSchema = z.object({ workflowId: z.string().trim().min(1).max(200) }).strict();

export async function showWorkflowTrajectoryService(caller: AppServiceCaller, input: z.input<typeof inputSchema>) {
  const value = inputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.workflows.trajectory"));
  const [detail, authority] = await Promise.all([
    getWorkflowRunDetail(value.workflowId, { tenantId: caller.context.tenantId }),
    getWorkflowRunExecutionAuthority(value.workflowId, { tenantId: caller.context.tenantId }),
  ]);
  if (!detail || !authority) return completeAppServiceCall(authorized, { traceHierarchy: null }, { resourceCount: 0 });
  const ownerActorId = authority.executionScope.initiatingActorId;
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (ownerActorId !== caller.context.actorId && ownerActorId !== binding?.canonicalActorId) {
    throw new Error("Workflow run not found.");
  }
  const correlationId = authority.executionScope.correlationId;
  const [rootEvents, correlatedEvents] = await Promise.all([
    listStreamEvents(`workflow:${value.workflowId}`, { tenantId: caller.context.tenantId, actorId: ownerActorId, limit: 2_000 }),
    listCorrelatedEvents(correlationId, { tenantId: caller.context.tenantId, actorId: ownerActorId, limit: 2_000 }),
  ]);
  const events = [...new Map([...rootEvents, ...correlatedEvents].map((event) => [event.id, event])).values()];
  const traceHierarchy = buildWorkflowTraceHierarchy(detail.run, ownerActorId, events, correlationId);
  return completeAppServiceCall(authorized, { traceHierarchy }, { resourceCount: 1 });
}
