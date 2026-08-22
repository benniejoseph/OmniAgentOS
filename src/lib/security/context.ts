import { createHash, timingSafeEqual } from "node:crypto";
import { getSessionToken } from "@/lib/auth/session";
import { getSessionIdentity, isAuthEnforced } from "@/lib/auth/store";
import { enterDatabaseTenantContext } from "@/lib/db/client";
import type { RbacRule, SecurityContext, SecurityRole } from "@/lib/security/types";

const roles: SecurityRole[] = ["viewer", "operator", "admin", "system"];
const sensitiveKeyPattern =
  /api[_-]?key|token|secret|password|authorization|cookie|connection[_-]?string|database[_-]?url|private[_-]?key/i;
const nonSecretTokenMetadataKeys = new Set([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "max_tokens",
  "min_tokens",
  "token_count",
  "token_limit",
  "token_budget",
  "token_estimate",
  "token_index",
  "token_type",
  "token_usage",
]);
const forbiddenConnectorSecretNames = new Set([
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "CRON_SECRET",
  "OMNIAGENT_INTERNAL_AUTH_SECRET",
  "OMNIAGENT_REPORT_SIGNING_SECRET",
  "OMNIAGENT_REPORT_SIGNING_KEYS",
  "OMNIAGENT_BOOTSTRAP_PASSWORD",
  "OMNIAGENT_BACKUP_DATABASE_URL",
  "OMNIAGENT_CONNECTOR_SECRET_BINDINGS",
  "OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST",
  "OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS",
  "OMNIAGENT_TRIGGER_SECRET_ALLOWLIST",
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
    action: "run.agent",
    description: "Start interactive agent runs that may execute low-risk governed tools.",
    roles: ["operator", "admin", "system"],
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
  {
    action: "manage.security",
    description: "Run controlled platform security maintenance such as database migrations.",
    roles: ["system"],
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

  const context = {
    tenantId,
    actorId,
    role,
    source: trustedHeaders.source,
  };
  enterDatabaseTenantContext(context.tenantId);
  return context;
}

export async function resolveSecurityContext(request?: Request): Promise<SecurityContext> {
  // Seed a mutable fail-closed scope before the first await. The caller's
  // continuation inherits this object, and the authenticated tenant is filled
  // in below after the asynchronous session lookup completes.
  enterDatabaseTenantContext();
  if (getTrustedIdentityHeaders(request).source === "headers") {
    return getSecurityContext(request);
  }

  if (!isAuthEnforced()) {
    return getSecurityContext(request);
  }

  const identity = await getSessionIdentity(getSessionToken(request));
  if (!identity) {
    throw new SecurityPolicyError("Authentication required.", 401);
  }

  enterDatabaseTenantContext(identity.context.tenantId);
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
  return redactSensitiveValue(value, new WeakSet<object>(), 0);
}

function redactSensitiveValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (depth >= 64) {
    return "[truncated-depth]";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const redacted = value
      .slice(0, 1_000)
      .map((item) => redactSensitiveValue(item, seen, depth + 1));
    if (value.length > redacted.length) {
      redacted.push(`[truncated ${value.length - redacted.length} items]`);
    }
    seen.delete(value);
    return redacted;
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    const redacted = Object.fromEntries(
      entries.slice(0, 1_000).map(([key, item]) => [
        key,
        isSensitiveKey(key)
          ? "[redacted]"
          : redactSensitiveValue(item, seen, depth + 1),
      ]),
    );
    if (entries.length > 1_000) {
      redacted.__truncated_fields__ = entries.length - 1_000;
    }
    seen.delete(value);
    return redacted;
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  return value;
}

function isSensitiveKey(key: string) {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return (
    !nonSecretTokenMetadataKeys.has(normalized) &&
    sensitiveKeyPattern.test(normalized)
  );
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

export function validateTriggerSecretEnvName(value?: string) {
  if (!value) {
    return true;
  }
  const normalized = value.trim().toUpperCase();
  if (!validateSecretEnvName(normalized) || forbiddenConnectorSecretNames.has(normalized)) {
    return false;
  }
  if (normalized.startsWith("OMNIAGENT_TRIGGER_")) {
    return true;
  }
  if (triggerSecretAllowlist().has(normalized)) {
    return true;
  }
  return (
    process.env.NODE_ENV !== "production" &&
    !process.env.VERCEL &&
    process.env.VERCEL_ENV !== "production"
  );
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

  if (configuredSecret && providedSecret && secretsMatch(configuredSecret, providedSecret)) {
    return true;
  }

  return (
    process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS === "true" &&
    !process.env.VERCEL &&
    process.env.NODE_ENV !== "production"
  );
}

function secretsMatch(expected: string, provided: string) {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

function connectorSecretAllowlist() {
  return new Set(
    (process.env.OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
}

function triggerSecretAllowlist() {
  return new Set(
    (process.env.OMNIAGENT_TRIGGER_SECRET_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function secretVaultPolicy() {
  return {
    storage:
      "Connectors store environment variable names only; use requires an exact tenant-and-origin deployer binding.",
    allowedEnvNamePattern:
      "^OMNIAGENT_CONNECTOR_[A-Z0-9_]+$ or names listed in OMNIAGENT_CONNECTOR_SECRET_ALLOWLIST, plus OMNIAGENT_CONNECTOR_SECRET_BINDINGS authorization",
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

function redactSensitiveText(value: string) {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
      "[redacted-private-key]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted-api-key]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted-github-token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "[redacted-slack-token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-access-key]")
    .replace(/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, "[redacted-api-key]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[redacted-jwt]",
    )
    .replace(/\bhttps?:\/\/[^:\s/@]+:[^@\s/]+@[^\s"'<>]+/gi, "[redacted-credential-url]")
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
      "[redacted-connection-url]",
    )
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)(["']?)[^\s,;"']{8,}\2/gi,
      "$1[redacted]",
    );
}
