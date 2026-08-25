import { describe, expect, it, vi } from "vitest";
import { AsyncTtlCache } from "@/lib/performance/async-ttl-cache";

describe("AsyncTtlCache", () => {
  it("deduplicates pending work and reuses the resolved value", async () => {
    let resolve!: (value: string) => void;
    const loader = vi.fn(
      () => new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const cache = new AsyncTtlCache<string>(1_000);

    const first = cache.get("tenant", loader);
    const second = cache.get("tenant", loader);
    resolve("snapshot");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "snapshot",
      "snapshot",
    ]);
    await expect(cache.get("tenant", loader)).resolves.toBe("snapshot");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("expires values and does not retain rejected work", async () => {
    vi.useFakeTimers();
    const cache = new AsyncTtlCache<string>(100);
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    await expect(cache.get("key", loader)).rejects.toThrow("temporary");
    await expect(cache.get("key", loader)).resolves.toBe("first");
    vi.advanceTimersByTime(101);
    await expect(cache.get("key", loader)).resolves.toBe("second");
    expect(loader).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
