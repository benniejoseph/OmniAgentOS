import type { AppServiceOperationContract } from "@/lib/app-services/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const APP_SERVICE_REGISTRY_VERSION =
  "p9.1-app-service-registry:1" as const;

const readOnlyEventContract = "read_only:no_domain_mutation";

export const APP_SERVICE_OPERATION_CONTRACTS = Object.freeze([
  read("app.workspaces.summary", "read", "workspace"),
  read("app.workspaces.readiness", "read", "workspace"),
  read("app.projects.list", "read", "projects"),
  read("app.projects.show", "read", "project"),
  mutation("app.projects.create", "run.agent", "project", "projects.atomic-events.v1"),
  mutation("app.projects.update", "run.agent", "project", "projects.atomic-events.v1"),
  mutation("app.work_items.create", "run.agent", "project_task", "projects.atomic-events.v1"),
  mutation("app.work_items.update", "run.agent", "project_task", "projects.atomic-events.v1"),
  read("app.knowledge.delete.preview", "write.memory", "knowledge"),
  mutation("app.knowledge.delete", "write.memory", "knowledge", "memory.atomic-events.v1"),
  read("app.today.show", "read", "today"),
  mutation("app.today.item.create", "run.agent", "today_item", "tool-execution-events.v1"),
  mutation("app.today.item.update", "run.agent", "today_item", "tool-execution-events.v1"),
  read("app.today.brief.show", "read", "daily_brief"),
  mutation("app.today.brief.generate", "run.agent", "daily_brief", "tool-execution-events.v1"),
  mutation("app.today.preferences.update", "run.agent", "daily_brief_preferences", "tool-execution-events.v1"),
  read("app.notifications.list", "read", "personal_notifications"),
  mutation("app.notifications.update", "run.agent", "personal_notification", "notifications.atomic-events.v1"),
  mutation("app.notifications.read_all", "run.agent", "personal_notifications", "notifications.atomic-events.v1"),
  read("app.runs.show", "read", "agent_run"),
  read("app.agents.list", "read", "custom_agent"),
  read("app.agents.show", "read", "custom_agent"),
  mutation("app.agents.create", "manage.workflow", "custom_agent", "agent-identity-events.v1"),
  mutation("app.agents.update", "manage.workflow", "custom_agent", "agent-identity-events.v1"),
  read("app.agents.delete.preview", "manage.workflow", "custom_agent"),
  mutation("app.agents.delete", "manage.workflow", "custom_agent", "agent-identity-events.v1"),
  read("app.skills.list", "read", "agent_skill"),
  read("app.skills.show", "read", "agent_skill"),
  mutation("app.skills.create", "manage.workflow", "agent_skill", "tool-execution-events.v1"),
  mutation("app.skills.update", "manage.workflow", "agent_skill", "tool-execution-events.v1"),
  read("app.skills.delete.preview", "manage.workflow", "agent_skill"),
  mutation("app.skills.delete", "manage.workflow", "agent_skill", "tool-execution-events.v1"),
  read("missions.list", "read", "missions"),
  read("missions.show", "read", "mission"),
  mutation("missions.create", "run.agent", "mission", "missions.atomic-events.v1"),
  mutation("missions.transition", "run.agent", "mission", "missions.atomic-events.v1"),
  mutation("mission.task.create", "manage.workflow", "mission_task", "missions.atomic-events.v1"),
  mutation("mission.task.comment", "manage.workflow", "mission_task_comment", "missions.atomic-events.v1"),
  read("runs.list", "read", "agent_run"),
  read("memory.list", "read", "memory"),
  read("memory.search", "read", "memory"),
  read("memory.inspect", "read", "memory"),
  read("memory.forget.preview", "write.memory", "memory"),
  read("memory.export", "read", "memory"),
  mutation("memory.write", "write.memory", "memory", "memory.atomic-events.v1"),
  mutation("memory.correct", "write.memory", "memory", "memory.atomic-events.v1"),
  mutation("memory.lifecycle", "write.memory", "memory", "memory.atomic-events.v1"),
  mutation("memory.forget", "write.memory", "memory", "memory.atomic-events.v1"),
  read("knowledge.list", "read", "knowledge"),
  read("knowledge.search", "read", "knowledge"),
  mutation("knowledge.ingest", "write.memory", "knowledge", "memory.atomic-events.v1"),
  mutation("knowledge.delete_source", "write.memory", "knowledge", "memory.atomic-events.v1"),
] satisfies readonly AppServiceOperationContract[]);

