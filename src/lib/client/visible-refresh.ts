type TimerHandle = number;

export type VisibleRefreshEnvironment = {
  isVisible: () => boolean;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
  addFocusListener: (listener: () => void) => void;
  removeFocusListener: (listener: () => void) => void;
  addVisibilityListener: (listener: () => void) => void;
  removeVisibilityListener: (listener: () => void) => void;
};

const browserEnvironment: VisibleRefreshEnvironment = {
  isVisible: () => document.visibilityState === "visible",
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timer) => window.clearTimeout(timer),
  addFocusListener: (listener) => window.addEventListener("focus", listener),
  removeFocusListener: (listener) => window.removeEventListener("focus", listener),
  addVisibilityListener: (listener) => document.addEventListener("visibilitychange", listener),
  removeVisibilityListener: (listener) => document.removeEventListener("visibilitychange", listener),
};

export function startVisibleRefresh({
  onRefresh,
  pollIntervalMs,
  refreshOnStart = false,
  environment = browserEnvironment,
}: {
  onRefresh: () => Promise<void>;
  pollIntervalMs?: number;
  refreshOnStart?: boolean;
  environment?: VisibleRefreshEnvironment;
}) {
  let disposed = false;
  let refreshing = false;
  let timer: TimerHandle | undefined;

  const clearScheduled = () => {
    if (timer === undefined) return;
    environment.clearTimer(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (
      disposed ||
      refreshing ||
      timer !== undefined ||
      !pollIntervalMs ||
      !environment.isVisible()
    ) {
      return;
    }
    timer = environment.setTimer(() => {
      timer = undefined;
      void refresh();
    }, pollIntervalMs);
  };

  const refresh = async () => {
    if (disposed || refreshing || !environment.isVisible()) return;
    refreshing = true;
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      schedule();
    }
  };

  const wake = () => {
    if (!environment.isVisible()) return;
    clearScheduled();
    void refresh();
  };

  const handleVisibility = () => {
    if (!environment.isVisible()) {
      clearScheduled();
      return;
    }
    wake();
  };

  environment.addFocusListener(wake);
  environment.addVisibilityListener(handleVisibility);
  if (refreshOnStart) {
    void refresh();
  } else {
    schedule();
  }

  return () => {
    disposed = true;
    clearScheduled();
    environment.removeFocusListener(wake);
    environment.removeVisibilityListener(handleVisibility);
  };
}
