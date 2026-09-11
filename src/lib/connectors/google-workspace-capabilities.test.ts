import { describe, expect, it } from "vitest";
import {
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_LIST_READ_SCOPE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  GOOGLE_PHOTOS_PICKER_SCOPE,
  GOOGLE_WORKSPACE_OAUTH_SCOPES,
  googleSyncSourcesForScopes,
  googleWorkspaceCapabilitiesForScopes,
  hasGoogleWorkspaceCapability,
} from "@/lib/connectors/google-workspace-capabilities";

describe("Google Workspace capability registry", () => {
  it("requests the private-owner identity and complete supported bundles", () => {
    expect(GOOGLE_WORKSPACE_OAUTH_SCOPES).toEqual(expect.arrayContaining([
      "openid",
      "email",
      GOOGLE_GMAIL_MODIFY_SCOPE,
      GOOGLE_CALENDAR_EVENTS_SCOPE,
      GOOGLE_CALENDAR_LIST_READ_SCOPE,
      GOOGLE_DRIVE_SCOPE,
      GOOGLE_PHOTOS_PICKER_SCOPE,
    ]));
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
