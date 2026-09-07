import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectRunActivityService } from "@/lib/app-services/runs";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  buildBrowserActivityStreamSnapshot,
  encodeBrowserActivitySse,
  type BrowserActivityStreamSnapshot,
} from "@/lib/runs/activity-stream";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);

const POLL_INTERVAL_MS = 1_000;
const STREAM_WINDOW_MS = 24_000;
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_run_activity",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const caller = createAppServiceCaller({ context: auth });
  let initial: BrowserActivityStreamSnapshot;
  try {
    initial = await loadSnapshot(caller, id);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Run not found.") throw error;
    return Response.json(
      { error: "Run not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }

  const encoder = new TextEncoder();
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void pumpActivity({
        controller,
        encoder,
        initial,
        load: () => loadSnapshot(caller, id),
        requestSignal: request.signal,
        isCanceled: () => canceled,
      });
    },
    cancel() {
      canceled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "private, no-cache, no-store, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

async function loadSnapshot(
  caller: ReturnType<typeof createAppServiceCaller>,
  runId: string,
) {
  const result = await inspectRunActivityService(caller, { runId });
  if (!result.data.status) throw new Error("Run not found.");
  return buildBrowserActivityStreamSnapshot({
    runId: result.data.runId,
    runStatus: result.data.status,
    browserActivity: result.data.browserActivity,
  });
}

async function pumpActivity(input: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  initial: BrowserActivityStreamSnapshot;
  load: () => Promise<BrowserActivityStreamSnapshot>;
  requestSignal: AbortSignal;
  isCanceled: () => boolean;
}) {
  const deadline = Date.now() + STREAM_WINDOW_MS;
  let snapshot = input.initial;
  let revision = "";
  let heartbeat = 0;
  try {
    while (!input.requestSignal.aborted && !input.isCanceled()) {
      if (snapshot.revision !== revision) {
        input.controller.enqueue(
          input.encoder.encode(encodeBrowserActivitySse(snapshot)),
        );
        revision = snapshot.revision;
      }
      if (snapshot.mode === "replay" || Date.now() >= deadline) break;
      await abortableDelay(POLL_INTERVAL_MS, input.requestSignal);
      if (input.requestSignal.aborted || input.isCanceled()) break;
      snapshot = await input.load();
      heartbeat += 1;
      if (heartbeat % 10 === 0 && snapshot.revision === revision) {
        input.controller.enqueue(input.encoder.encode(": keepalive\n\n"));
      }
    }
  } catch {
    if (!input.requestSignal.aborted && !input.isCanceled()) {
      input.controller.enqueue(input.encoder.encode([
        "event: browser_activity_error",
        `data: ${JSON.stringify({ type: "browser_activity_error", retryable: true })}`,
        "",
        "",
      ].join("\n")));
    }
  } finally {
    if (!input.isCanceled()) input.controller.close();
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
