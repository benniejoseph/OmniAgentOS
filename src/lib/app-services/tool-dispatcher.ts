import {
  createProjectService,
  createWorkItemService,
  listProjectsService,
  showProjectService,
  updateProjectService,
  updateWorkItemService,
} from "@/lib/app-services/projects";
import {
  getWorkspaceReadinessService,
  getWorkspaceSummaryService,
} from "@/lib/app-services/workspaces";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

export type FirstPartyAppToolDispatch =
  | { handled: false }
  | { handled: true; result: unknown };

export async function executeFirstPartyAppTool(input: {
  toolId: string;
  toolInput: Record<string, unknown>;
  context?: SecurityContext;
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
}): Promise<FirstPartyAppToolDispatch> {
  if (!input.toolId.startsWith("app.")) return { handled: false };
  if (!input.context) {
    throw new Error("First-party application tools require an authenticated tenant and actor context.");
  }
  const caller = createAppServiceCaller({
    context: input.context,
    executionScope: input.executionScope,
    idempotencyKey: input.idempotencyKey,
  });
  const handlers: Record<string, () => Promise<unknown>> = {
    "app.workspaces.summary": () => getWorkspaceSummaryService(caller, input.toolInput as never),
    "app.workspaces.readiness": () => getWorkspaceReadinessService(caller, input.toolInput as never),
    "app.projects.list": () => listProjectsService(caller, input.toolInput as never),
    "app.projects.show": () => showProjectService(caller, input.toolInput as never),
    "app.projects.create": () => createProjectService(caller, input.toolInput as never),
    "app.projects.update": () => updateProjectService(caller, input.toolInput as never),
    "app.work_items.create": () => createWorkItemService(caller, input.toolInput as never),
    "app.work_items.update": () => updateWorkItemService(caller, input.toolInput as never),
  };
  const handler = handlers[input.toolId];
  if (!handler) throw new Error(`No first-party application handler is registered for ${input.toolId}.`);
  const service = await handler() as { data?: unknown; receipt?: unknown };
  return {
    handled: true,
    result: service && typeof service === "object" && "data" in service
      ? { ...asRecord(service.data), serviceReceipt: service.receipt }
      : service,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
