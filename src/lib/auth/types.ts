import type { SecurityContext, SecurityRole } from "@/lib/security/types";

export type AuthUserStatus = "active" | "disabled";
export type AuthMembershipStatus = "active" | "disabled";

export type AuthTenant = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
};

export type AuthUser = {
  id: string;
  email: string;
  name?: string;
  status: AuthUserStatus;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AuthUserWithPassword = AuthUser & {
  passwordHash: string;
};

export type AuthMembership = {
  id: string;
  tenantId: string;
  userId: string;
  role: SecurityRole;
  status: AuthMembershipStatus;
  createdAt: string;
  updatedAt: string;
};

export type AuthSessionRecord = {
  id: string;
  userId: string;
  tenantId: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
};

export type AuthSessionIdentity = {
  session: AuthSessionRecord;
  user: AuthUser;
  tenant: AuthTenant;
  membership: AuthMembership;
  context: SecurityContext;
};

export type AuthControlPlane = {
  authEnabled: boolean;
  bootstrapConfigured: boolean;
  stats: {
    tenants: number;
    users: number;
    activeUsers: number;
    sessions: number;
  };
  tenants: AuthTenant[];
  users: AuthUser[];
  memberships: AuthMembership[];
  sessions: AuthSessionRecord[];
};

export type AuthLedger = {
  tenants: AuthTenant[];
  users: AuthUserWithPassword[];
  memberships: AuthMembership[];
  sessions: (AuthSessionRecord & { tokenHash: string })[];
};