export type AppServiceOperation =
  (typeof APP_SERVICE_OPERATION_CONTRACTS)[number]["operation"];

export const MAIN_AGENT_APP_SERVICE_BINDINGS = Object.freeze([
  { toolId: "app.workspaces.summary", operation: "app.workspaces.summary" },
  { toolId: "app.workspaces.readiness", operation: "app.workspaces.readiness" },
  { toolId: "app.projects.list", operation: "app.projects.list" },
  { toolId: "app.projects.show", operation: "app.projects.show" },
  { toolId: "app.projects.create", operation: "app.projects.create" },
  { toolId: "app.projects.update", operation: "app.projects.update" },
  { toolId: "app.work_items.create", operation: "app.work_items.create" },
  { toolId: "app.work_items.update", operation: "app.work_items.update" },
  { toolId: "app.memory.list", operation: "memory.list" },
  { toolId: "app.memory.search", operation: "memory.search" },
  { toolId: "app.memory.inspect", operation: "memory.inspect" },
  { toolId: "app.memory.write", operation: "memory.write" },
  { toolId: "app.memory.correct", operation: "memory.correct" },
  { toolId: "app.memory.lifecycle", operation: "memory.lifecycle" },
  { toolId: "app.memory.forget.preview", operation: "memory.forget.preview" },
  { toolId: "app.memory.forget", operation: "memory.forget" },
  { toolId: "app.memory.export", operation: "memory.export" },
  { toolId: "app.knowledge.list", operation: "knowledge.list" },
  { toolId: "app.knowledge.search", operation: "knowledge.search" },
  { toolId: "app.knowledge.ingest", operation: "knowledge.ingest" },
  { toolId: "app.knowledge.delete.preview", operation: "app.knowledge.delete.preview" },
  { toolId: "app.knowledge.delete", operation: "app.knowledge.delete" },
  { toolId: "app.today.show", operation: "app.today.show" },
  { toolId: "app.today.item.create", operation: "app.today.item.create" },
  { toolId: "app.today.item.update", operation: "app.today.item.update" },
  { toolId: "app.today.brief.show", operation: "app.today.brief.show" },
  { toolId: "app.today.brief.generate", operation: "app.today.brief.generate" },
  { toolId: "app.today.preferences.update", operation: "app.today.preferences.update" },
  { toolId: "app.notifications.list", operation: "app.notifications.list" },
  { toolId: "app.notifications.update", operation: "app.notifications.update" },
  { toolId: "app.notifications.read_all", operation: "app.notifications.read_all" },
  { toolId: "app.runs.list", operation: "runs.list" },
  { toolId: "app.runs.show", operation: "app.runs.show" },
  { toolId: "app.agents.list", operation: "app.agents.list" },
  { toolId: "app.agents.show", operation: "app.agents.show" },
  { toolId: "app.agents.create", operation: "app.agents.create" },
  { toolId: "app.agents.update", operation: "app.agents.update" },
  { toolId: "app.agents.delete.preview", operation: "app.agents.delete.preview" },
  { toolId: "app.agents.delete", operation: "app.agents.delete" },
  { toolId: "app.skills.list", operation: "app.skills.list" },
  { toolId: "app.skills.show", operation: "app.skills.show" },
  { toolId: "app.skills.create", operation: "app.skills.create" },
  { toolId: "app.skills.update", operation: "app.skills.update" },
  { toolId: "app.skills.delete.preview", operation: "app.skills.delete.preview" },
  { toolId: "app.skills.delete", operation: "app.skills.delete" },
  { toolId: "memory.search", operation: "memory.search" },
  { toolId: "memory.inspect", operation: "memory.inspect" },
  { toolId: "memory.forget.preview", operation: "memory.forget.preview" },
  { toolId: "memory.write", operation: "memory.write" },
  { toolId: "memory.correct", operation: "memory.correct" },
  { toolId: "memory.lifecycle", operation: "memory.lifecycle" },
  { toolId: "memory.forget", operation: "memory.forget" },
  { toolId: "memory.export", operation: "memory.export" },
  { toolId: "knowledge.search", operation: "knowledge.search" },
  { toolId: "knowledge.ingest", operation: "knowledge.ingest" },
  { toolId: "missions.list", operation: "missions.list" },
  { toolId: "mission.show", operation: "missions.show" },
  { toolId: "mission.task.create", operation: "mission.task.create" },
  { toolId: "mission.task.comment", operation: "mission.task.comment" },
  { toolId: "runs.list", operation: "runs.list" },
] satisfies ReadonlyArray<{
  toolId: string;
  operation: AppServiceOperation;
}>);

