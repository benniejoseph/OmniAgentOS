import { createHash } from "node:crypto";
import type { BrowserActivityItem } from "@/lib/runs/activity";

export const BROWSER_ACTIVITY_STREAM_VERSION =
  "p9.5-browser-activity-stream:1" as const;

export type BrowserActivityMode = "live" | "replay";

export type BrowserActivityStreamSnapshot = Readonly<{
  version: typeof BROWSER_ACTIVITY_STREAM_VERSION;
  type: "browser_activity";
  runId: string;
  mode: BrowserActivityMode;
  runStatus: string;
  revision: string;
  generatedAt: string;
  browserActivity: BrowserActivityItem[];
}>;

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled"]);

export function buildBrowserActivityStreamSnapshot(input: {
  runId: string;
  runStatus: string;
  browserActivity: BrowserActivityItem[];
  generatedAt?: string;
}): BrowserActivityStreamSnapshot {
  const runId = input.runId.trim();
  const runStatus = input.runStatus.trim().toLowerCase();
  if (!runId || !runStatus) {
    throw new Error("Browser activity stream requires a run and status.");
  }
  const mode: BrowserActivityMode = TERMINAL_RUN_STATUSES.has(runStatus)
    ? "replay"
    : "live";
  const revision = createHash("sha256").update(JSON.stringify({
    version: BROWSER_ACTIVITY_STREAM_VERSION,
    runId,
    mode,
    runStatus,
    browserActivity: input.browserActivity,
  })).digest("hex");
  return Object.freeze({
    version: BROWSER_ACTIVITY_STREAM_VERSION,
    type: "browser_activity",
    runId,
    mode,
    runStatus,
    revision,
    generatedAt: input.generatedAt || new Date().toISOString(),
    browserActivity: input.browserActivity,
  });
}

export function encodeBrowserActivitySse(
  snapshot: BrowserActivityStreamSnapshot,
) {
  return [
    `id: ${snapshot.revision}`,
    "event: browser_activity",
    `data: ${JSON.stringify(snapshot)}`,
    "",
    "",
  ].join("\n");
}
