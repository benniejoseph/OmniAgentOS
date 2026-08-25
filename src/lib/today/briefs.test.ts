import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getTodayBriefBundle,
  isBriefGenerationDue,
  localScheduleParts,
  processDueDailyBriefs,
  updateTodayPreferences,
} from "@/lib/today/briefs";
import { createTodayItem } from "@/lib/today/store";

describe("proactive daily briefs", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "omni-briefs-"),
    );
  });

  it("evaluates a schedule in the owner's timezone", async () => {
    const preferences = await updateTodayPreferences({
      briefEnabled: true,
      briefTime: "08:00",
      timezone: "Asia/Kolkata",
    }, { tenantId: "personal", actorId: "owner" });

    expect(localScheduleParts(new Date("2026-08-25T02:29:00.000Z"), preferences.timezone))
      .toEqual({ date: "2026-08-25", time: "07:59" });
    expect(isBriefGenerationDue(preferences, new Date("2026-08-25T02:29:00.000Z"))).toBe(false);
    expect(isBriefGenerationDue(preferences, new Date("2026-08-25T02:30:00.000Z"))).toBe(true);
  });

  it("generates at most one grounded fallback brief per local day", async () => {
    await updateTodayPreferences({
      briefEnabled: true,
      briefTime: "08:00",
      timezone: "UTC",
    }, { tenantId: "personal", actorId: "owner" });
    await createTodayItem({
      tenantId: "personal",
      actorId: "owner",
      title: "Prepare the launch review",
      priority: "high",
    });
    const now = new Date("2026-08-25T09:00:00.000Z");

    const first = await processDueDailyBriefs({ tenantId: "personal", now });
    const second = await processDueDailyBriefs({ tenantId: "personal", now });
    const bundle = await getTodayBriefBundle({ tenantId: "personal", actorId: "owner", now });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      localDate: "2026-08-25",
      generatedBy: "system",
      focus: [expect.objectContaining({ title: "Prepare the launch review" })],
    });
    expect(second).toEqual([]);
    expect(bundle.brief?.id).toBe(first[0].id);
    expect(bundle.generationDue).toBe(false);
  });
});