const byOperation = new Map(
  APP_SERVICE_OPERATION_CONTRACTS.map((contract) => [contract.operation, contract]),
);

export function getAppServiceOperationContract(
  operation: AppServiceOperation,
): AppServiceOperationContract {
  const contract = byOperation.get(operation);
  if (!contract) {
    throw new Error(`Application service operation ${operation} is not registered.`);
  }
  return contract;
}

export function validateAppServiceRegistry() {
  const operations = APP_SERVICE_OPERATION_CONTRACTS.map((entry) => entry.operation);
  const duplicateOperations = operations.filter(
    (operation, index) => operations.indexOf(operation) !== index,
  );
  const mutationContracts = APP_SERVICE_OPERATION_CONTRACTS.filter(
    (entry) => entry.accessMode === "mutation",
  );
  const invalidMutationContracts = mutationContracts
    .filter((entry) => entry.eventContract === readOnlyEventContract)
    .map((entry) => entry.operation);
  const missingAgentOperations = MAIN_AGENT_APP_SERVICE_BINDINGS
    .filter((binding) => !byOperation.has(binding.operation))
    .map((binding) => binding.toolId);
  return {
    version: APP_SERVICE_REGISTRY_VERSION,
    operationCount: operations.length,
    mutationCount: mutationContracts.length,
    duplicateOperations: [...new Set(duplicateOperations)],
    invalidMutationContracts,
    mainAgentOperationCount: MAIN_AGENT_APP_SERVICE_BINDINGS.length,
    missingAgentOperations,
    agentAccessPaths: ["governed_tool_executor", "application_service"] as const,
    forbiddenAgentAccessPaths: [] as readonly string[],
    registrySha256: canonicalJsonSha256(APP_SERVICE_OPERATION_CONTRACTS),
    passed:
      duplicateOperations.length === 0 &&
      invalidMutationContracts.length === 0 &&
      missingAgentOperations.length === 0,
  };
}

function read<const TOperation extends string>(
  operation: TOperation,
  action: string,
  resourceType: string,
): AppServiceOperationContract & { operation: TOperation } {
  return Object.freeze({
    operation,
    action,
    resourceType,
    accessMode: "read",
    eventContract: readOnlyEventContract,
  });
}

function mutation<const TOperation extends string>(
  operation: TOperation,
  action: string,
  resourceType: string,
  eventContract: string,
): AppServiceOperationContract & { operation: TOperation } {
  return Object.freeze({
    operation,
    action,
    resourceType,
    accessMode: "mutation",
    eventContract,
  });
}
