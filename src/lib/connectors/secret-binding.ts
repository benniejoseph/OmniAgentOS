import { createHash } from "node:crypto";
import { validateConnectorSecretEnvName } from "@/lib/security/context";
import type { SecurityRole } from "@/lib/security/types";

type ConnectorSecretBindingInput = {
  envName?: string;
  tenantId?: string;
  targetUrl: string;
  role?: SecurityRole;
};

type ConfiguredSecretBinding = {
  tenants: string[];
  origins: string[];
};

export type ConnectorSecretBindingDecision = {
  allowed: boolean;
  mode?: "deployer_binding" | "legacy_system";
  reason: string;
};

/**
 * Secret names are authorization handles, not merely identifiers. Tenant
 * administrators may use only deployer-defined tenant+origin bindings. A
 * tenant-prefixed name is useful for organization, but is not authorization:
 * allowing it for an arbitrary caller-selected origin would expose the secret.
 * Legacy system-only access is available solely behind an explicit temporary
 * compatibility flag; production defaults require deployer bindings too.
 */
export function evaluateConnectorSecretBinding(
  input: ConnectorSecretBindingInput,
): ConnectorSecretBindingDecision {
  const envName = input.envName?.trim().toUpperCase();
  if (!envName) {
    return { allowed: true, reason: "Connector does not reference a process secret." };
  }
  if (!validateConnectorSecretEnvName(envName)) {
    return { allowed: false, reason: `Connector secret environment variable ${envName} is not allowed.` };
  }
  const configuredSecret = process.env[envName]?.trim();
  if (!configuredSecret) {
    return {
      allowed: false,
      reason: `Connector secret environment variable ${envName} is not configured in this deployment.`,
    };
  }
  if (Buffer.byteLength(configuredSecret, "utf8") < 16) {
    return {
      allowed: false,
      reason: `Connector secret environment variable ${envName} must contain at least 16 bytes.`,
    };
  }

  const tenantId = normalizeTenantId(input.tenantId);
  let origin: string;
  try {
    origin = exactOrigin(input.targetUrl);
  } catch {
    return { allowed: false, reason: "Connector secret binding requires a valid http(s) target origin." };
  }
  const configured = readConfiguredBindings().get(envName);
  if (
    configured &&
    configured.tenants.includes(tenantId) &&
    configured.origins.includes(origin)
  ) {
    return {
      allowed: true,
      mode: "deployer_binding",
      reason: `Deployer bound ${envName} to tenant ${tenantId} and origin ${origin}.`,
    };
  }

  if (
    input.role === "system" &&
    process.env.OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS === "true"
  ) {
    return {
      allowed: true,
      mode: "legacy_system",
      reason: "System caller accepted a legacy global connector secret handle.",
    };
  }

  return {
    allowed: false,
    reason:
      `${envName} is not deployer-bound to tenant ${tenantId} and origin ${origin}. ` +
      "Add an exact tenant+origin entry to OMNIAGENT_CONNECTOR_SECRET_BINDINGS.",
  };
}

export function assertConnectorSecretBinding(input: ConnectorSecretBindingInput) {
  const decision = evaluateConnectorSecretBinding(input);
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }
  return decision;
}

export function tenantConnectorSecretPrefix(tenantId?: string) {
  return `OMNIAGENT_CONNECTOR_${tenantEnvSegment(normalizeTenantId(tenantId))}_`;
}

function readConfiguredBindings() {
  const bindings = new Map<string, ConfiguredSecretBinding>();
  const raw = process.env.OMNIAGENT_CONNECTOR_SECRET_BINDINGS?.trim();
  if (!raw) {
    return bindings;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bindings;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return bindings;
  }

  for (const [rawEnvName, value] of Object.entries(parsed as Record<string, unknown>)) {
    const envName = rawEnvName.trim().toUpperCase();
    if (!validateConnectorSecretEnvName(envName) || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    const tenants = normalizeStringList(record.tenants ?? record.tenantId, normalizeTenantId);
    const origins = normalizeStringList(record.origins ?? record.origin, exactOriginSafely);
    if (tenants.length && origins.length) {
      bindings.set(envName, { tenants, origins });
    }
  }
  return bindings;
}

function normalizeStringList(
  value: unknown,
  normalize: (value: string) => string | undefined,
) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return Array.from(
    new Set(
      values
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .map((item) => normalize(item.trim()))
        .filter((item): item is string => Boolean(item)),
    ),
  );
}

function exactOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Connector target must use http or https.");
  }
  return url.origin;
}

function exactOriginSafely(value: string) {
  try {
    return exactOrigin(value);
  } catch {
    return undefined;
  }
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .slice(0, 120) || "default";
}

function tenantEnvSegment(value: string) {
  const readable =
    value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) ||
    "DEFAULT";
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16).toUpperCase();
  return `${readable}_${digest}`;
}
