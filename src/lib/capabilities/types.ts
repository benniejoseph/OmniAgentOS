import type { ToolDefinition, ToolRiskLevel } from "@/lib/tools/types";

export const CAPABILITY_DEFAULT_LIMIT = 12;
export const CAPABILITY_MAX_LIMIT = 50;
export const CAPABILITY_MAX_QUERY_LENGTH = 160;
export const CAPABILITY_MAX_ALLOWLIST_ENTRIES = 128;

export type CapabilitySource = "native" | "mcp" | "openapi";

/**
 * A deliberately compact, model- and UI-safe view of an executable tool.
 * Schemas, connector endpoints, credentials, and approval fingerprints never
 * cross the discovery boundary.
 */
export type CapabilityDescriptor = {
  id: string;
  name: string;
  description: string;
  category: ToolDefinition["category"];
  source: CapabilitySource;
  riskLevel: ToolRiskLevel;
  approvalRequired: boolean;
  reversible: boolean;
};

export type CapabilitySearchInput = {
  tenantId: string;
  query?: string;
  limit?: number;
  allowlist?: readonly string[];
};

export type CapabilityResolveInput = {
  tenantId: string;
  id: string;
  allowlist?: readonly string[];
};

export type CapabilitySearchResult = {
  capabilities: CapabilityDescriptor[];
  query: string;
  total: number;
  limit: number;
  hasMore: boolean;
};
