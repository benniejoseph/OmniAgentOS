import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readJsonFile, updateJsonFile, writeJsonFile } from "@/lib/storage/json";

const execFileAsync = promisify(execFile);

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

  it("uses private directory and file permissions", async () => {
    const file = await tempFile();
    await writeJsonFile(file, { private: true });
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("serializes updates across separate processes", async () => {
    const file = await tempFile("cross-process.json");
    await writeJsonFile(file, { count: 0 });
    const moduleUrl = pathToFileURL(path.resolve(process.cwd(), "src/lib/storage/json.ts")).href;
    const script = [
      `import { updateJsonFile } from ${JSON.stringify(moduleUrl)};`,
      `const file = ${JSON.stringify(file)};`,
      "for (let index = 0; index < 20; index += 1) {",
      "  await updateJsonFile(file, { count: 0 }, (current) => ({ count: current.count + 1 }));",
      "}",
    ].join("\n");

    await Promise.all(
      Array.from({ length: 4 }, () =>
        execFileAsync(process.execPath, [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          script,
        ]),
      ),
    );

    expect(await readJsonFile(file, { count: 0 })).toEqual({ count: 80 });
  });

  it("recovers an abandoned stale process lock", async () => {
    const file = await tempFile("stale-lock.json");
    await writeJsonFile(file, { count: 0 });
    const lockPath = `${file}.lock`;
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: 99_999_999, token: "abandoned" }),
      { mode: 0o600 },
    );
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleAt, staleAt);

    await expect(
      updateJsonFile(file, { count: 0 }, (current) => ({ count: current.count + 1 })),
    ).resolves.toEqual({ count: 1 });
  });
});
