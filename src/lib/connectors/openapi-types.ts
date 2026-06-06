import type { ToolRiskLevel } from "@/lib/tools/types";

export type OpenApiConnectorAuthType = "none" | "bearer_env" | "api_key_header_env";
export type OpenApiConnectorStatus = "active" | "error" | "disabled";
export type OpenApiOperationStatus = "active" | "disabled";
export type OpenApiHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type OpenApiConnectorRecord = {
  id: string;
  name: string;
  specUrl?: string;
  specHash?: string;
  baseUrl: string;
  authType: OpenApiConnectorAuthType;
  authTokenEnv?: string;
  authHeaderName?: string;
  status: OpenApiConnectorStatus;
  defaultRiskLevel: ToolRiskLevel;
  approvalRequired: boolean;
  operationCount: number;
  info?: Record<string, unknown>;
  lastImportedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenApiOperationRecord = {
  id: string;
  connectorId: string;
  connectorName: string;
  operationId: string;
  method: OpenApiHttpMethod;
  path: string;
  summary?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  requestContentType?: string;
  responseContentTypes: string[];
  riskLevel: ToolRiskLevel;
  approvalRequired: boolean;
  status: OpenApiOperationStatus;
  createdAt: string;
  updatedAt: string;
};

export type OpenApiConnectorLedger = {
  connectors: OpenApiConnectorRecord[];
  operations: OpenApiOperationRecord[];
};

export type OpenApiConnectorStats = {
  total: number;
  active: number;
  error: number;
  operationCount: number;
  latest: OpenApiConnectorRecord[];
};
