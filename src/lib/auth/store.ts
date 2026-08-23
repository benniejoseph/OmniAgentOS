import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { createOpaqueToken, hashPassword, hashSessionToken, verifyPassword } from "@/lib/auth/crypto";
import type {
  AuthControlPlane,
  AuthLedger,
  AuthMembership,
  AuthSessionIdentity,
  AuthSessionRecord,
  AuthTenant,
  AuthUser,
  AuthUserWithPassword,
} from "@/lib/auth/types";
import type { SecurityRole } from "@/lib/security/types";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

type SqlClientForAuthTransaction = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>;
};

const dummyPasswordHash =
  "scrypt-v1$omniagent-dummy-login$X7MyB13IWIzXrU648ArSBJZqJyiiF6mbdpeGIuCUymOwQM0yxhUnxQBmApRQxxniAfsHnDJs8IQuf89TR8LUOQ";
const sessionTouchIntervalMs = 5 * 60 * 1000;

export class IdentityConflictError extends Error {
  readonly status = 409;
  readonly code = "identity_conflict";

  constructor() {
    super("An identity with this email already exists or cannot be added to this tenant.");
    this.name = "IdentityConflictError";
  }
}

export function isAuthEnforced() {
  const configured = (process.env.OMNIAGENT_AUTH_ENABLED || "").trim().toLowerCase();
  const explicitEnable = ["1", "true", "enforced"].includes(configured);
  const explicitDisable = ["0", "false", "disabled"].includes(configured);
  const isProductionRuntime = Boolean(
    process.env.NODE_ENV === "production" ||
      process.env.VERCEL ||
      process.env.VERCEL_ENV === "production",
  );

  if (isProductionRuntime) {
    return true;
  }

  return explicitEnable && !explicitDisable;
}

export function isBootstrapConfigured() {
  return Boolean(process.env.OMNIAGENT_BOOTSTRAP_EMAIL?.trim() && process.env.OMNIAGENT_BOOTSTRAP_PASSWORD);
}

export async function ensureBootstrapIdentity() {
  if (!isBootstrapConfigured()) {
    return;
  }
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      "Seed the configured bootstrap identity before authentication.",
      ensureBootstrapIdentityInScope,
    );
  }
  return ensureBootstrapIdentityInScope();
}

async function ensureBootstrapIdentityInScope() {
  if (!isBootstrapConfigured()) {
    return;
  }
  const email = normalizeEmail(process.env.OMNIAGENT_BOOTSTRAP_EMAIL!);
  const password = process.env.OMNIAGENT_BOOTSTRAP_PASSWORD!;
  const tenantName = process.env.OMNIAGENT_BOOTSTRAP_TENANT || "OmniAgent OS";
  const tenantId = normalizeTenantId(process.env.OMNIAGENT_DEFAULT_TENANT || "default");
  const existing = await findUserByEmail(email);

  if (existing) {
    await ensureBootstrapMembership({
      tenantId,
      tenantName,
      userId: existing.id,
      role: "admin",
    });
    return;
  }

  await createUserWithMembership({
    email,
    name: process.env.OMNIAGENT_BOOTSTRAP_NAME || "OmniAgent Admin",
    password,
    role: "admin",
    tenantId,
    tenantName,
  });
}

export async function authenticatePassword({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      "Authenticate an identity before its tenant is known.",
      () => authenticatePasswordInScope({ email, password }),
    );
  }
  return authenticatePasswordInScope({ email, password });
}

