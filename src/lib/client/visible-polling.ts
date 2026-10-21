import { browserRefreshEnvironment, type VisibleRefreshEnvironment } from "./visible-refresh";

/** A mounted owner follows saved state. Hiding pauses reads, never the saved work. */
export function startVisiblePolling({
  poll,
  onError,
  intervalMs = 5_000,
  maxIntervalMs = 30_000,
  requestTimeoutMs = 20_000,
  environment = browserRefreshEnvironment,
}: {
  /** false ends following only after a confirmed terminal observation. */
  poll: (signal: AbortSignal) => Promise<boolean>;
  onError: (error: unknown, consecutiveFailures: number) => void;
  intervalMs?: number;
  maxIntervalMs?: number;
  requestTimeoutMs?: number;
  environment?: VisibleRefreshEnvironment;
}) {
  let disposed = false;
  let timer: number | undefined;
  let inFlight: AbortController | undefined;
  let failures = 0;
  let wakePending = false;
  const clear = () => {
    if (timer !== undefined) environment.clearTimer(timer);
    timer = undefined;
  };
  const stop = () => {
    disposed = true;
    clear();
    inFlight?.abort();
    environment.removeFocusListener(wake);
    environment.removeVisibilityListener(visibility);
  };
  const schedule = () => {
    if (disposed || inFlight || !environment.isVisible()) return;
    clear();
    timer = environment.setTimer(() => { timer = undefined; void run(); },
      Math.min(maxIntervalMs, intervalMs * 2 ** Math.min(failures, 6)));
  };
  const run = async () => {
    if (disposed || inFlight || !environment.isVisible()) return;
    const request = new AbortController();
    inFlight = request;
    let timedOut = false;
    const deadline = environment.setTimer(() => {
      timedOut = true;
      request.abort(new Error("The saved status read timed out."));
    }, requestTimeoutMs);
    try {
      const keepFollowing = await poll(request.signal);
      if (disposed || request.signal.aborted) return;
      failures = 0;
      if (!keepFollowing) stop();
    } catch (error) {
      if (!disposed && (!request.signal.aborted || timedOut)) onError(error, ++failures);
    } finally {
      environment.clearTimer(deadline);
      if (inFlight === request) inFlight = undefined;
      if (wakePending && !disposed && environment.isVisible()) {
        wakePending = false;
        void run();
      } else schedule();
    }
  };
  function wake() {
    if (disposed || !environment.isVisible()) return;
    clear();
    if (inFlight) {
      // A read canceled by hiding may still be unwinding when the tab wakes.
      if (inFlight.signal.aborted) wakePending = true;
      return;
    }
    void run();
  }
  function visibility() {
    if (environment.isVisible()) wake();
    else { clear(); inFlight?.abort(); }
  }
  environment.addFocusListener(wake);
  environment.addVisibilityListener(visibility);
  wake();
  return stop;
}
