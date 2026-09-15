import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startVisibleRefresh,
  type VisibleRefreshEnvironment,
} from "@/lib/client/visible-refresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function testEnvironment(initiallyVisible = true) {
  let visible = initiallyVisible;
  const focusListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();
  const environment: VisibleRefreshEnvironment = {
    isVisible: () => visible,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
    clearTimer: (timer) => clearTimeout(timer),
    addFocusListener: (listener) => focusListeners.add(listener),
    removeFocusListener: (listener) => focusListeners.delete(listener),
    addVisibilityListener: (listener) => visibilityListeners.add(listener),
    removeVisibilityListener: (listener) => visibilityListeners.delete(listener),
  };
  return {
    environment,
    focus: () => focusListeners.forEach((listener) => listener()),
    setVisible(next: boolean) {
      visible = next;
      visibilityListeners.forEach((listener) => listener());
    },
    listenerCount: () => focusListeners.size + visibilityListeners.size,
  };
}

describe("startVisibleRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never overlaps refreshes and schedules the next poll after completion", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const onRefresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const harness = testEnvironment();
    const stop = startVisibleRefresh({
      onRefresh,
      pollIntervalMs: 4_000,
      refreshOnStart: true,
      environment: harness.environment,
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not poll while hidden and refreshes immediately when visible", async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const harness = testEnvironment(false);
    const stop = startVisibleRefresh({
      onRefresh,
      pollIntervalMs: 4_000,
      refreshOnStart: true,
      environment: harness.environment,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRefresh).not.toHaveBeenCalled();
    harness.setVisible(true);
    await Promise.resolve();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    harness.setVisible(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    harness.setVisible(true);
    await Promise.resolve();
    expect(onRefresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("cleans up timers and listeners without rescheduling an in-flight refresh", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const onRefresh = vi.fn<() => Promise<void>>().mockReturnValue(pending.promise);
    const harness = testEnvironment();
    const stop = startVisibleRefresh({
      onRefresh,
      pollIntervalMs: 4_000,
      refreshOnStart: true,
      environment: harness.environment,
    });

    expect(harness.listenerCount()).toBe(2);
    stop();
    expect(harness.listenerCount()).toBe(0);
    pending.resolve();
    await Promise.resolve();
    harness.focus();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
