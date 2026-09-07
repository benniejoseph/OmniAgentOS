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
import {
  deleteGovernedKnowledgeSourceService,
  ingestKnowledgeService,
  listKnowledgeService,
  previewGovernedKnowledgeSourceDeleteService,
  searchKnowledgeService,
} from "@/lib/app-services/knowledge";
import {
  correctMemoryService,
  forgetMemoryService,
  inspectMemoryService,
  listMemoryService,
  prepareMemoryExportService,
  previewMemoryForgetService,
  searchMemoryService,
  updateMemoryLifecycleService,
  writeMemoryService,
} from "@/lib/app-services/memory";
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
    "app.memory.list": () => listMemoryService(caller, input.toolInput as never),
    "app.memory.search": () => searchMemoryService(caller, input.toolInput as never),
    "app.memory.inspect": () => inspectMemoryService(caller, input.toolInput as never),
    "app.memory.write": () => writeMemoryService(caller, input.toolInput as never),
    "app.memory.correct": () => correctMemoryService(caller, memoryCorrectionInput(input.toolInput) as never),
    "app.memory.lifecycle": () => updateMemoryLifecycleService(caller, input.toolInput as never),
    "app.memory.forget.preview": () => previewMemoryForgetService(caller, input.toolInput as never),
    "app.memory.forget": () => forgetMemoryService(caller, input.toolInput as never),
    "app.memory.export": () => Promise.resolve(prepareMemoryExportService(caller)),
    "app.knowledge.list": () => listKnowledgeService(caller, input.toolInput as never),
    "app.knowledge.search": () => searchKnowledgeService(caller, input.toolInput as never),
    "app.knowledge.ingest": () => ingestKnowledgeService(caller, input.toolInput as never),
    "app.knowledge.delete.preview": () => previewGovernedKnowledgeSourceDeleteService(caller, input.toolInput as never),
    "app.knowledge.delete": () => deleteGovernedKnowledgeSourceService(caller, input.toolInput as never),
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

function memoryCorrectionInput(value: Record<string, unknown>) {
  const { id, ...correction } = value;
  return { id, correction };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
