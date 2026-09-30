import { describe, expect, it, vi } from "vitest";

import { registerServiceWorkerAfterLoad } from "@/lib/pwa/register";

function fakeWindow(readyState: DocumentReadyState, withWorker = true) {
  const listeners = new Map<string, () => void>();
  const register = vi.fn(async () => ({}));
  const target = {
    document: { readyState },
    navigator: withWorker ? { serviceWorker: { register } } : {},
    addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
  };
  return { target: target as unknown as Window, register, listeners };
}

describe("service worker registration", () => {
  it("registers at once when the page loaded before the registrar mounted", () => {
    const { target, register, listeners } = fakeWindow("complete");

    registerServiceWorkerAfterLoad(target);

    expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/" });
    expect(listeners.size).toBe(0);
  });

  it("waits for the load event while the page is still loading", () => {
    for (const readyState of ["loading", "interactive"] as const) {
      const { target, register, listeners } = fakeWindow(readyState);

      const cleanup = registerServiceWorkerAfterLoad(target);
      expect(register).not.toHaveBeenCalled();
      expect(target.addEventListener).toHaveBeenCalledWith("load", expect.any(Function), { once: true });

      const onLoad = listeners.get("load");
      onLoad?.();
      expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/" });

      cleanup();
      expect(target.removeEventListener).toHaveBeenCalledWith("load", onLoad);
      expect(listeners.size).toBe(0);
    }
  });

  it("does nothing where service workers are unavailable", () => {
    const { target, listeners } = fakeWindow("complete", false);

    const cleanup = registerServiceWorkerAfterLoad(target);
    cleanup();

    expect(listeners.size).toBe(0);
    expect(target.addEventListener).not.toHaveBeenCalled();
  });
});
