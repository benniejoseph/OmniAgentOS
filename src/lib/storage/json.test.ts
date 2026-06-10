import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, updateJsonFile, writeJsonFile } from "@/lib/storage/json";

async function tempFile(name = "store.json") {
  const dir = await mkdtemp(path.join(tmpdir(), "omni-json-"));
  return path.join(dir, name);
}

describe("json storage", () => {
  it("round-trips values", async () => {
    const file = await tempFile();
    await writeJsonFile(file, { items: [1, 2, 3] });
    expect(await readJsonFile(file, { items: [] as number[] })).toEqual({ items: [1, 2, 3] });
  });

  it("returns the fallback for missing files", async () => {
    const file = await tempFile();
    expect(await readJsonFile(file, { ok: true })).toEqual({ ok: true });
  });

  it("quarantines corrupt files instead of treating them as empty", async () => {
    const file = await tempFile();
    await writeFile(file, "{not json", "utf8");
    expect(await readJsonFile(file, { ok: true })).toEqual({ ok: true });
    const siblings = await readdir(path.dirname(file));
    expect(siblings.some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("serializes concurrent read-modify-write cycles without losing updates", async () => {
    const file = await tempFile();
    await writeJsonFile(file, { count: 0 });

    await Promise.all(
      Array.from({ length: 50 }, () =>
        updateJsonFile(file, { count: 0 }, (current) => ({ count: current.count + 1 })),
      ),
    );

    const result = JSON.parse(await readFile(file, "utf8")) as { count: number };
    expect(result.count).toBe(50);
  });
});
