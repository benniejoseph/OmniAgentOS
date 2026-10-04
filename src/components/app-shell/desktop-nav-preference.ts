/**
 * Whether the desktop navigation is collapsed, kept in a cookie so the
 * server renders the shell at its width and the page does not move once it
 * loads. Before, it lived only in the browser's storage, under this name.
 */
export const DESKTOP_NAV_COLLAPSED_COOKIE = "omni-desktop-nav-collapsed";

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** What a request's cookie says, or undefined if it says nothing. */
export function desktopNavCollapsedFromCookie(value: string | undefined) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** The cookie that remembers the choice, for document.cookie. */
export function desktopNavCollapsedCookie(collapsed: boolean, secure: boolean) {
  return `${DESKTOP_NAV_COLLAPSED_COOKIE}=${collapsed}; Path=/app; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Moves a choice still in the browser's storage into the cookie, once, and
 * returns it.
 */
export function moveStoredDesktopNavPreference(
  storage: Pick<Storage, "getItem" | "removeItem">,
  remember: (collapsed: boolean) => void,
) {
  // New workspaces begin with the compact rail. An explicit expanded choice,
  // including the older local-storage preference, continues to win.
  const collapsed = storage.getItem(DESKTOP_NAV_COLLAPSED_COOKIE) !== "false";
  storage.removeItem(DESKTOP_NAV_COLLAPSED_COOKIE);
  remember(collapsed);
  return collapsed;
}
