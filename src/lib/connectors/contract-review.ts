import type {
  OpenApiConnectorRecord,
  OpenApiOperationRecord,
} from "@/lib/connectors/openapi-types";
import type {
  McpConnectorRecord,
  McpToolRecord,
} from "@/lib/connectors/types";
import { fingerprintApprovalContract } from "@/lib/tools/fingerprint";

const contractFingerprintVersion = 1;
const mcpContractFingerprintVersion = 2;

export class ConnectorContractReviewConflictError extends Error {
  constructor(message = "Connector contracts changed before review was applied.") {
    super(message);
    this.name = "ConnectorContractReviewConflictError";
  }
}

export type ConnectorContractReviewSummary = {
  pendingCount: number;
  fingerprint?: string;
  contracts: Array<{
    id: string;
    name: string;
    fingerprint: string;
  }>;
};

export function mcpToolContractFingerprint(
  tool: McpToolRecord,
  connector: McpConnectorRecord,
) {
  return fingerprintApprovalContract({
    version: mcpContractFingerprintVersion,
    connector: {
      id: connector.id,
      endpoint: connector.endpoint,
      transport: connector.transport,
      authType: connector.authType,
      authTokenEnv: connector.authTokenEnv,
      credentialVersion: connector.credentialVersion,
    },
    tool: {
      id: tool.id,
      name: tool.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
  });
}

export function openApiOperationContractFingerprint(
  operation: OpenApiOperationRecord,
  connector: OpenApiConnectorRecord,
) {
  return fingerprintApprovalContract({
    version: contractFingerprintVersion,
    connector: {
      id: connector.id,
      baseUrl: connector.baseUrl,
      authType: connector.authType,
      authTokenEnv: connector.authTokenEnv,
      authHeaderName: connector.authHeaderName,
    },
    operation: {
      id: operation.id,
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      inputSchema: operation.inputSchema,
      requestContentType: operation.requestContentType,
      responseContentTypes: [...operation.responseContentTypes].sort(),
    },
  });
}

export function mcpContractReviewSummary(
  tools: McpToolRecord[],
  connector: McpConnectorRecord,
): ConnectorContractReviewSummary {
  return contractReviewSummary(
    tools
      .filter((tool) => tool.status === "pending_review")
      .map((tool) => ({
        id: tool.id,
        name: tool.name,
        fingerprint: mcpToolContractFingerprint(tool, connector),
      })),
    connector.id,
    mcpContractFingerprintVersion,
  );
}

export function openApiContractReviewSummary(
  operations: OpenApiOperationRecord[],
  connector: OpenApiConnectorRecord,
): ConnectorContractReviewSummary {
  return contractReviewSummary(
    operations
      .filter((operation) => operation.status === "pending_review")
      .map((operation) => ({
        id: operation.id,
        name: operation.operationId,
        fingerprint: openApiOperationContractFingerprint(operation, connector),
      })),
    connector.id,
    contractFingerprintVersion,
  );
}

function contractReviewSummary(
  contracts: ConnectorContractReviewSummary["contracts"],
  connectorId: string,
  version: number,
): ConnectorContractReviewSummary {
  const sorted = [...contracts].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return {
    pendingCount: sorted.length,
    fingerprint: sorted.length
      ? fingerprintApprovalContract({
          version,
          connectorId,
          contracts: sorted.map(({ id, fingerprint }) => ({ id, fingerprint })),
        })
      : undefined,
    contracts: sorted,
  };
}
