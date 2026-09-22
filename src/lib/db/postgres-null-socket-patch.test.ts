import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchPostgresNullSocketRace } from "../../../scripts/patch-postgres-null-socket.mjs";

const VULNERABLE_WRITE = "    const x = socket.write(chunk, fn)";
const GUARDED_WRITE = "    const x = socket ? socket.write(chunk, fn) : false";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("postgres.js null-socket dependency patch", () => {
  it("patches both Node module formats and is idempotent", async () => {
    const rootDirectory = await createPostgresFixture(VULNERABLE_WRITE);

    await expect(
      patchPostgresNullSocketRace({ rootDirectory }),
    ).resolves.toEqual([
      { relativePath: "src/connection.js", state: "patched" },
      { relativePath: "cjs/src/connection.js", state: "patched" },
    ]);
    await expect(
      patchPostgresNullSocketRace({ rootDirectory, check: true }),
    ).resolves.toEqual([
      { relativePath: "src/connection.js", state: "already_patched" },
      { relativePath: "cjs/src/connection.js", state: "already_patched" },
    ]);

    for (const relativePath of ["src/connection.js", "cjs/src/connection.js"]) {
      const source = await readFile(
        path.join(rootDirectory, "node_modules", "postgres", relativePath),
        "utf8",
      );
      expect(source).toContain(GUARDED_WRITE);
      expect(source).not.toContain(VULNERABLE_WRITE);
    }
  });

  it("fails check mode before a vulnerable install can be released", async () => {
    const rootDirectory = await createPostgresFixture(VULNERABLE_WRITE);

    await expect(
      patchPostgresNullSocketRace({ rootDirectory, check: true }),
    ).rejects.toThrow("still contains the postgres.js null-socket nextWrite race");
  });

  it("fails closed when the reviewed package version or source pattern drifts", async () => {
    const wrongVersionRoot = await createPostgresFixture(
      VULNERABLE_WRITE,
      "3.5.0",
    );
    await expect(
      patchPostgresNullSocketRace({ rootDirectory: wrongVersionRoot }),
    ).rejects.toThrow("expected postgres@3.4.9");

    const changedSourceRoot = await createPostgresFixture(
      "    const x = writeToSocket(chunk, fn)",
    );
    await expect(
      patchPostgresNullSocketRace({ rootDirectory: changedSourceRoot }),
    ).rejects.toThrow("expected exactly one reviewed postgres.js nextWrite pattern");
  });
});

async function createPostgresFixture(
  writeLine: string,
  version = "3.4.9",
) {
  const rootDirectory = await mkdtemp(
    path.join(tmpdir(), "asael-postgres-patch-"),
  );
  temporaryDirectories.push(rootDirectory);
  const packageDirectory = path.join(rootDirectory, "node_modules", "postgres");
  await Promise.all([
    mkdir(path.join(packageDirectory, "src"), { recursive: true }),
    mkdir(path.join(packageDirectory, "cjs", "src"), { recursive: true }),
  ]);
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name: "postgres", version }),
    "utf8",
  );
  const source = `function nextWrite(fn) {\n${writeLine}\n  return x\n}\n`;
  await Promise.all([
    writeFile(path.join(packageDirectory, "src", "connection.js"), source, "utf8"),
    writeFile(path.join(packageDirectory, "cjs", "src", "connection.js"), source, "utf8"),
  ]);
  return rootDirectory;
}
