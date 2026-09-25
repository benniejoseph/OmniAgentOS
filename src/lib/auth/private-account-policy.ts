import type { SecurityRole } from "@/lib/security/types";

const PRIVATE_ACCOUNT_ALLOWLIST_ENV =
  "OMNIAGENT_PRIVATE_ACCOUNT_ALLOWLIST_JSON";
const MAX_PRIVATE_ACCOUNTS = 16;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

export type PrivateAccountPolicy = Readonly<{
  email: string;
  tenantId: string;
  tenantName: string;
  tenantMode: "existing" | "new";
  label: string;
  name?: string;
  role: Extract<SecurityRole, "viewer" | "operator" | "admin">;
}>;

export class PrivateAccountPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateAccountPolicyError";
  }
}

/**
 * Server-owned admission policy for this private application. Every account is
 * mapped to one immutable tenant so adding an email never joins an existing
 * workspace by accident.
 */
export function privateAccountPolicies(): readonly PrivateAccountPolicy[] {
  const configured = process.env[PRIVATE_ACCOUNT_ALLOWLIST_ENV]?.trim();
  if (configured) return parseConfiguredPolicies(configured);

  const email = normalizeEmail(
    process.env.OMNIAGENT_OWNER_EMAIL ||
      process.env.OWNER_EMAIL ||
      process.env.OMNIAGENT_BOOTSTRAP_EMAIL ||
      "",
  );
  if (!email) return [];
  const tenantId = normalizeTenantId(
    process.env.OMNIAGENT_DEFAULT_TENANT || "default",
  );
  if (!EMAIL.test(email) || email.length > 320 || !TENANT_ID.test(tenantId)) {
    throw new PrivateAccountPolicyError(
      "The legacy private account fallback is invalid.",
    );
  }
  return [
    {
      email,
      tenantId,
      tenantName: process.env.OMNIAGENT_BOOTSTRAP_TENANT?.trim() || "Asael",
      tenantMode: "existing",
      label: "Personal",
      name: process.env.OMNIAGENT_BOOTSTRAP_NAME?.trim() || undefined,
      role: "admin",
    },
  ];
}

export function privateAccountPolicyForEmail(
  email: string,
): PrivateAccountPolicy | undefined {
  const normalized = normalizeEmail(email);
  return privateAccountPolicies().find((policy) => policy.email === normalized);
}

export function privateAccountPolicyForIdentity(input: {
  email: string;
  tenantId: string;
  role?: SecurityRole;
}): PrivateAccountPolicy | undefined {
  const policy = privateAccountPolicyForEmail(input.email);
  return policy &&
    policy.tenantId === input.tenantId &&
    (input.role === undefined || policy.role === input.role)
    ? policy
    : undefined;
}

export function privateAccountAllowlistConfigured() {
  return privateAccountPolicies().length > 0;
}

export function privateAccountAllowlistEnvironmentName() {
  return PRIVATE_ACCOUNT_ALLOWLIST_ENV;
}

function parseConfiguredPolicies(value: string): readonly PrivateAccountPolicy[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PrivateAccountPolicyError(
      `${PRIVATE_ACCOUNT_ALLOWLIST_ENV} must be valid JSON.`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_PRIVATE_ACCOUNTS) {
    throw new PrivateAccountPolicyError(
      `${PRIVATE_ACCOUNT_ALLOWLIST_ENV} must contain between 1 and ${MAX_PRIVATE_ACCOUNTS} accounts.`,
    );
  }

  const emails = new Set<string>();
  const tenants = new Set<string>();
  return Object.freeze(parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new PrivateAccountPolicyError(
        `Private account ${index + 1} must be an object.`,
      );
    }
    const record = candidate as Record<string, unknown>;
    const email = normalizeEmail(stringValue(record.email));
    const tenantId = normalizeTenantId(stringValue(record.tenantId));
    const tenantName = boundedText(record.tenantName, 160);
    const tenantMode = stringValue(record.tenantMode);
    const label = boundedText(record.label, 80);
    const name = boundedText(record.name, 160, true);
    const role = record.role === undefined ? "admin" : String(record.role);
    if (!EMAIL.test(email) || email.length > 320) {
      throw new PrivateAccountPolicyError(
        `Private account ${index + 1} has an invalid email.`,
      );
    }
    if (!TENANT_ID.test(tenantId)) {
      throw new PrivateAccountPolicyError(
        `Private account ${index + 1} has an invalid tenantId.`,
      );
    }
    if (!tenantName || !label) {
      throw new PrivateAccountPolicyError(
        `Private account ${index + 1} requires tenantName and label.`,
      );
    }
    if (tenantMode !== "existing" && tenantMode !== "new") {
      throw new PrivateAccountPolicyError(
        `Private account ${index + 1} requires tenantMode to be existing or new.`,
      );
    }
    if (!(["viewer", "operator", "admin"] as const).includes(
      role as "viewer" | "operator" | "admin",
    )) {
      throw new PrivateAccountPolicyError(
        `Private account ${index + 1} has an invalid role.`,
      );
    }
    if (emails.has(email)) {
      throw new PrivateAccountPolicyError(
        `${PRIVATE_ACCOUNT_ALLOWLIST_ENV} contains a duplicate email.`,
      );
    }
    if (tenants.has(tenantId)) {
      throw new PrivateAccountPolicyError(
        `${PRIVATE_ACCOUNT_ALLOWLIST_ENV} must map every account to a separate tenant.`,
      );
    }
    emails.add(email);
    tenants.add(tenantId);
    return Object.freeze({
      email,
      tenantId,
      tenantName,
      tenantMode,
      label,
      ...(name ? { name } : {}),
      role: role as PrivateAccountPolicy["role"],
    });
  }));
}

function boundedText(value: unknown, max: number, optional = false) {
  if (value === undefined && optional) return undefined;
  const normalized = stringValue(value).trim();
  if (normalized.length > max) {
    throw new PrivateAccountPolicyError(
      `Private account text values must be ${max} characters or fewer.`,
    );
  }
  return normalized || undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeTenantId(value: string) {
  return value.trim();
}
