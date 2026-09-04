export const NATIVE_CLIENT_POLICY_SCHEMA_VERSION = 1 as const;
export const NATIVE_CLIENT_CONTRACT_VERSION = 1 as const;
export const NATIVE_CLIENT_ADOPTION_SCHEMA_VERSION = 1 as const;
export const NATIVE_CLIENT_ADOPTION_WINDOW_DAYS = 30 as const;
export const NATIVE_CLIENT_ADOPTION_MAX_SESSION_FAMILIES = 10_000 as const;

export type NativePlatform = "android" | "ios";
export type NativeClientCompatibilityStatus =
  | "compatible"
  | "upgrade_required"
  | "unknown";

export type NativeClientAttestation = Readonly<{
  platform: NativePlatform;
  appVersion: string;
  buildNumber: number;
  clientContractVersion: number;
}>;

export type NativeClientDescriptor = Readonly<{
  platform: NativePlatform;
  appVersion?: string;
  buildNumber?: number;
  clientContractVersion?: number;
}>;

const DEFAULT_MINIMUM_NATIVE_VERSION = "1.0.0";
const MAX_VERSION_COMPONENT = 999_999_999;
const MAX_POSITIVE_INTEGER = 2_147_483_647;
const stableVersionPattern =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export function isStableNativeVersion(value: string) {
  if (value !== value.trim()) return false;
  const match = stableVersionPattern.exec(value);
  if (!match) return false;
  return match.slice(1).every((component) => {
    const numeric = Number(component);
    return Number.isSafeInteger(numeric) && numeric <= MAX_VERSION_COMPONENT;
  });
}

export function isNativeClientAttestation(
  value: NativeClientDescriptor,
): value is NativeClientAttestation {
  return (
    isStableNativeVersion(value.appVersion || "") &&
    Number.isInteger(value.buildNumber) &&
    Number(value.buildNumber) >= 1 &&
    Number(value.buildNumber) <= MAX_POSITIVE_INTEGER &&
    Number.isInteger(value.clientContractVersion) &&
    Number(value.clientContractVersion) >= 1 &&
    Number(value.clientContractVersion) <= MAX_POSITIVE_INTEGER
  );
}

export function minimumNativeVersion(platform: NativePlatform) {
  const configured = process.env[
    platform === "android"
      ? "OMNIAGENT_NATIVE_MIN_ANDROID_VERSION"
      : "OMNIAGENT_NATIVE_MIN_IOS_VERSION"
  ];
  if (configured === undefined || configured === "") {
    return DEFAULT_MINIMUM_NATIVE_VERSION;
  }
  return isStableNativeVersion(configured) ? configured : undefined;
}

export function evaluateNativeClientCompatibility(
  client: NativeClientDescriptor,
): NativeClientCompatibilityStatus {
  if (!isNativeClientAttestation(client)) return "unknown";
  const minimumVersion = minimumNativeVersion(client.platform);
  if (!minimumVersion) return "unknown";
  if (client.clientContractVersion < NATIVE_CLIENT_CONTRACT_VERSION) {
    return "upgrade_required";
  }
  if (client.clientContractVersion > NATIVE_CLIENT_CONTRACT_VERSION) {
    return "unknown";
  }
  return compareStableNativeVersions(
    client.appVersion,
    minimumVersion,
  ) >= 0
    ? "compatible"
    : "upgrade_required";
}

export function nativeClientPolicy() {
  const android = minimumNativeVersion("android");
  const ios = minimumNativeVersion("ios");
  return Object.freeze({
    schemaVersion: NATIVE_CLIENT_POLICY_SCHEMA_VERSION,
    currentContractVersion: NATIVE_CLIENT_CONTRACT_VERSION,
    minimumVersions: Object.freeze({
      android: android || null,
      ios: ios || null,
    }),
    configurationStatus:
      android && ios ? "valid" as const : "invalid" as const,
    adoptionWindowDays: NATIVE_CLIENT_ADOPTION_WINDOW_DAYS,
    agentCatalogEnrollment: Object.freeze({
      state: "held" as const,
      minimumContractVersion: NATIVE_CLIENT_CONTRACT_VERSION,
    }),
  });
}

export function nativeClientCompatibility(
  client: NativeClientDescriptor,
  options: { clientAttestedAt?: string; asOf?: Date } = {},
) {
  const descriptorStatus = evaluateNativeClientCompatibility(client);
  const status = isFreshNativeClientAttestation(
    options.clientAttestedAt,
    options.asOf,
  )
    ? descriptorStatus
    : "unknown";
  return Object.freeze({
    schemaVersion: NATIVE_CLIENT_POLICY_SCHEMA_VERSION,
    platform: client.platform,
    appVersion: client.appVersion || null,
    buildNumber: client.buildNumber || null,
    clientContractVersion: client.clientContractVersion || 0,
    minimumVersion: minimumNativeVersion(client.platform) || null,
    requiredContractVersion: NATIVE_CLIENT_CONTRACT_VERSION,
    status,
    agentCatalogEnrollment: Object.freeze({
      state: "held" as const,
      clientReady: status === "compatible",
    }),
  });
}

export function isFreshNativeClientAttestation(
  clientAttestedAt?: string,
  asOf = new Date(),
) {
  if (!clientAttestedAt) return false;
  const observedAt = new Date(clientAttestedAt).getTime();
  const now = asOf.getTime();
  if (!Number.isFinite(observedAt) || !Number.isFinite(now)) return false;
  const cutoff = now -
    NATIVE_CLIENT_ADOPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const maximumClockSkew = 5 * 60 * 1000;
  return observedAt >= cutoff && observedAt <= now + maximumClockSkew;
}

function compareStableNativeVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}
