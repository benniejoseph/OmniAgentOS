import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadReleaseSigningKey } from "../../../scripts/release-manifest.mjs";

let directory: string;
let repository: string;

// The generator runs from a copy of the repository's scripts, so a key it
// should refuse to write can only ever land in a temporary directory.
beforeEach(() => {
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), "asael-signing-key-cli-")));
  repository = path.join(directory, "repository");
  mkdirSync(path.join(repository, "scripts"), { recursive: true });
  for (const script of ["release-signing-key.mjs", "release-manifest.mjs", "release-provenance.mjs"]) {
    copyFileSync(path.resolve("scripts", script), path.join(repository, "scripts", script));
  }
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function generate(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(repository, "scripts/release-signing-key.mjs"), ...args],
    // Run from outside the copy, so a relative path never lands in it.
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 20_000,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
    },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("npm run release:signing-key", () => {
  it("writes a key only its owner can read and prints only its public half", () => {
    const file = path.join(directory, "keys", "nested", "release-signing-key.pem");

    const run = generate(file);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(directory, "keys")).mode & 0o777).toBe(0o700);
    const key = loadReleaseSigningKey({
      env: { OMNIAGENT_RELEASE_SIGNING_KEY_FILE: file },
      checkout: repository,
    });
    expect(run.stdout).toBe(
      [
        `Wrote release signing key ${key.keyId} to ${file}.`,
        "Add its public key to RELEASE_SIGNING_PUBLIC_KEYS in scripts/release-manifest.mjs:",
        `  "${key.publicKey}",`,
        `Then set OMNIAGENT_RELEASE_SIGNING_KEY_FILE=${file} for releases, and back the file up.`,
        "",
      ].join("\n"),
    );
    const pem = readFileSync(file, "utf8");
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    for (const line of pem.split("\n").filter((part) => part && !part.startsWith("-----"))) {
      expect(run.stdout).not.toContain(line);
    }
  });

  it("never replaces a key", () => {
    const file = path.join(directory, "release-signing-key.pem");
    expect(generate(file).code).toBe(0);
    const original = readFileSync(file, "utf8");

    expect(generate(file)).toEqual({
      code: 1,
      stdout: "",
      stderr: `${file} already exists; choose a new path to rotate the key.\n`,
    });
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("needs an absolute path", () => {
    const usage = "Usage: npm run release:signing-key -- <absolute path outside the repository>\n";

    for (const args of [[], ["release-signing-key.pem"], ["  "]]) {
      expect(generate(...args)).toEqual({ code: 1, stdout: "", stderr: usage });
    }
  });

  it("refuses a path inside the repository, even through a link", () => {
    const refusal =
      "The signing key must live outside the repository, where no deploy uploads it.\n";
    const inside = path.join(repository, "keys", "release-signing-key.pem");
    const link = path.join(directory, "into-repository");
    symlinkSync(path.join(repository, "scripts"), link);
    const throughLink = path.join(link, "release-signing-key.pem");

    expect(generate(inside)).toEqual({ code: 1, stdout: "", stderr: refusal });
    // Refused before any directory is made for it.
    expect(existsSync(path.dirname(inside))).toBe(false);
    expect(generate(throughLink)).toEqual({ code: 1, stdout: "", stderr: refusal });
    expect(existsSync(path.join(repository, "scripts", "release-signing-key.pem"))).toBe(false);
    expect(generate(repository).stderr).toBe(refusal);
    // A sibling of the repository is outside it.
    expect(generate(`${repository}-keys/release-signing-key.pem`).code).toBe(0);
  });
});
