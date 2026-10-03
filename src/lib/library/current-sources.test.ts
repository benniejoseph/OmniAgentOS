import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CALENDAR_EVENTS_READ_SCOPE,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_LIST_READ_SCOPE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READ_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_GMAIL_FULL_SCOPE,
  GOOGLE_GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_READ_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
} from "@/lib/connectors/google-workspace-capabilities";
import {
  libraryGoogleReadScopes,
  withCurrentLibrarySources,
} from "@/lib/library/current-sources";

describe("Library current-source read capabilities", () => {
  it("uses broad source read capabilities, including write scopes that imply read", () => {
    expect(libraryGoogleReadScopes("drive")).toEqual(expect.arrayContaining([
      GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_SCOPE,
    ]));
    expect(libraryGoogleReadScopes("mail")).toEqual(expect.arrayContaining([
      GOOGLE_GMAIL_READ_SCOPE, GOOGLE_GMAIL_MODIFY_SCOPE, GOOGLE_GMAIL_FULL_SCOPE,
    ]));
    expect(libraryGoogleReadScopes("calendar")).toEqual(expect.arrayContaining([
      GOOGLE_CALENDAR_EVENTS_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE,
    ]));
  });

  it("does not turn selective-file, send-only or calendar-list access into source read", () => {
    expect(libraryGoogleReadScopes("drive")).not.toContain(GOOGLE_DRIVE_FILE_SCOPE);
    expect(libraryGoogleReadScopes("mail")).not.toContain(GOOGLE_GMAIL_SEND_SCOPE);
    expect(libraryGoogleReadScopes("calendar")).not.toContain(GOOGLE_CALENDAR_LIST_READ_SCOPE);
  });

  it.each(["SELECT", "WITH"])("keeps scope and query values bound when composing %s reads", async (kind) => {
    const sql = vi.fn(async () => []);
    const tenantId = "tenant-'-$1";
    const sourceId = "source-'-$2";
    const current = withCurrentLibrarySources(sql, {
      tenantId, canonicalActorId: "actor:canonical", exactActorId: "current@example.test",
    });
    if (kind === "SELECT") await current`SELECT id FROM library_current_sources WHERE id = ${sourceId}`;
    else await current`WITH selected AS (SELECT id FROM library_current_sources WHERE id = ${sourceId}) SELECT * FROM selected`;
    const [strings, ...values] = sql.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.raw).toEqual([...strings]);
    expect(strings.length).toBe(values.length + 1);
    expect(values.slice(0, 4)).toEqual([tenantId, "actor:canonical", "current@example.test", true]);
    expect(values.at(-1)).toBe(sourceId);
    expect(strings.join("?")).not.toContain(tenantId);
    expect(strings.join("?")).not.toContain(sourceId);
    expect(strings.join("?").match(/\bWITH\b/g)).toHaveLength(1);
  });
});
