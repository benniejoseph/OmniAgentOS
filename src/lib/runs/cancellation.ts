import { readAgentRunStatus } from "@/lib/runs/active-run-fence";
import type { RunStatus } from "@/lib/runs/types";

const DEFAULT_CANCELLATION_POLL_MS = 2_000;

/** The abort reason once an operator or the system cancels a watched run. */
export class AgentRunTerminatedError extends Error {
  readonly code = "agent_run_terminated";

  constructor(
    readonly runId: string,
    readonly runStatus: RunStatus,
  ) {
    super(`Agent run ${runId} was ${runStatus}, so its in-flight work was stopped.`);
    this.name = "AgentRunTerminatedError";
  }
}

export type AgentRunCancellationWatch = {
  /** Aborts, with an AgentRunTerminatedError reason, once the watched run is canceled. */
  readonly signal: AbortSignal;
  /** Starts polling the run's stored status. Only the first call has an effect. */
  watch(input: { runId: string; tenantId?: string }): void;
  /** Stops polling. The signal keeps its current state. */
  stop(): void;
};

/**
 * Turns a cancel recorded by another request or worker into an abort signal
 * for the process that is still executing the run. The run's own completion
 * or failure stops the polling without aborting, so its final steps finish.
 * Read errors and a missing row keep polling; the tool claim fence refuses
 * effects for those runs on its own.
 */
export function createAgentRunCancellationWatch(
  options: {
    intervalMs?: number;
    readStatus?: (input: { runId: string; tenantId?: string }) => Promise<RunStatus | undefined>;
  } = {},
): AgentRunCancellationWatch {
  const intervalMs = Math.max(10, options.intervalMs ?? DEFAULT_CANCELLATION_POLL_MS);
  const readStatus = options.readStatus ?? readAgentRunStatus;
  const controller = new AbortController();
  let watched: { runId: string; tenantId?: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    if (stopped || controller.signal.aborted) {
      return;
    }
    timer = setTimeout(() => void poll(), intervalMs);
    timer.unref?.();
  };

  const poll = async () => {
    timer = undefined;
    if (stopped || !watched) {
      return;
    }
    let runStatus: RunStatus | undefined;
    try {
      runStatus = await readStatus(watched);
    } catch {
      schedule();
      return;
    }
    if (stopped) {
      return;
    }
    if (runStatus === "canceled") {
      controller.abort(new AgentRunTerminatedError(watched.runId, runStatus));
      return;
    }
    if (runStatus === "completed" || runStatus === "failed") {
      return;
    }
    schedule();
  };

  return {
    signal: controller.signal,
    watch(input) {
      if (watched || stopped) {
        return;
      }
      watched = { runId: input.runId, tenantId: input.tenantId };
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
