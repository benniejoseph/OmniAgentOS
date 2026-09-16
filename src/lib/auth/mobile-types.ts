import type { AuthMembership, AuthTenant, AuthUser } from "@/lib/auth/types";
import type { SecurityContext } from "@/lib/security/types";

export type MobileDevice = {
  id: string;
  name: string;
  platform: "android" | "ios" | "macos";
  appVersion?: string;
  buildNumber?: number;
  clientContractVersion?: number;
};

export type MobileRevocationReason =
  | "logout"
  | "refresh_reuse"
  | "password_changed"
  | "membership_changed"
  | "user_revoked"
  | "remote_wipe"
  | "replaced"
  | "legacy_revoked";

export type MobileSessionRecord = {
  id: string;
  familyId: string;
  userId: string;
  tenantId: string;
  device: MobileDevice;
  accessTokenHash: string;
  refreshTokenHash: string;
  consumedRefreshTokenHashes: string[];
  accessExpiresAt: string;
  refreshExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  clientAttestedAt?: string;
  revokedAt?: string;
  revocationReason?: MobileRevocationReason;
  wipeRequestedAt?: string;
  wipeAcknowledgedAt?: string;
  wipeChallengeHash?: string;
  wipeChallengeExpiresAt?: string;
  replacedBySessionId?: string;
};

export type MobileIdentity = {
  session: MobileSessionRecord;
  user: AuthUser;
  tenant: AuthTenant;
  membership: AuthMembership;
  context: SecurityContext;
};

export type MobileTokenPair = {
  tokenType: "Bearer";
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export type MobileAuthLedger = {
  sessions: MobileSessionRecord[];
};
