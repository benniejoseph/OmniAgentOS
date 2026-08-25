type CacheEntry<T> =
  | { expiresAt: number; value: T; pending?: never }
  | { expiresAt: number; pending: Promise<T>; value?: never };

export class AsyncTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 100,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("AsyncTtlCache ttlMs must be positive.");
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("AsyncTtlCache maxEntries must be a positive integer.");
    }
  }

  get(key: string, loader: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      return existing.pending || Promise.resolve(existing.value);
    }
    if (existing) {
      this.entries.delete(key);
    }

    const pending = loader();
    this.entries.set(key, { expiresAt: now + this.ttlMs, pending });
    this.prune();
    return pending.then(
      (value) => {
        if (this.entries.get(key)?.pending === pending) {
          this.entries.set(key, {
            expiresAt: Date.now() + this.ttlMs,
            value,
          });
        }
        return value;
      },
      (error) => {
        if (this.entries.get(key)?.pending === pending) {
          this.entries.delete(key);
        }
        throw error;
      },
    );
  }

  clear() {
    this.entries.clear();
  }

  private prune() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.entries.delete(oldestKey);
    }
  }
}