async function authenticatePasswordInScope({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  await ensureBootstrapIdentityInScope();
  const user = await findUserByEmail(normalizeEmail(email));
  // Always perform one scrypt verification so unknown emails do not create a
  // materially cheaper, user-enumerable path.
  const passwordMatches = await verifyPassword(password, user?.passwordHash || dummyPasswordHash);
  if (!user || user.status !== "active" || !passwordMatches) {
    return null;
  }

  const membership = await findPrimaryMembership(user.id);
  if (!membership || membership.status !== "active") {
    return null;
  }

  const tenant = await findTenant(membership.tenantId);
  if (!tenant) {
    return null;
  }

  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + getSessionTtlDays() * 24 * 60 * 60 * 1000).toISOString();
  const session = await createSession({
    userId: user.id,
    tenantId: tenant.id,
    token,
    expiresAt,
  });
  await markLastLogin(user.id);

  return {
    token,
    identity: identityFromRecords({
      session,
      user,
      tenant,
      membership,
    }),
  };
}

export async function getSessionIdentity(token?: string): Promise<AuthSessionIdentity | null> {
  if (!token) {
    return null;
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      "Resolve an opaque session token before its tenant is known.",
      () => getSessionIdentityInScope(token),
    );
  }
  return getSessionIdentityInScope(token);
}

