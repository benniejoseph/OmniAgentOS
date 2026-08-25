import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTodayItem, listTodayItems, updateTodayItem } from "@/lib/today/store";

describe("personal today items", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "omni-today-"),
    );
  });

  it("creates, completes, and reopens a private focus item", async () => {
    const item = await createTodayItem({
      tenantId: "personal",
      actorId: "owner",
      title: "Prepare the weekly review",
      priority: "high",
    });
    await expect(
      listTodayItems(10, { tenantId: "personal", actorId: "owner" }),
    ).resolves.toEqual([expect.objectContaining({ id: item.id, status: "open" })]);
    await expect(
      updateTodayItem(
        item.id,
        { status: "done" },
        { tenantId: "personal", actorId: "owner" },
      ),
    ).resolves.toMatchObject({ status: "done", completedAt: expect.any(String) });
    await expect(
      updateTodayItem(
        item.id,
        { status: "open" },
        { tenantId: "personal", actorId: "owner" },
      ),
    ).resolves.toMatchObject({ status: "open", completedAt: undefined });
  });

  it("keeps another actor's items private", async () => {
    await createTodayItem({
      tenantId: "personal",
      actorId: "owner",
      title: "Private task",
    });
    await expect(
      listTodayItems(10, { tenantId: "personal", actorId: "someone-else" }),
    ).resolves.toEqual([]);
  });
});
