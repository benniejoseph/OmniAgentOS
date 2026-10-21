import { afterEach, describe, expect, it, vi } from "vitest";
import { startVisiblePolling } from "./visible-polling";
import type { VisibleRefreshEnvironment } from "./visible-refresh";

function harness() {
  let visible = true;
  const focus = new Set<() => void>();
  const visibility = new Set<() => void>();
  const environment: VisibleRefreshEnvironment = {
    isVisible: () => visible,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: timer => clearTimeout(timer),
    addFocusListener: fn => { focus.add(fn); }, removeFocusListener: fn => { focus.delete(fn); },
    addVisibilityListener: fn => { visibility.add(fn); }, removeVisibilityListener: fn => { visibility.delete(fn); },
  };
  return { environment, focus: () => focus.forEach(fn => fn()),
    visible(next: boolean) { visible = next; visibility.forEach(fn => fn()); },
    listeners: () => focus.size + visibility.size };
}
afterEach(() => vi.useRealTimers());

describe("saved work following", () => {
  it("continues beyond the old 180s cutoff through a 240s specialist and parent continuation", async () => {
    vi.useFakeTimers();
    const ui = harness();
    let phase = "specialist";
    const observed: string[] = [];
    const stop = startVisiblePolling({ environment: ui.environment,
      poll: async () => { observed.push(phase); return phase !== "completed"; }, onError: () => {} });
    await vi.advanceTimersByTimeAsync(241_000);
    phase = "parent continuation";
    await vi.advanceTimersByTimeAsync(35_000);
    phase = "completed";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(observed).toContain("parent continuation");
    expect(observed.at(-1)).toBe("completed");
    expect(ui.listeners()).toBe(0);
    stop();
  });
  it("serializes slow reads and pauses hidden tabs, then reconnects immediately", async () => {
    vi.useFakeTimers();
    const ui = harness();
    let finish!: (keep: boolean) => void;
    const poll = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }))
      .mockResolvedValue(true);
    const stop = startVisiblePolling({ environment: ui.environment, poll, onError: () => {} });
    ui.focus();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(poll).toHaveBeenCalledTimes(1);
    ui.visible(false);
    expect(poll.mock.calls[0][0].aborted).toBe(true);
    finish(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(1);
    ui.visible(true);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
  });
  it("backs off repeated failures without abandoning pending work and stops after disposal", async () => {
    vi.useFakeTimers();
    const ui = harness();
    const failure = new Error("offline");
    const poll = vi.fn().mockRejectedValue(failure);
    const errors = vi.fn();
    const stop = startVisiblePolling({ environment: ui.environment, poll, onError: errors });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenLastCalledWith(failure, 3);
    poll.mockResolvedValue(false);
    ui.focus();
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(poll).toHaveBeenCalledTimes(4);
  });
  it("bounds each status request and cancels its read on unmount", async () => {
    vi.useFakeTimers();
    const ui = harness();
    const error = vi.fn();
    const poll = vi.fn((signal: AbortSignal) => new Promise<boolean>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const stop = startVisiblePolling({ environment: ui.environment, poll, onError: error });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
    await Promise.resolve();
    expect(poll.mock.calls[1][0].aborted).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