async function getSessionIdentityInScope(token: string): Promise<AuthSessionIdentity | null> {
  const tokenHash = hashSessionToken(token);

  if (hasDatabaseUrl()) {
    const rows = await getSql()`
      SELECT
        sessions.id as session_id,
        sessions.user_id,
        sessions.tenant_id,
        sessions.expires_at,
        sessions.created_at as session_created_at,
        sessions.last_seen_at,
        users.email,
        users.name,
        users.status as user_status,
        users.last_login_at,
        users.created_at as user_created_at,
        users.updated_at as user_updated_at,
        tenants.name as tenant_name,
        tenants.slug as tenant_slug,
        tenants.created_at as tenant_created_at,
        tenants.updated_at as tenant_updated_at,
        memberships.id as membership_id,
        memberships.role,
        memberships.status as membership_status,
        memberships.created_at as membership_created_at,
        memberships.updated_at as membership_updated_at
      FROM omni_auth_sessions sessions
      JOIN omni_auth_users users ON users.id = sessions.user_id
      JOIN omni_auth_tenants tenants ON tenants.id = sessions.tenant_id
      JOIN omni_auth_memberships memberships
        ON memberships.tenant_id = sessions.tenant_id AND memberships.user_id = sessions.user_id
      WHERE sessions.token_hash = ${tokenHash}
        AND sessions.expires_at > NOW()
        AND users.status = 'active'
        AND memberships.status = 'active'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }

    if (
      Date.now() - new Date(normalizeDate(row.last_seen_at)).getTime() >=
      sessionTouchIntervalMs
    ) {
      await getSql()`
        UPDATE omni_auth_sessions
        SET last_seen_at = NOW()
        WHERE id = ${String(row.session_id)}
          AND last_seen_at < NOW() - INTERVAL '5 minutes'
      `;
    }
    return identityFromJoinedRow(row);
  }

  const ledger = await readAuthLedger();
  const session = ledger.sessions.find((item) => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > Date.now());
  if (!session) {
    return null;
  }

  const user = ledger.users.find((item) => item.id === session.userId && item.status === "active");
  const membership = ledger.memberships.find(
    (item) => item.userId === session.userId && item.tenantId === session.tenantId && item.status === "active",
  );
  const tenant = ledger.tenants.find((item) => item.id === session.tenantId);
  if (!user || !membership || !tenant) {
    return null;
  }

  if (
    Date.now() - new Date(session.lastSeenAt).getTime() >=
    sessionTouchIntervalMs
  ) {
    await mutateAuthLedger((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === session.id
          ? { ...item, lastSeenAt: new Date().toISOString() }
          : item,
      ),
    }));
  }

  return identityFromRecords({ session, user, tenant, membership });
}

export async function destroySession(token?: string) {
  if (!token) {
    return;
  }

  const tokenHash = hashSessionToken(token);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseSystemScope(
      "Destroy an opaque session token before its tenant is known.",
      () => getSql()`DELETE FROM omni_auth_sessions WHERE token_hash = ${tokenHash}`,
    );
    return;
  }

  await mutateAuthLedger((ledger) => ({
    ...ledger,
    sessions: ledger.sessions.filter((session) => session.tokenHash !== tokenHash),
  }));
}

export async function createUserWithMembership({
  email,
  name,
  password,
  role,
  tenantId = normalizeTenantId(process.env.OMNIAGENT_DEFAULT_TENANT || "default"),
  tenantName = "OmniAgent OS",
}: {
  email: string;
  name?: string;
  password: string;
  role: SecurityRole;
  tenantId?: string;
  tenantName?: string;
}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedTenantId = normalizeTenantId(tenantId);
  const normalizedTenantName = tenantName?.trim() || normalizedTenantId;
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const userId = randomUUID();
    return runWithDatabaseTenantScope(normalizedTenantId, () =>
      getSql().transaction(async (sql: SqlClientForAuthTransaction) => {
        await sql`
          INSERT INTO omni_auth_tenants (id, name, slug, created_at, updated_at)
          VALUES (${normalizedTenantId}, ${normalizedTenantName}, ${normalizedTenantId}, ${now}, ${now})
          ON CONFLICT (id) DO NOTHING
        `;
        const users = await sql`
          INSERT INTO omni_auth_users (id, email, name, password_hash, status, created_at, updated_at)
          VALUES (${userId}, ${normalizedEmail}, ${name || null}, ${passwordHash}, 'active', ${now}, ${now})
          ON CONFLICT (email) DO NOTHING
          RETURNING *
        `;
        if (!users[0]) {
          throw new IdentityConflictError();
        }
        await sql`
          INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${normalizedTenantId}, ${userId}, ${role}, 'active', ${now}, ${now})
        `;
        return userFromRow(users[0]);
      }) as Promise<AuthUser>,
    );
  }

  await mutateAuthLedger((ledger) => {
    const existing = ledger.users.find((user) => user.email === normalizedEmail);
    if (existing) {
      throw new IdentityConflictError();
    }
    const userId = randomUUID();
    const tenants = upsertTenant(ledger.tenants, {
      id: normalizedTenantId,
      name: normalizedTenantName,
      slug: normalizedTenantId,
      createdAt: now,
      updatedAt: now,
    });
    const users = [
      ...ledger.users,
      {
        id: userId,
        email: normalizedEmail,
        name,
        passwordHash,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      },
    ];
    return {
      ...ledger,
      tenants,
      users,
      memberships: upsertMembership(ledger.memberships, {
        id: randomUUID(),
        tenantId: normalizedTenantId,
        userId,
        role,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    };
  });

  return stripPassword((await findUserByEmail(normalizedEmail))!);
}

export async function rotateUserPassword({
  email,
  password,
  tenantId = normalizeTenantId(
    process.env.OMNIAGENT_DEFAULT_TENANT || "default",
  ),
}: {
  email: string;
  password: string;
  tenantId?: string;
}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedTenantId = normalizeTenantId(tenantId);
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(normalizedTenantId, () =>
      getSql().transaction(async (sql: SqlClientForAuthTransaction) => {
        const users = await sql`
          SELECT users.*
          FROM omni_auth_users users
          JOIN omni_auth_memberships memberships
            ON memberships.user_id = users.id
          WHERE users.email = ${normalizedEmail}
            AND memberships.tenant_id = ${normalizedTenantId}
            AND memberships.status = 'active'
          LIMIT 1
          FOR UPDATE OF users
        `;
        if (!users[0]) {
          return null;
        }
        await sql`
          UPDATE omni_auth_users
          SET password_hash = ${passwordHash},
              updated_at = ${now}
          WHERE id = ${String(users[0].id)}
        `;
        await sql`
          DELETE FROM omni_auth_sessions
          WHERE user_id = ${String(users[0].id)}
            AND tenant_id = ${normalizedTenantId}
        `;
        return userFromRow({
          ...users[0],
          password_hash: passwordHash,
          updated_at: now,
        });
      }) as Promise<AuthUser | null>,
    );
  }

  let rotated: AuthUser | null = null;
  await mutateAuthLedger((ledger) => {
    const user = ledger.users.find(
      (candidate) => candidate.email === normalizedEmail,
    );
    if (
      !user ||
      !ledger.memberships.some(
        (membership) =>
          membership.userId === user.id &&
          membership.tenantId === normalizedTenantId &&
          membership.status === "active",
      )
    ) {
      return ledger;
    }
    const nextUser = {
      ...user,
      passwordHash,
      updatedAt: now,
    };
    rotated = stripPassword(nextUser);
    return {
      ...ledger,
      users: ledger.users.map((candidate) =>
        candidate.id === user.id ? nextUser : candidate,
      ),
      sessions: ledger.sessions.filter(
        (session) =>
          session.userId !== user.id ||
          session.tenantId !== normalizedTenantId,
      ),
    };
  });
  return rotated;
}

export async function getAuthControlPlane(options: { tenantId?: string } = {}): Promise<AuthControlPlane> {
  await ensureBootstrapIdentity();
  const tenantId = normalizeTenantId(options.tenantId || process.env.OMNIAGENT_DEFAULT_TENANT || "default");

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(tenantId, async () => {
      const [tenants, users, memberships, sessions] = await Promise.all([
        getSql()`SELECT * FROM omni_auth_tenants WHERE id = ${tenantId} ORDER BY created_at DESC LIMIT 50`,
        getSql()`
          SELECT users.*
          FROM omni_auth_users users
          JOIN omni_auth_memberships memberships ON memberships.user_id = users.id
          WHERE memberships.tenant_id = ${tenantId}
          ORDER BY users.created_at DESC
          LIMIT 100
        `,
        getSql()`SELECT * FROM omni_auth_memberships WHERE tenant_id = ${tenantId} ORDER BY created_at DESC LIMIT 100`,
        getSql()`
          SELECT *
          FROM omni_auth_sessions
          WHERE expires_at > NOW()
            AND tenant_id = ${tenantId}
          ORDER BY last_seen_at DESC
          LIMIT 100
        `,
      ]);
      const safeUsers = users.map(userFromRow);
      const activeSessions = sessions.map(sessionFromRow);
      return {
        authEnabled: isAuthEnforced(),
        bootstrapConfigured: isBootstrapConfigured(),
        stats: {
          tenants: tenants.length,
          users: safeUsers.length,
          activeUsers: safeUsers.filter((user) => user.status === "active").length,
          sessions: activeSessions.length,
        },
        tenants: tenants.map(tenantFromRow),
        users: safeUsers,
        memberships: memberships.map(membershipFromRow),
        sessions: activeSessions,
      };
    });
  }

  const ledger = await readAuthLedger();
  const memberships = ledger.memberships.filter((membership) => membership.tenantId === tenantId);
  const userIds = new Set(memberships.map((membership) => membership.userId));
  const users = ledger.users.filter((user) => userIds.has(user.id));
  const sessions = ledger.sessions.filter(
    (session) => session.tenantId === tenantId && new Date(session.expiresAt).getTime() > Date.now(),
  );
  const tenants = ledger.tenants.filter((tenant) => tenant.id === tenantId);
  return {
    authEnabled: isAuthEnforced(),
    bootstrapConfigured: isBootstrapConfigured(),
    stats: {
      tenants: tenants.length,
      users: users.length,
      activeUsers: users.filter((user) => user.status === "active").length,
      sessions: sessions.length,
    },
    tenants,
    users: users.map(stripPassword),
    memberships,
    sessions: sessions.map(stripTokenHash),
  };
}

async function createSession({
  userId,
  tenantId,
  token,
  expiresAt,
}: {
  userId: string;
  tenantId: string;
  token: string;
  expiresAt: string;
}): Promise<AuthSessionRecord> {
  const now = new Date().toISOString();
  const session: AuthSessionRecord & { tokenHash: string } = {
    id: randomUUID(),
    userId,
    tenantId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    createdAt: now,
    lastSeenAt: now,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_auth_sessions (id, user_id, tenant_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (${session.id}, ${userId}, ${tenantId}, ${session.tokenHash}, ${expiresAt}, ${now}, ${now})
    `;
    return stripTokenHash(session);
  }

  await mutateAuthLedger((ledger) => ({
    ...ledger,
    sessions: [session, ...ledger.sessions.filter((item) => new Date(item.expiresAt).getTime() > Date.now())].slice(0, 200),
  }));
  return stripTokenHash(session);
}

