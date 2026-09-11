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
 * persisted. Workspace scopes intentionally match the capabilities Asael
 * exposes instead of relying on narrower historical read-only grants.
 */
export const GOOGLE_WORKSPACE_OAUTH_SCOPES = Object.freeze([
  GOOGLE_OPENID_SCOPE,
  GOOGLE_EMAIL_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_LIST_READ_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
] as const);

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
