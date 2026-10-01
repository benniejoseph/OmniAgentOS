import {
  browserRefreshEnvironment,
  startVisibleRefresh,
  type VisibleRefreshEnvironment,
} from "@/lib/client/visible-refresh";

/** How often an open project is read again while its execution runs. */
export const PROJECT_EXECUTION_REFRESH_MS = 12_000;

/** An execution the worker is still advancing. */
export function projectExecutionIsLive(status: string | undefined) {
  return status === "running" || status === "waiting_approval";
}

// The writes the projects page has started and finished so far.
let projectWrites = 0;

/**
 * Runs one of the projects page's writes, counted as it starts and as it
 * finishes, so a refresh read meanwhile is dropped.
 */
export async function runProjectWrite<T>(write: () => Promise<T>) {
  projectWrites += 1;
  try {
    return await write();
  } finally {
    projectWrites += 1;
  }
}

/** One project as the server holds it now, or nothing if it cannot be read. */
export async function readProjectSnapshot(
  projectId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { project?: unknown }
    | null
    | undefined;
  return payload?.project ?? undefined;
}

/**
 * Reads an open project again on each poll while its execution runs and the
 * page is visible, and as soon as the page is shown again. Reading changes
 * nothing: the worker tick dispatches the work, and Sync stays an explicit
 * action. A read that one of the page's writes started or finished during is
 * dropped, so it cannot put back what the write replaced, and a failed read
 * keeps the view until the next one.
 */
export function startProjectExecutionRefresh({
  projectId,
  onProject,
  readProject = readProjectSnapshot,
  environment = browserRefreshEnvironment,
}: {
  projectId: string;
  onProject: (project: unknown) => void;
  readProject?: (projectId: string, signal: AbortSignal) => Promise<unknown>;
  environment?: VisibleRefreshEnvironment;
}) {
  let disposed = false;
  let inFlight: AbortController | undefined;

  const refresh = async () => {
    const request = new AbortController();
    inFlight = request;
    const writes = projectWrites;
    try {
      const project = await readProject(projectId, request.signal);
      if (!disposed && projectWrites === writes && project !== undefined) {
        onProject(project);
      }
    } catch {
      // Keep the view; the next read corrects it.
    }
  };

  const stopRefresh = startVisibleRefresh({
    onRefresh: refresh,
    pollIntervalMs: PROJECT_EXECUTION_REFRESH_MS,
    environment,
  });

  return () => {
    disposed = true;
    stopRefresh();
    inFlight?.abort();
  };
}
