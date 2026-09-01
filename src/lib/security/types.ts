export type SecurityRole = "viewer" | "operator" | "admin" | "system";
export type SecurityDecision = "allow" | "deny";

export type SecurityContext = {
  tenantId: string;
  actorId: string;
  role: SecurityRole;
  source: "headers" | "default" | "session" | "service";
  auth?: {
    userId: string;
    email: string;
    sessionId: string;
    tenantName: string;
  };
};

export type SecurityAuditRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  actorRole: SecurityRole;
  action: string;
  resourceType: string;
  resourceId?: string;
  decision: SecurityDecision;
  reason?: string;
  riskLevel?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SecurityAuditLedger = {
  records: SecurityAuditRecord[];
};

export type SecurityStats = {
  total: number;
  byDecision: Record<string, number>;
  byRole: Record<string, number>;
  latest: SecurityAuditRecord[];
};

export type RbacRule = {
  action: string;
  description: string;
  roles: SecurityRole[];
};
