import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "@/components/app-shell/session-context";
import {
  INBOX_COUNT_POLL_MS,
  fetchInboxCount,
  inboxCountKey,
  startInboxCount,
  type InboxCountEnvironment,
} from "@/components/app-shell/use-inbox-count";
import type { InboxCount } from "@/lib/approvals/inbox-link";

afterEach(() => {
  vi.useRealTimers();
});

function testEnvironment(initiallyVisible = true) {
  let visible = initiallyVisible;
  const focusListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();
  const changeListeners = new Set<() => void>();
  const environment: InboxCountEnvironment = {
    isVisible: () => visible,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
    clearTimer: (timer) => clearTimeout(timer),
    addFocusListener: (listener) => focusListeners.add(listener),
    removeFocusListener: (listener) => focusListeners.delete(listener),
    addVisibilityListener: (listener) => visibilityListeners.add(listener),
    removeVisibilityListener: (listener) => visibilityListeners.delete(listener),
    addChangeListener: (listener) => changeListeners.add(listener),
    removeChangeListener: (listener) => changeListeners.delete(listener),
  };
  return {
    environment,
    announce: () => changeListeners.forEach((listener) => listener()),
    setVisible(next: boolean) {
      visible = next;
      visibilityListeners.forEach((listener) => listener());
    },
    listenerCount: () => focusListeners.size + visibilityListeners.size + changeListeners.size,
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("whose inbox the badge counts", () => {
  const signedIn: WorkspaceSession = {
    authEnabled: true,
    authenticated: true,
    context: { tenantId: "tenant-1", actorId: "actor-1", role: "operator" },
  };

  it("counts for a signed-in role that may decide", () => {
    expect(inboxCountKey(signedIn, "ready", "operator")).toBe("tenant-1:actor-1:operator");
    expect(inboxCountKey(signedIn, "ready", "admin")).toBe("tenant-1:actor-1:admin");
    expect(inboxCountKey({ authEnabled: false, authenticated: false }, "ready", "operator"))
      .toBe("::operator");
  });

  it("does not count for a viewer, a signed-out session, or one not ready", () => {
    expect(inboxCountKey(signedIn, "ready", "viewer")).toBeUndefined();
    expect(inboxCountKey(signedIn, "loading", "operator")).toBeUndefined();
    expect(inboxCountKey(signedIn, "error", "operator")).toBeUndefined();
    expect(inboxCountKey(undefined, "ready", "operator")).toBeUndefined();
    expect(inboxCountKey({ ...signedIn, authenticated: false }, "ready", "operator")).toBeUndefined();
  });
});

describe("reading the count", () => {
  it("reads the count the inbox route returns", async () => {
    const stub = vi.fn(async () => jsonResponse({ pending: 4, approvals: 3, accessRequests: 1 }));
    const signal = new AbortController().signal;

    await expect(fetchInboxCount(signal, stub as unknown as typeof fetch))
      .resolves.toEqual({ pending: 4, approvals: 3, accessRequests: 1 });
    expect(stub).toHaveBeenCalledWith("/api/inbox", { cache: "no-store", signal });
  });

  it("has no count for a refusal or a body it cannot read", async () => {
    for (const response of [
      jsonResponse({ pending: 4 }, 401),
      new Response("<html>", { status: 200 }),
      jsonResponse({ pending: -1 }),
    ]) {
      await expect(fetchInboxCount(undefined, (async () => response) as unknown as typeof fetch))
        .resolves.toBeUndefined();
    }
  });
});

describe("keeping the count current", () => {
  it("counts once the page settles, then on each poll", async () => {
    vi.useFakeTimers();
    const { environment } = testEnvironment();
    const fetchCount = vi.fn(async () => ({ pending: 3, approvals: 3 }));
    const onCount = vi.fn();

    const stop = startInboxCount({ onCount, fetchCount, environment });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchCount).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCount).toHaveBeenCalledTimes(1);
    expect(onCount).toHaveBeenLastCalledWith({ pending: 3, approvals: 3 });
    await vi.advanceTimersByTimeAsync(27_999);
    expect(fetchCount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCount).toHaveBeenCalledTimes(2);
    stop();
  });

  it("waits for a hidden page to be shown", async () => {
    vi.useFakeTimers();
    const page = testEnvironment(false);
    const fetchCount = vi.fn(async () => ({ pending: 1 }));

    const stop = startInboxCount({ onCount: vi.fn(), fetchCount, environment: page.environment });
    await vi.advanceTimersByTimeAsync(INBOX_COUNT_POLL_MS * 2);
    expect(fetchCount).not.toHaveBeenCalled();
    page.setVisible(true);
    await settle();
    expect(fetchCount).toHaveBeenCalledTimes(1);
    stop();
  });

  it("counts again on a change, and a newer count wins", async () => {
    const page = testEnvironment();
    const resolvers: Array<(count: InboxCount | undefined) => void> = [];
    const signals: AbortSignal[] = [];
    const fetchCount = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<InboxCount | undefined>((resolve) => resolvers.push(resolve));
    });
    const onCount = vi.fn();

    const stop = startInboxCount({ onCount, fetchCount, environment: page.environment });
    page.announce();
    page.announce();
    expect(fetchCount).toHaveBeenCalledTimes(2);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);

    resolvers[1]!({ pending: 1 });
    await settle();
    resolvers[0]!({ pending: 9 });
    await settle();
    expect(onCount.mock.calls).toEqual([[{ pending: 1 }]]);
    stop();
  });

  it("keeps a newer count when an older one settles first", async () => {
    const page = testEnvironment();
    const resolvers: Array<(count: InboxCount | undefined) => void> = [];
    const fetchCount = vi.fn(
      () => new Promise<InboxCount | undefined>((resolve) => resolvers.push(resolve)),
    );
    const onCount = vi.fn();

    const stop = startInboxCount({ onCount, fetchCount, environment: page.environment });
    page.announce();
    page.announce();
    resolvers[0]!({ pending: 9 });
    await settle();
    resolvers[1]!({ pending: 1 });
    await settle();
    expect(onCount.mock.calls).toEqual([[{ pending: 1 }]]);
    stop();
  });

  it("keeps the last count when counting fails", async () => {
    const page = testEnvironment();
    const fetchCount = vi.fn()
      .mockResolvedValueOnce({ pending: 2 })
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ pending: 0 });
    const onCount = vi.fn();

    const stop = startInboxCount({ onCount, fetchCount, environment: page.environment });
    for (let index = 0; index < 4; index += 1) {
      page.announce();
      await settle();
    }
    expect(fetchCount).toHaveBeenCalledTimes(4);
    expect(onCount.mock.calls).toEqual([[{ pending: 2 }], [{ pending: 0 }]]);
    stop();
  });

  it("stops counting and drops a count still in flight", async () => {
    vi.useFakeTimers();
    const page = testEnvironment();
    let resolve!: (count: InboxCount | undefined) => void;
    const signals: AbortSignal[] = [];
    const fetchCount = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<InboxCount | undefined>((resolvePromise) => {
        resolve = resolvePromise;
      });
    });
    const onCount = vi.fn();

    const stop = startInboxCount({ onCount, fetchCount, environment: page.environment });
    page.announce();
    stop();
    expect(signals[0]!.aborted).toBe(true);
    resolve({ pending: 5 });
    await settle();
    expect(onCount).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INBOX_COUNT_POLL_MS * 2);
    expect(fetchCount).toHaveBeenCalledTimes(1);
  });
});
