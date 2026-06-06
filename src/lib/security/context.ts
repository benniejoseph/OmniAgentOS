import type { RbacRule, SecurityContext, SecurityRole } from "@/lib/security/types";

const roles: SecurityRole[] = ["viewer", "operator", "admin", "system"];
const sensitiveKeyPattern = /api[_-]?key|token|secret|password|authorization|cookie|connection[_-]?string|database[_-]?url|private[_-]?key/i;

export const rbacRules: RbacRule[] = [
  {
    action: "read",
    description: "Read dashboards, ledgers, capabilities, memory, knowledge, and audit summaries.",
    roles: ["viewer", "operator", "admin", "system"],
  },
  {
    action: "write.memory",
    description: "Write durable memories and ingest knowledge.",
    roles: ["operator", "admin", "system"],
  },
  {
    action: "execute.tool",
    description: "Execute governed tools. Dry runs are readable; live calls require this permission.",
    roles: ["operator", "admin", "system"],
  },
  {
    action: "manage.connector",
    description: "Register, import, and discover external connectors.",
    roles: ["admin", "system"],
  },
  {
    action: "manage.workflow",
    description: "Start, tick, signal, approve, retry, or cancel durable workflows.",
    roles: ["operator", "admin", "system"],
  },
  {
    action: "run.evaluation",
    description: "Run regression/evaluation suites.",
    roles: ["operator", "admin", "system"],
  },
  {
    action: "read.security",
    description: "Read security context, RBAC policy, and audit records.",
    roles: ["admin", "system"],
  },
];

export class SecurityPolicyError extends Error {
  constructor(
    message: string,
    public readonly status = 403,
  ) {
    super(message);
    this.name = "SecurityPolicyError";
  }
}

export function getSecurityContext(request?: Request): SecurityContext {
  const headers = request?.headers;
  const tenantId = normalizeTenantId(headers?.get("x-omni-tenant-id") || process.env.OMNIAGENT_DEFAULT_TENANT || "default");
  const actorId = normalizeActorId(headers?.get("x-omni-user-id") || process.env.OMNIAGENT_DEFAULT_ACTOR || "anonymous");
  const role = normalizeRole(headers?.get("x-omni-user-role") || process.env.OMNIAGENT_DEFAULT_ROLE || "admin");

  return {
    tenantId,
    actorId,
    role,
    source: headers?.get("x-omni-user-role") || headers?.get("x-omni-tenant-id") ? "headers" : "default",
  };
}

export function canPerform(role: SecurityRole, action: string) {
  const rule = rbacRules.find((item) => item.action === action);
  return Boolean(rule?.roles.includes(role));
}

export function requirePermission(context: SecurityContext, action: string) {
  if (!canPerform(context.role, action)) {
    throw new SecurityPolicyError(`Role ${context.role} cannot perform ${action}.`);
  }
}

export function securityErrorResponse(error: unknown) {
  if (error instanceof SecurityPolicyError) {
    return Response.json({ error: "Forbidden", message: error.message }, { status: error.status });
  }

  throw error;
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[redacted]" : redactSensitive(item),
      ]),
    );
  }

  if (typeof value === "string" && looksLikeSecret(value)) {
    return "[redacted]";
  }

  return value;
}

export function validateSecretEnvName(value?: string) {
  if (!value) {
    return true;
  }

  return /^[A-Z0-9_]+$/.test(value) && !/^NEXT_PUBLIC_/i.test(value);
}

export function secretVaultPolicy() {
  return {
    storage: "Connectors store environment variable names only; secret values stay in Vercel or local env.",
    allowedEnvNamePattern: "^[A-Z0-9_]+$",
    disallowedPrefixes: ["NEXT_PUBLIC_"],
    redactedFields: ["apiKey", "token", "secret", "password", "authorization", "cookie", "databaseUrl"],
  };
}

function normalizeRole(value: string): SecurityRole {
  const normalized = value.trim().toLowerCase();
  return roles.includes(normalized as SecurityRole) ? (normalized as SecurityRole) : "viewer";
}

function normalizeTenantId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}

function normalizeActorId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_.:@-]/g, "_").slice(0, 160) || "anonymous";
}

function looksLikeSecret(value: string) {
  if (value.length < 24) {
    return false;
  }

  return /^(sk-|Bearer\s+|eyJ|postgresql:\/\/|mysql:\/\/|mongodb:\/\/)/i.test(value);
}
