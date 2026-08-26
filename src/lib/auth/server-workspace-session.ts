import { cache } from "react";
import { headers } from "next/headers";
import { resolveWorkspaceSession } from "@/lib/auth/workspace-session";

/** Request-scoped through React cache, so the app layout and page share one lookup. */
export const getServerWorkspaceSession = cache(async () => {
  const requestHeaders = await headers();
  return resolveWorkspaceSession(new Request("http://asael.local/app", {
    headers: requestHeaders,
  }));
});