async function findUserByEmail(email: string): Promise<AuthUserWithPassword | null> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_auth_users WHERE email = ${normalizeEmail(email)} LIMIT 1`;
    return rows[0] ? userWithPasswordFromRow(rows[0]) : null;
  }

  const ledger = await readAuthLedger();
  return ledger.users.find((user) => user.email === normalizeEmail(email)) || null;
}

async function findPrimaryMembership(userId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_auth_memberships
      WHERE user_id = ${userId} AND status = 'active'
      ORDER BY created_at ASC
      LIMIT 1
    `;
    return rows[0] ? membershipFromRow(rows[0]) : null;
  }

  const ledger = await readAuthLedger();
  return ledger.memberships.find((membership) => membership.userId === userId && membership.status === "active") || null;
}

async function findTenant(tenantId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_auth_tenants WHERE id = ${tenantId} LIMIT 1`;
    return rows[0] ? tenantFromRow(rows[0]) : null;
  }

  const ledger = await readAuthLedger();
  return ledger.tenants.find((tenant) => tenant.id === tenantId) || null;
}

async function ensureBootstrapMembership({
  tenantId,
  tenantName,
  userId,
  role,
}: {
  tenantId: string;
  tenantName: string;
  userId: string;
  role: SecurityRole;
}) {
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_auth_tenants (id, name, slug, created_at, updated_at)
      VALUES (${tenantId}, ${tenantName}, ${tenantId}, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `;
    await getSql()`
      INSERT INTO omni_auth_memberships (id, tenant_id, user_id, role, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${tenantId}, ${userId}, ${role}, 'active', ${now}, ${now})
      ON CONFLICT (tenant_id, user_id) DO UPDATE
      SET role = EXCLUDED.role, status = 'active', updated_at = EXCLUDED.updated_at
    `;
    return;
  }

  await mutateAuthLedger((ledger) => ({
    ...ledger,
    tenants: upsertTenant(ledger.tenants, {
      id: tenantId,
      name: tenantName,
      slug: tenantId,
      createdAt: now,
      updatedAt: now,
    }),
    memberships: upsertMembership(ledger.memberships, {
      id: randomUUID(),
      tenantId,
      userId,
      role,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
  }));
}

async function markLastLogin(userId: string) {
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await getSql()`UPDATE omni_auth_users SET last_login_at = ${now}, updated_at = ${now} WHERE id = ${userId}`;
    return;
  }

  await mutateAuthLedger((ledger) => ({
    ...ledger,
    users: ledger.users.map((user) =>
      user.id === userId ? { ...user, lastLoginAt: now, updatedAt: now } : user,
    ),
  }));
}

