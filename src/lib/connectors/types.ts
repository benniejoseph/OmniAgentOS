import type { ToolRiskLevel } from "@/lib/tools/types";

export type McpConnectorTransport = "streamable_http";
export type McpConnectorAuthType = "none" | "bearer_env" | "bearer_vault";
export type McpConnectorStatus = "active" | "error" | "disabled";
export type McpToolStatus = "active" | "pending_review" | "disabled";

export type McpConnectorCredentialMetadata = {
  configured: boolean;
  version?: number;
  fingerprint?: string;
  rotatedAt?: string;
  originMatch: boolean;
};

export type McpConnectorRecord = {
  id: string;
  tenantId?: string;
  name: string;
  endpoint: string;
  transport: McpConnectorTransport;
  authType: McpConnectorAuthType;
  authTokenEnv?: string;
  credentialConfigured?: boolean;
  credentialVersion?: number;
  credentialFingerprint?: string;
  credentialRotatedAt?: string;
  credentialOriginMatch?: boolean;
  status: McpConnectorStatus;
  defaultRiskLevel: ToolRiskLevel;
  approvalRequired: boolean;
  toolCount: number;
  capabilities?: Record<string, unknown>;
  instructions?: string;
  serverVersion?: Record<string, unknown>;
  lastDiscoveredAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type McpToolRecord = {
  id: string;
  tenantId?: string;
  connectorId: string;
  connectorName: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  approvalRequired: boolean;
  status: McpToolStatus;
  createdAt: string;
  updatedAt: string;
};

export type McpConnectorLedger = {
  connectors: McpConnectorRecord[];
  tools: McpToolRecord[];
};

export type McpConnectorStats = {
  total: number;
  active: number;
  error: number;
  toolCount: number;
  latest: McpConnectorRecord[];
};
