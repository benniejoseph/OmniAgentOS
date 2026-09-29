import { describe, expect, it } from "vitest";
import {
  GOOGLE_CALENDAR_EVENTS_READ_SCOPE,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_LIST_READ_SCOPE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
  GOOGLE_WORKSPACE_CAPABILITY_IDS,
  GOOGLE_WORKSPACE_OAUTH_SCOPES,
  GOOGLE_WORKSPACE_WRITE_ACCESS,
  googleSyncSourcesForScopes,
  googleWorkspaceAuthorizationScopes,
  googleWorkspaceCapabilitiesForScopes,
  googleWorkspaceWriteAccessFor,
  googleWorkspaceWriteAccessName,
  hasGoogleWorkspaceCapability,
  isGoogleWorkspaceWriteAccess,
} from "@/lib/connectors/google-workspace-capabilities";

describe("Google Workspace capability registry", () => {
  it("asks a new connection for the owner's identity and read access only", () => {
    expect(GOOGLE_WORKSPACE_OAUTH_SCOPES).toEqual([
      "openid",
      "email",
      GOOGLE_GMAIL_READ_SCOPE,
      GOOGLE_CALENDAR_EVENTS_READ_SCOPE,
      GOOGLE_CALENDAR_LIST_READ_SCOPE,
      GOOGLE_DRIVE_READ_SCOPE,
      GOOGLE_PHOTOS_PICKER_SCOPE,
    ]);
    expect(googleWorkspaceAuthorizationScopes()).toEqual(GOOGLE_WORKSPACE_OAUTH_SCOPES);
    expect([...googleWorkspaceCapabilitiesForScopes(GOOGLE_WORKSPACE_OAUTH_SCOPES)]
      .filter((capability) => googleWorkspaceWriteAccessFor(capability)))
      .toEqual([]);
  });

  it("allows one service's changes with only the identity and its write scope", () => {
    expect(GOOGLE_WORKSPACE_WRITE_ACCESS).toEqual(["gmail", "calendar", "drive"]);
    expect(googleWorkspaceAuthorizationScopes("gmail"))
      .toEqual(["openid", "email", GOOGLE_GMAIL_MODIFY_SCOPE]);
    expect(googleWorkspaceAuthorizationScopes("calendar"))
      .toEqual(["openid", "email", GOOGLE_CALENDAR_EVENTS_SCOPE]);
    expect(googleWorkspaceAuthorizationScopes("drive"))
      .toEqual(["openid", "email", GOOGLE_DRIVE_SCOPE]);
    expect(Object.fromEntries(GOOGLE_WORKSPACE_CAPABILITY_IDS
      .map((capability) => [capability, googleWorkspaceWriteAccessFor(capability)])
      .filter(([, access]) => access !== undefined)))
      .toEqual({
        "gmail.send": "gmail",
        "gmail.modify": "gmail",
        "gmail.trash": "gmail",
        "calendar.events.write": "calendar",
        "drive.write": "drive",
        "docs.write": "drive",
        "sheets.write": "drive",
        "slides.write": "drive",
      });
    for (const access of GOOGLE_WORKSPACE_WRITE_ACCESS) {
      const granted = googleWorkspaceCapabilitiesForScopes(
        googleWorkspaceAuthorizationScopes(access),
      );
      for (const capability of GOOGLE_WORKSPACE_CAPABILITY_IDS) {
        if (googleWorkspaceWriteAccessFor(capability) === access) {
          expect(granted.has(capability), capability).toBe(true);
        }
      }
    }
    expect(GOOGLE_WORKSPACE_WRITE_ACCESS.map(googleWorkspaceWriteAccessName))
      .toEqual(["Gmail", "Google Calendar", "Google Drive"]);
    for (const value of GOOGLE_WORKSPACE_WRITE_ACCESS) {
      expect(isGoogleWorkspaceWriteAccess(value)).toBe(true);
    }
    for (const value of ["photos", "Gmail", "", "toString", null, undefined, ["gmail"]]) {
      expect(isGoogleWorkspaceWriteAccess(value), String(value)).toBe(false);
    }
  });

  it("expands broader scopes without overstating drive.file", () => {
    const capabilities = googleWorkspaceCapabilitiesForScopes([
      GOOGLE_GMAIL_MODIFY_SCOPE,
      GOOGLE_DRIVE_SCOPE,
    ]);
    expect(capabilities).toEqual(new Set([
      "gmail.read",
      "gmail.send",
      "gmail.modify",
      "gmail.trash",
      "drive.read",
      "docs.read",
      "sheets.read",
      "slides.read",
      "drive.write",
      "docs.write",
      "sheets.write",
      "slides.write",
    ]));
    expect(hasGoogleWorkspaceCapability(
      [GOOGLE_DRIVE_FILE_SCOPE],
      "drive.write",
    )).toBe(false);
  });

  it("derives only synchronization sources supported by the grant", () => {
    expect(googleSyncSourcesForScopes([
      GOOGLE_GMAIL_READ_SCOPE,
      GOOGLE_GMAIL_SEND_SCOPE,
      GOOGLE_DRIVE_READ_SCOPE,
    ])).toEqual(["mail", "drive"]);
    expect(googleSyncSourcesForScopes([GOOGLE_PHOTOS_PICKER_SCOPE])).toEqual([]);
  });
});
