export const GOOGLE_OPENID_SCOPE = "openid";
export const GOOGLE_EMAIL_SCOPE = "email";
export const GOOGLE_GMAIL_READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_GMAIL_SEND_SCOPE =
  "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_GMAIL_MODIFY_SCOPE =
  "https://www.googleapis.com/auth/gmail.modify";
export const GOOGLE_GMAIL_FULL_SCOPE = "https://mail.google.com/";
export const GOOGLE_CALENDAR_EVENTS_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_CALENDAR_LIST_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const GOOGLE_DRIVE_READ_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
export const GOOGLE_DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const GOOGLE_PHOTOS_PICKER_SCOPE =
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";

/**
 * The scopes requested for a new private-owner Google connection. Identity
 * scopes let the callback prove the account before any provider credential is
 * persisted. The Workspace scopes only read: a service's write scope is asked
 * for later, once the owner allows changes to that service.
 */
export const GOOGLE_WORKSPACE_OAUTH_SCOPES = Object.freeze([
  GOOGLE_OPENID_SCOPE,
  GOOGLE_EMAIL_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
  GOOGLE_CALENDAR_EVENTS_READ_SCOPE,
  GOOGLE_CALENDAR_LIST_READ_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
] as const);

export const GOOGLE_WORKSPACE_WRITE_ACCESS = Object.freeze([
  "gmail",
  "calendar",
  "drive",
] as const);

export type GoogleWorkspaceWriteAccess =
  (typeof GOOGLE_WORKSPACE_WRITE_ACCESS)[number];

const writeAccessScopes: Readonly<Record<GoogleWorkspaceWriteAccess, string>> =
  Object.freeze({
    gmail: GOOGLE_GMAIL_MODIFY_SCOPE,
    calendar: GOOGLE_CALENDAR_EVENTS_SCOPE,
    drive: GOOGLE_DRIVE_SCOPE,
  });

const writeAccessNames: Readonly<Record<GoogleWorkspaceWriteAccess, string>> =
  Object.freeze({
    gmail: "Gmail",
    calendar: "Google Calendar",
    drive: "Google Drive",
  });

export function isGoogleWorkspaceWriteAccess(
  value: unknown,
): value is GoogleWorkspaceWriteAccess {
  return (GOOGLE_WORKSPACE_WRITE_ACCESS as readonly unknown[]).includes(value);
}

/**
 * The scopes one Google authorization asks for. Allowing changes to a service
 * asks only for the identity and that service's write scope; Google adds them
 * to what the account already granted (include_granted_scopes).
 */
export function googleWorkspaceAuthorizationScopes(
  writeAccess?: GoogleWorkspaceWriteAccess,
): readonly string[] {
  return writeAccess
    ? [GOOGLE_OPENID_SCOPE, GOOGLE_EMAIL_SCOPE, writeAccessScopes[writeAccess]]
    : GOOGLE_WORKSPACE_OAUTH_SCOPES;
}

/**
 * The service whose write access grants a capability that a new connection
 * does not have, or undefined when a reconnect is what would grant it.
 */
export function googleWorkspaceWriteAccessFor(
  capability: GoogleWorkspaceCapability,
): GoogleWorkspaceWriteAccess | undefined {
  if (hasGoogleWorkspaceCapability(GOOGLE_WORKSPACE_OAUTH_SCOPES, capability)) {
    return undefined;
  }
  return GOOGLE_WORKSPACE_WRITE_ACCESS.find((access) =>
    hasGoogleWorkspaceCapability([writeAccessScopes[access]], capability)
  );
}

export function googleWorkspaceWriteAccessName(
  access: GoogleWorkspaceWriteAccess,
) {
  return writeAccessNames[access];
}

export const GOOGLE_WORKSPACE_CAPABILITY_IDS = Object.freeze([
  "identity.email",
  "gmail.read",
  "gmail.send",
  "gmail.modify",
  "gmail.trash",
  "calendar.events.read",
  "calendar.events.write",
  "calendar.list.read",
  "drive.read",
  "drive.write",
  "docs.read",
  "docs.write",
  "sheets.read",
  "sheets.write",
  "slides.read",
  "slides.write",
  "photos.pick",
] as const);

export type GoogleWorkspaceCapability =
  (typeof GOOGLE_WORKSPACE_CAPABILITY_IDS)[number];
export type GoogleWorkspaceSyncSource = "mail" | "calendar" | "drive";

const gmailReadCapabilities = ["gmail.read"] as const;
const gmailModifyCapabilities = [
  "gmail.read",
  "gmail.send",
  "gmail.modify",
  "gmail.trash",
] as const;
const driveReadCapabilities = [
  "drive.read",
  "docs.read",
  "sheets.read",
  "slides.read",
] as const;
const driveWriteCapabilities = [
  ...driveReadCapabilities,
  "drive.write",
  "docs.write",
  "sheets.write",
  "slides.write",
] as const;

const scopeCapabilities: Readonly<
  Record<string, readonly GoogleWorkspaceCapability[]>
> = Object.freeze({
  [GOOGLE_EMAIL_SCOPE]: ["identity.email"],
  [GOOGLE_GMAIL_READ_SCOPE]: gmailReadCapabilities,
  [GOOGLE_GMAIL_SEND_SCOPE]: ["gmail.send"],
  [GOOGLE_GMAIL_MODIFY_SCOPE]: gmailModifyCapabilities,
  [GOOGLE_GMAIL_FULL_SCOPE]: gmailModifyCapabilities,
  [GOOGLE_CALENDAR_EVENTS_READ_SCOPE]: ["calendar.events.read"],
  [GOOGLE_CALENDAR_EVENTS_SCOPE]: [
    "calendar.events.read",
    "calendar.events.write",
  ],
  [GOOGLE_CALENDAR_LIST_READ_SCOPE]: ["calendar.list.read"],
  [GOOGLE_DRIVE_READ_SCOPE]: driveReadCapabilities,
  // drive.file is deliberately not promoted to broad Drive read/write. It
  // authorizes only files the app created or the user explicitly opened.
  [GOOGLE_DRIVE_FILE_SCOPE]: [],
  [GOOGLE_DRIVE_SCOPE]: driveWriteCapabilities,
  [GOOGLE_PHOTOS_PICKER_SCOPE]: ["photos.pick"],
});

export function googleWorkspaceCapabilitiesForScopes(
  scopes: readonly string[],
): ReadonlySet<GoogleWorkspaceCapability> {
  const capabilities = new Set<GoogleWorkspaceCapability>();
  for (const scope of scopes) {
    for (const capability of scopeCapabilities[scope] || []) {
      capabilities.add(capability);
    }
  }
  return capabilities;
}

export function hasGoogleWorkspaceCapability(
  scopes: readonly string[],
  capability: GoogleWorkspaceCapability,
) {
  return googleWorkspaceCapabilitiesForScopes(scopes).has(capability);
}

export function googleSyncSourcesForScopes(
  scopes: readonly string[],
): readonly GoogleWorkspaceSyncSource[] {
  const capabilities = googleWorkspaceCapabilitiesForScopes(scopes);
  return ([
    ["mail", "gmail.read"],
    ["calendar", "calendar.events.read"],
    ["drive", "drive.read"],
  ] as const)
    .filter(([, capability]) => capabilities.has(capability))
    .map(([source]) => source);
}
