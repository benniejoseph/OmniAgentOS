import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectedSourceIdentity, waitForConnectedSourceClose } from "./connected-source-identity";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function completeForCurrentConnection<T>(
  identity: ReturnType<typeof createConnectedSourceIdentity>,
  request: (connectionId?: string) => Promise<T>,
  apply: (value: T) => void,
) {
  const token = identity.capture();
  const value = await request(token.connectionId);
  if (identity.isCurrent(token)) apply(value);
}

describe("Connected source request identity", () => {
  it("excludes a late session creation after selecting another connection", async () => {
    const identity = createConnectedSourceIdentity("connection-A");
    const creation = deferred<{ id: string }>();
    const createSession = vi.fn(() => creation.promise);
    const applySession = vi.fn();
    const completion = completeForCurrentConnection(identity, createSession, applySession);

    identity.select("connection-B");
    creation.resolve({ id: "session-created-for-A" });
    await completion;

    expect(createSession).toHaveBeenCalledExactlyOnceWith("connection-A");
    expect(applySession).not.toHaveBeenCalled();
    expect(identity.capture().connectionId).toBe("connection-B");
  });

  it("excludes a late session read after the connection selection is cleared", async () => {
    const identity = createConnectedSourceIdentity("connection-A");
    const reading = deferred<{ items: string[] }>();
    const readSession = vi.fn(() => reading.promise);
    const applyItems = vi.fn();
    const completion = completeForCurrentConnection(identity, readSession, applyItems);

    identity.select();
    reading.resolve({ items: ["item-from-A"] });
    await completion;

    expect(readSession).toHaveBeenCalledExactlyOnceWith("connection-A");
    expect(applyItems).not.toHaveBeenCalled();
    expect(identity.capture().connectionId).toBeUndefined();
  });

  it("excludes the original A request after A to B to A while accepting the new A request", async () => {
    const identity = createConnectedSourceIdentity("connection-A");
    const older = deferred<string>();
    const newer = deferred<string>();
    const apply = vi.fn();
    const originalToken = identity.capture();
    const olderCompletion = completeForCurrentConnection(identity, () => older.promise, apply);

    identity.select("connection-B");
    identity.select("connection-A");
    const newerCompletion = completeForCurrentConnection(identity, () => newer.promise, apply);
    newer.resolve("new-A-session");
    await newerCompletion;
    older.resolve("old-A-session");
    await olderCompletion;

    expect(identity.capture()).toEqual({ connectionId: "connection-A", revision: 2 });
    expect(identity.isCurrent(originalToken)).toBe(false);
    expect(apply).toHaveBeenCalledExactlyOnceWith("new-A-session");
  });

  it("retains current tokens and pending work when the same connection is selected", async () => {
    const identity = createConnectedSourceIdentity("connection-A");
    const reading = deferred<string>();
    const apply = vi.fn();
    const token = identity.capture();
    const completion = completeForCurrentConnection(identity, () => reading.promise, apply);

    identity.select("connection-A");
    identity.select("connection-A");
    reading.resolve("current-session");
    await completion;

    expect(identity.capture()).toEqual(token);
    expect(identity.isCurrent(token)).toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith("current-session");
  });

  it("never revives pending work when the same connection reactivates after cleanup", async () => {
    const identity = createConnectedSourceIdentity("connection-A");
    const reading = deferred<string>();
    const apply = vi.fn();
    const originalToken = identity.capture();
    const completion = completeForCurrentConnection(identity, () => reading.promise, apply);

    identity.invalidate();
    const inactiveToken = identity.capture();
    expect(identity.isCurrent(originalToken)).toBe(false);
    expect(identity.isCurrent(inactiveToken)).toBe(false);

    identity.select("connection-A");
    reading.resolve("session-before-cleanup");
    await completion;

    expect(identity.capture()).toEqual({ connectionId: "connection-A", revision: 1 });
    expect(identity.isCurrent(originalToken)).toBe(false);
    expect(identity.isCurrent(inactiveToken)).toBe(false);
    expect(identity.isCurrent(identity.capture())).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it("tracks an absent connection without changing revision for repeated empty selections", () => {
    const identity = createConnectedSourceIdentity();
    const token = identity.capture();

    identity.select();
    expect(identity.isCurrent(token)).toBe(true);
    expect(identity.capture()).toEqual({ connectionId: undefined, revision: 0 });

    identity.select("connection-A");
    expect(identity.isCurrent(token)).toBe(false);
    expect(token).toEqual({ connectionId: undefined, revision: 0 });
    expect(Object.isFrozen(token)).toBe(true);
  });
});

describe("Bounded connected source closure", () => {
  afterEach(() => vi.useRealTimers());

  it("releases an unresolved close after ten seconds without claiming closure", async () => {
    vi.useFakeTimers();
    const close = deferred<void>();
    const result = waitForConnectedSourceClose(close.promise);
    const rejection = expect(result).rejects.toThrow("did not confirm");
    // Use the exact timeout wording; the helper reports uncertainty, not deletion.
    const observed = result.catch((error: Error) => error.message);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await observed).toBe("Google did not confirm that the previous Photos selection closed in time.");
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes normally and clears its timer when the existing close is confirmed", async () => {
    vi.useFakeTimers();
    const close = deferred<void>();
    const result = waitForConnectedSourceClose(close.promise);
    close.resolve();

    await expect(result).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a provider close failure and clears the timeout", async () => {
    vi.useFakeTimers();
    const close = deferred<void>();
    const failure = new Error("Provider cleanup could not be confirmed");
    const result = waitForConnectedSourceClose(close.promise);
    const rejection = expect(result).rejects.toBe(failure);
    close.reject(failure);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not produce a second outcome when a timed-out close settles later", async () => {
    vi.useFakeTimers();
    const close = deferred<void>();
    const confirmed = vi.fn();
    const unconfirmed = vi.fn();
    const result = waitForConnectedSourceClose(close.promise).then(confirmed, unconfirmed);
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    close.reject(new Error("Late provider failure"));
    await Promise.resolve();

    expect(confirmed).not.toHaveBeenCalled();
    expect(unconfirmed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
