import { getSessionToken } from "@/lib/auth/session";
import { getSessionIdentity, isAuthEnforced } from "@/lib/auth/store";
import type { RbacRule, SecurityContext, SecurityRole } from "@/lib/security/types";

const roles: SecurityRole[] = ["viewer", "operator", "admin", "system"];
const sensitiveKeyPattern = /api[_-]?key|token|secret|password|authorization|cookie|connection[_-]?string|database[_-]?url|private[_-]?key/i;
const forbiddenConnectorSecretNames = new Set([
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "CRON_SECRET",
  "OMNIAGENT_INTERNAL_AUTH_SECRET",
  "OMNIAGENT_REPORT_SIGNING_SECRET",
  "OMNIAGENT_BOOTSTRAP_PASSWORD",
  "RESEND_API_KEY",
  "SLACK_WEBHOOK_URL",
]);

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
  {
    action: "read.identity",
    description: "Read tenants, users, memberships, and active identity sessions.",
    roles: ["admin", "system"],
  },
  {
    action: "manage.identity",
    description: "Create users, assign tenant roles, and administer the identity control plane.",
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
  const trustedHeaders = getTrustedIdentityHeaders(request);
  const tenantId = normalizeTenantId(trustedHeaders.tenantId || process.env.OMNIAGENT_DEFAULT_TENANT || "default");
  const actorId = normalizeActorId(trustedHeaders.actorId || process.env.OMNIAGENT_DEFAULT_ACTOR || "anonymous");
  const role = normalizeRole(trustedHeaders.role || process.env.OMNIAGENT_DEFAULT_ROLE || "viewer");

  return {
    tenantId,
    actorId,
    role,
    source: trustedHeaders.source,
  };
}

export async function resolveSecurityContext(request?: Request): Promise<SecurityContext> {
  if (!isAuthEnforced()) {
    return getSecurityContext(request);
  }

  const identity = await getSessionIdentity(getSessionToken(request));
  if (!identity) {
    throw new SecurityPolicyError("Authentication required.", 401);
  }

  return identity.context;
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
    return Response.json(
      { error: error.status === 401 ? "Unauthorized" : "Forbidden", message: error.message },
      { status: error.status },
    );
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

export function validateConnectorSecretEnvName(value?: string) {
  if (!value) {
    return true;
  }

  const normalized = value.trim().toUpperCase();
  if (!validateSecretEnvName(normalized) || forbiddenConnectorSecretNames.has(normalized)) {
    return false;
  }

  if (normalized.startsWith("OMNIAGENT_CONNECTOR_")) {
    return true;
  }

  return connectorSecretAllowlist().has(normalized);
}

function getTrustedIdentityHeaders(request?: Request) {
  const headers = request?.headers;
  const hasIdentityHeaders = Boolean(
    headers?.get("x-omni-tenant-id") || headers?.get("x-omni-user-id") || headers?.get("x-omni-user-role"),
  );

  if (!hasIdentityHeaders || !canTrustIdentityHeaders(request)) {
    return { source: "default" as const };
  }

  return {
    tenantId: headers?.get("x-omni-tenant-id") || undefined,
    actorId: headers?.get("x-omni-user-id") || undefined,
    role: headers?.get("x-omni-user-role") || undefined,
    source: "headers" as const,
  };
}

function canTrustIdentityHeaders(request?: Request) {
  const configuredSecret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  const providedSecret = request?.headers.get("x-omni-internal-auth")?.trim();

  if (configuredSecret && providedSecret && configuredSecret === providedSecret) {
    return true;
  }

  return (
    process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS === "true" &&
    !process.env.VERCEL &&
    process.env.NODE_ENV !== "production"
  );
}

function connectorSecretAllowlist() {
  return new Set(
    (process.env.OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function secretVaultPolicy() {
  return {
    storage: "Connectors store environment variable names only; secret values stay in Vercel or local env.",
    allowedEnvNamePattern: "^OMNIAGENT_CONNECTOR_[A-Z0-9_]+$ or names listed in OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST",
    disallowedPrefixes: ["NEXT_PUBLIC_"],
    disallowedNames: [...forbiddenConnectorSecretNames],
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
