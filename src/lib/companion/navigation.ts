import { parseCompanionResponse } from "@/components/companion-preferences-state";
import { explicitCompanionReturn } from "./return-path";
export { safeCompanionReturn, explicitCompanionReturn } from "./return-path";

export function companionEntryDestination(search: string, response: unknown) {
  return explicitCompanionReturn(search) ?? parseCompanionResponse(response)?.destination.href ?? "/app";
}

/** Read-only, bounded entry resolution; unavailable settings retain ordinary
 * Today entry. Explicit safe links bypass the preference read entirely. */
export async function readCompanionEntryDestination(search: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const explicit = explicitCompanionReturn(search);
  if (explicit) return explicit;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 3_000);
  try {
    const response = await fetcher("/api/companion/preferences", { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok || controller.signal.aborted) return "/app";
    const body: unknown = await response.json();
    return controller.signal.aborted ? "/app" : companionEntryDestination(search, body);
  } catch { return "/app"; }
  finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
}
