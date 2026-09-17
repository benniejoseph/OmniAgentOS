import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  hasDatabaseUrl: vi.fn(() => true),
  sql: vi.fn(),
  runWithDatabaseSystemScope: vi.fn(
    async (_reason: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: () => mocks.sql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
  runWithDatabaseSystemScope: mocks.runWithDatabaseSystemScope,
}));

import { scrubExpiredLocalComputerObservations } from "@/lib/local-computer/store";

describe("local computer observation retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasDatabaseUrl.mockReturnValue(true);
    mocks.sql.mockResolvedValue([{ id: "command-a" }, { id: "command-b" }]);
  });

  it("physically scrubs expired screenshot bytes in one bounded system scope", async () => {
    const result = await scrubExpiredLocalComputerObservations({ limit: 2 });

    expect(result).toEqual({ scrubbed: 2, moreAvailable: true });
    expect(mocks.runWithDatabaseSystemScope).toHaveBeenCalledWith(
      "ephemeral local computer observation scrub",
      expect.any(Function),
    );
    expect(mocks.sql).toHaveBeenCalledOnce();
    const [strings, ...values] = mocks.sql.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const query = strings.join("?");
    expect(query).toContain("result ? 'observation'");
    expect(query).toContain("state = 'consumed'");
    expect(query).toContain("error_code = COALESCE");
    expect(query).toContain("FOR UPDATE SKIP LOCKED");
    expect(values).toEqual([300, 2]);
  });

  it("does not claim retention coverage without durable storage", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(false);

    await expect(scrubExpiredLocalComputerObservations()).resolves.toEqual({
      scrubbed: 0,
      moreAvailable: false,
    });
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
