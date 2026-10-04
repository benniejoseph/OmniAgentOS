import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_NAV_COLLAPSED_COOKIE,
  desktopNavCollapsedCookie,
  desktopNavCollapsedFromCookie,
  moveStoredDesktopNavPreference,
} from "@/components/app-shell/desktop-nav-preference";

describe("the desktop navigation preference", () => {
  it("reads only a value the cookie was written with", () => {
    expect(desktopNavCollapsedFromCookie("true")).toBe(true);
    expect(desktopNavCollapsedFromCookie("false")).toBe(false);
    for (const value of [undefined, "", "TRUE", "1", "yes"]) {
      expect(desktopNavCollapsedFromCookie(value)).toBeUndefined();
    }
  });

  it("is remembered for a year, for the workspace pages only", () => {
    expect(DESKTOP_NAV_COLLAPSED_COOKIE).toBe("omni-desktop-nav-collapsed");
    expect(desktopNavCollapsedCookie(true, true)).toBe(
      "omni-desktop-nav-collapsed=true; Path=/app; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(desktopNavCollapsedCookie(false, false)).toBe(
      "omni-desktop-nav-collapsed=false; Path=/app; Max-Age=31536000; SameSite=Lax",
    );
  });

  it("moves a choice from the browser's storage into the cookie once", () => {
    for (const [stored, collapsed] of [["true", true], ["false", false], [null, true]] as const) {
      const values = new Map<string, string>(
        stored === null ? [] : [[DESKTOP_NAV_COLLAPSED_COOKIE, stored]],
      );
      const storage = {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        removeItem: vi.fn((key: string) => void values.delete(key)),
      };
      const remember = vi.fn();

      expect(moveStoredDesktopNavPreference(storage, remember)).toBe(collapsed);
      expect(remember.mock.calls).toEqual([[collapsed]]);
      expect(storage.removeItem).toHaveBeenCalledWith(DESKTOP_NAV_COLLAPSED_COOKIE);
      expect(values.size).toBe(0);
    }
  });
});
