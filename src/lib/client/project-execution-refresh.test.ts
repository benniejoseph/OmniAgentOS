import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_EXECUTION_REFRESH_MS,
  projectExecutionIsLive,
  readProjectSnapshot,
  runProjectWrite,
  startProjectExecutionRefresh,
} from "@/lib/client/project-execution-refresh";
import type { VisibleRefreshEnvironment } from "@/lib/client/visible-refresh";

afterEach(() => {
  vi.useRealTimers();
});

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

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settleWith, failWith) => {
    resolve = settleWith;
    reject = failWith;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("which executions are refreshed", () => {
  it("refreshes only an execution the worker is still advancing", () => {
    expect(projectExecutionIsLive("running")).toBe(true);
    expect(projectExecutionIsLive("waiting_approval")).toBe(true);
    for (const status of ["idle", "paused", "completed", "failed", undefined]) {
      expect(projectExecutionIsLive(status)).toBe(false);
    }
  });
});

describe("reading a project", () => {
  it("reads the project route without asking it to change anything", async () => {
    const stub = vi.fn(async () => jsonResponse({ project: { id: "project a" }, serviceReceipt: {} }));
    const signal = new AbortController().signal;

    await expect(readProjectSnapshot("project a", signal, stub as unknown as typeof fetch))
      .resolves.toEqual({ id: "project a" });
    expect(stub).toHaveBeenCalledWith("/api/projects/project%20a", { cache: "no-store", signal });
  });

  it("has no project for a refusal or a body it cannot read", async () => {
    for (const response of [
      jsonResponse({ project: { id: "project-a" } }, 404),
      new Response("<html>", { status: 200 }),
      jsonResponse(null),
      jsonResponse({ error: "missing" }),
    ]) {
      await expect(readProjectSnapshot(
        "project-a",
        undefined,
        (async () => response) as unknown as typeof fetch,
      )).resolves.toBeUndefined();
    }
  });
});

describe("refreshing a running project", () => {
  it("reads the project again on each poll and passes on what it read", async () => {
    vi.useFakeTimers();
    const { environment } = testEnvironment();
    const readProject = vi.fn(async (projectId: string) => ({ id: projectId }));
    const onProject = vi.fn();

    const stop = startProjectExecutionRefresh({
      projectId: "project-a",
      onProject,
      readProject,
      environment,
    });
    await vi.advanceTimersByTimeAsync(PROJECT_EXECUTION_REFRESH_MS - 1);
    expect(readProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readProject).toHaveBeenCalledTimes(1);
    expect(readProject).toHaveBeenLastCalledWith("project-a", expect.any(AbortSignal));
    expect(onProject.mock.calls).toEqual([[{ id: "project-a" }]]);
    await vi.advanceTimersByTimeAsync(PROJECT_EXECUTION_REFRESH_MS);
    expect(readProject).toHaveBeenCalledTimes(2);
    expect(PROJECT_EXECUTION_REFRESH_MS).toBe(12_000);
    stop();
  });

  it("only ever reads the project, never commands its execution", async () => {
    vi.useFakeTimers();
    const page = testEnvironment();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ project: { id: "project-a" } }) };
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const stop = startProjectExecutionRefresh({
        projectId: "project-a",
        onProject: vi.fn(),
        environment: page.environment,
      });
      await vi.advanceTimersByTimeAsync(PROJECT_EXECUTION_REFRESH_MS * 3);
      page.focus();
      await settle();
      stop();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(4);
    for (const { url, init } of requests) {
      expect(url).toBe("/api/projects/project-a");
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });

  it("waits while the page is hidden and reads as soon as it is shown", async () => {
    vi.useFakeTimers();
    const page = testEnvironment(false);
    const readProject = vi.fn(async () => ({ id: "project-a" }));

    const stop = startProjectExecutionRefresh({
      projectId: "project-a",
      onProject: vi.fn(),
      readProject,
      environment: page.environment,
    });
    await vi.advanceTimersByTimeAsync(PROJECT_EXECUTION_REFRESH_MS * 3);
    expect(readProject).not.toHaveBeenCalled();
    page.setVisible(true);
    await settle();
    expect(readProject).toHaveBeenCalledTimes(1);
    stop();
  });

  it("drops a read that one of the page's writes started or finished during", async () => {
    const page = testEnvironment();
    const reads: Array<ReturnType<typeof deferred<unknown>>> = [];
    const readProject = vi.fn(() => {
      const read = deferred<unknown>();
      reads.push(read);
      return read.promise;
    });
    const onProject = vi.fn();
    const stop = startProjectExecutionRefresh({
      projectId: "project-a",
      onProject,
      readProject,
      environment: page.environment,
    });

    // A write starts while the read is out, and is still running.
    page.focus();
    const write = deferred<string>();
    const written = runProjectWrite(() => write.promise);
    reads[0]!.resolve({ id: "project-a", executionStatus: "running" });
    await settle();
    expect(onProject).not.toHaveBeenCalled();

    // A read starts during the write, and the write finishes first.
    page.focus();
    write.resolve("paused");
    await expect(written).resolves.toBe("paused");
    reads[1]!.resolve({ id: "project-a", executionStatus: "running" });
    await settle();
    expect(onProject).not.toHaveBeenCalled();

    // A failed write is counted too.
    page.focus();
    const failed = runProjectWrite(() => Promise.reject(new Error("refused")));
    await expect(failed).rejects.toThrow("refused");
    reads[2]!.resolve({ id: "project-a", executionStatus: "running" });
    await settle();
    expect(onProject).not.toHaveBeenCalled();

    // A read with no write in between is passed on.
    page.focus();
    reads[3]!.resolve({ id: "project-a", executionStatus: "paused" });
    await settle();
    expect(onProject.mock.calls).toEqual([[{ id: "project-a", executionStatus: "paused" }]]);
    stop();
  });

  it("keeps the view when a read fails or finds nothing, and reads again", async () => {
    const page = testEnvironment();
    const readProject = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "project-a" });
    const onProject = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const stop = startProjectExecutionRefresh({
        projectId: "project-a",
        onProject,
        readProject,
        environment: page.environment,
      });
      for (let index = 0; index < 3; index += 1) {
        page.focus();
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      stop();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(readProject).toHaveBeenCalledTimes(3);
    expect(onProject.mock.calls).toEqual([[{ id: "project-a" }]]);
    // A failed read is not left for the page to report as an error.
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("stops reading, cancels a read still out, and drops its result", async () => {
    vi.useFakeTimers();
    const page = testEnvironment();
    const read = deferred<unknown>();
    let signal: AbortSignal | undefined;
    const readProject = vi.fn((_projectId: string, readSignal: AbortSignal) => {
      signal = readSignal;
      return read.promise;
    });
    const onProject = vi.fn();

    const stop = startProjectExecutionRefresh({
      projectId: "project-a",
      onProject,
      readProject,
      environment: page.environment,
    });
    page.focus();
    expect(signal?.aborted).toBe(false);
    stop();
    expect(signal?.aborted).toBe(true);
    read.resolve({ id: "project-a" });
    await settle();
    await vi.advanceTimersByTimeAsync(PROJECT_EXECUTION_REFRESH_MS * 3);
    expect(readProject).toHaveBeenCalledTimes(1);
    expect(onProject).not.toHaveBeenCalled();
    expect(page.listenerCount()).toBe(0);
  });
});