function identityFromRecords({
  session,
  user,
  tenant,
  membership,
}: {
  session: AuthSessionRecord;
  user: AuthUser;
  tenant: AuthTenant;
  membership: AuthMembership;
}): AuthSessionIdentity {
  return {
    session,
    user: stripPassword(user as AuthUserWithPassword),
    tenant,
    membership,
    context: {
      tenantId: tenant.id,
      actorId: user.email,
      role: membership.role,
      source: "session",
      auth: {
        userId: user.id,
        email: user.email,
        sessionId: session.id,
        tenantName: tenant.name,
      },
    },
  };
}

function identityFromJoinedRow(row: Record<string, unknown>): AuthSessionIdentity {
  return identityFromRecords({
    session: {
      id: String(row.session_id),
      userId: String(row.user_id),
      tenantId: String(row.tenant_id),
      expiresAt: normalizeDate(row.expires_at),
      createdAt: normalizeDate(row.session_created_at),
      lastSeenAt: normalizeDate(row.last_seen_at),
    },
    user: {
      id: String(row.user_id),
      email: String(row.email),
      name: row.name ? String(row.name) : undefined,
      status: String(row.user_status) as AuthUser["status"],
      lastLoginAt: row.last_login_at ? normalizeDate(row.last_login_at) : undefined,
      createdAt: normalizeDate(row.user_created_at),
      updatedAt: normalizeDate(row.user_updated_at),
    },
    tenant: {
      id: String(row.tenant_id),
      name: String(row.tenant_name),
      slug: String(row.tenant_slug),
      createdAt: normalizeDate(row.tenant_created_at),
      updatedAt: normalizeDate(row.tenant_updated_at),
    },
    membership: {
      id: String(row.membership_id),
      tenantId: String(row.tenant_id),
      userId: String(row.user_id),
      role: String(row.role) as SecurityRole,
      status: String(row.membership_status) as AuthMembership["status"],
      createdAt: normalizeDate(row.membership_created_at),
      updatedAt: normalizeDate(row.membership_updated_at),
    },
  });
}

