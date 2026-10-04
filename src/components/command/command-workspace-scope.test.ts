import { describe, expect, it, vi } from "vitest";
import { CommandSelectionRead, CommandWorkspaceScope } from "./command-workspace-scope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Assistant mounted request scope", () => {
  it("blocks a request before dispatch while account authority is unavailable", async () => {
    const scope = new CommandWorkspaceScope(false);
    const dispatch = vi.fn(async () => "private result");
    await expect(scope.run(dispatch)).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("aborts a pending read immediately and ignores its later noncooperative result", async () => {
    const scope = new CommandWorkspaceScope(true);
    const result = deferred<string>();
    let observedSignal: AbortSignal | undefined;
    const read = scope.run((signal) => { observedSignal = signal; return result.promise; });
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    scope.setAvailable(false);
    await rejected;
    expect(observedSignal?.aborted).toBe(true);
    result.resolve("Old private response");
    expect(scope.current()).toBe(false);
  });

  it("cannot revive an old lease when the same owner is reauthorized", async () => {
    const scope = new CommandWorkspaceScope(true);
    const old = scope.capture();
    scope.setAvailable(false);
    scope.setAvailable(true);
    expect(old.current()).toBe(false);
    expect(old.signal.aborted).toBe(true);
    expect(await scope.run(async () => "fresh exact read")).toBe("fresh exact read");
    expect(scope.capture().current()).toBe(true);
  });

  it("honors selection cancellation without suspending unrelated current-owner reads", async () => {
    const scope = new CommandWorkspaceScope(true);
    const selection = new AbortController();
    const delayed = deferred<string>();
    const pending = scope.run(() => delayed.promise, selection.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    selection.abort();
    await rejected;
    delayed.resolve("Superseded selection");
    expect(await scope.run(async () => "another read")).toBe("another read");
  });

  it("does not retry or dispatch a follow-up when an admitted mutation loses its response", async () => {
    const scope = new CommandWorkspaceScope(true);
    const result = deferred<{ accepted: true }>();
    const dispatch = vi.fn(() => result.promise);
    const followup = vi.fn();
    const operation = scope.run(dispatch).then(followup);
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    scope.setAvailable(false);
    await rejected;
    result.resolve({ accepted: true });
    scope.setAvailable(true);
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(followup).not.toHaveBeenCalled();
  });
});

describe("Assistant exact selected read", () => {
  it("rejects A after B is selected even when the earlier transport ignores abort", async () => {
    const selected = new CommandSelectionRead();
    const delayed = deferred<string>();
    const first = selected.begin("run:a");
    const adopt = vi.fn();
    const pending = delayed.promise.then((value) => { if (first.current()) adopt(value); });
    const second = selected.begin("run:b");
    delayed.resolve("A");
    await pending;
    expect(first.signal.aborted).toBe(true);
    expect(second.current()).toBe(true);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("invalidates a prior request even when a repeated selection has the same ID", () => {
    const selected = new CommandSelectionRead();
    const first = selected.begin("same run");
    const second = selected.begin("same run");
    expect(first.current()).toBe(false);
    selected.cancel();
    expect(second.current()).toBe(false);
  });
});
