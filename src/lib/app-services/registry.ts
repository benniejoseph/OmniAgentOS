import type { AppServiceOperationContract } from "@/lib/app-services/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const APP_SERVICE_REGISTRY_VERSION =
  "p9.1-app-service-registry:1" as const;

const readOnlyEventContract = "read_only:no_domain_mutation";

export const APP_SERVICE_OPERATION_CONTRACTS = Object.freeze([
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
  return {
    version: APP_SERVICE_REGISTRY_VERSION,
    operationCount: operations.length,
    mutationCount: mutationContracts.length,
    duplicateOperations: [...new Set(duplicateOperations)],
    invalidMutationContracts,
    agentAccessPaths: ["governed_tool_executor", "application_service"] as const,
    forbiddenAgentAccessPaths: [] as readonly string[],
    registrySha256: canonicalJsonSha256(APP_SERVICE_OPERATION_CONTRACTS),
    passed:
      duplicateOperations.length === 0 &&
      invalidMutationContracts.length === 0,
  };
}

function read(
  operation: string,
  action: string,
  resourceType: string,
): AppServiceOperationContract {
  return Object.freeze({
    operation,
    action,
    resourceType,
    accessMode: "read",
    eventContract: readOnlyEventContract,
  });
}

function mutation(
  operation: string,
  action: string,
  resourceType: string,
  eventContract: string,
): AppServiceOperationContract {
  return Object.freeze({
    operation,
    action,
    resourceType,
    accessMode: "mutation",
    eventContract,
  });
}