function tenantFromRow(row: Record<string, unknown>): AuthTenant {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function userFromRow(row: Record<string, unknown>): AuthUser {
  return stripPassword(userWithPasswordFromRow(row));
}

function userWithPasswordFromRow(row: Record<string, unknown>): AuthUserWithPassword {
  return {
    id: String(row.id),
    email: String(row.email),
    name: row.name ? String(row.name) : undefined,
    passwordHash: String(row.password_hash),
    status: String(row.status) as AuthUser["status"],
    lastLoginAt: row.last_login_at ? normalizeDate(row.last_login_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function membershipFromRow(row: Record<string, unknown>): AuthMembership {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    role: String(row.role) as SecurityRole,
    status: String(row.status) as AuthMembership["status"],
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function sessionFromRow(row: Record<string, unknown>): AuthSessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    expiresAt: normalizeDate(row.expires_at),
    createdAt: normalizeDate(row.created_at),
    lastSeenAt: normalizeDate(row.last_seen_at),
  };
}

function stripPassword(user: AuthUserWithPassword): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function stripTokenHash(session: AuthSessionRecord & { tokenHash: string }): AuthSessionRecord {
  return {
    id: session.id,
    userId: session.userId,
    tenantId: session.tenantId,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
  };
}

function upsertTenant(tenants: AuthTenant[], tenant: AuthTenant) {
  return tenants.some((item) => item.id === tenant.id)
    ? tenants.map((item) => (item.id === tenant.id ? { ...item, ...tenant, createdAt: item.createdAt } : item))
    : [tenant, ...tenants];
}

function upsertMembership(memberships: AuthMembership[], membership: AuthMembership) {
  return memberships.some((item) => item.tenantId === membership.tenantId && item.userId === membership.userId)
    ? memberships.map((item) =>
        item.tenantId === membership.tenantId && item.userId === membership.userId
          ? { ...item, role: membership.role, status: "active" as const, updatedAt: membership.updatedAt }
          : item,
      )
    : [membership, ...memberships];
}

async function readAuthLedger() {
  return readJsonFile<AuthLedger>(getAuthFile(), {
    tenants: [],
    users: [],
    memberships: [],
    sessions: [],
  });
}

async function mutateAuthLedger(mutator: (ledger: AuthLedger) => AuthLedger) {
  await updateJsonFile<AuthLedger>(
    getAuthFile(),
    { tenants: [], users: [], memberships: [], sessions: [] },
    mutator,
  );
}

function getAuthFile() {
  return getDataPath("auth.json");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeTenantId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function getSessionTtlDays() {
  const configured = Number(process.env.OMNIAGENT_SESSION_DAYS || 7);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 30) : 7;
}
