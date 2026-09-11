#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRepository = "https://github.com/tradingview/charting_library.git";
const releaseTag = "v32.2.0";
const releaseCommit = "f936c921ba510ba20ac51a71b8b4c5c03c043dbc";
const vendorRoot = path.join(repositoryRoot, "public", "vendor", "tradingview");
const targetDirectory = path.join(vendorRoot, "charting_library");
const releaseMarker = path.join(vendorRoot, "release.json");
const requiredEntry = path.join(
  targetDirectory,
  "charting_library.standalone.js",
);

await syncTradingViewLibrary().catch((error) => {
  process.stderr.write(
    `TradingView Advanced Charts sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

async function syncTradingViewLibrary() {
  assertManagedTarget(targetDirectory);
  if (await currentReleaseIsUsable()) {
    process.stdout.write(
      `TradingView Advanced Charts ${releaseTag} is already staged.\n`,
    );
    return;
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "asael-tradingview-charting-"),
  );
  const checkout = path.join(temporaryRoot, "checkout");
  try {
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      releaseTag,
      "--single-branch",
      sourceRepository,
      checkout,
    ]);
    const resolvedCommit = await capture("git", ["rev-parse", "HEAD"], checkout);
    if (resolvedCommit !== releaseCommit) {
      throw new Error(
        `Authorized ${releaseTag} resolved to unexpected commit ${resolvedCommit}.`,
      );
    }

    const sourceDirectory = path.join(checkout, "charting_library");
    await access(path.join(sourceDirectory, "charting_library.standalone.js"));
    await mkdir(vendorRoot, { recursive: true });
    const stagingRoot = await mkdtemp(path.join(vendorRoot, ".staging-"));
    const stagedDirectory = path.join(stagingRoot, "charting_library");
    try {
      await cp(sourceDirectory, stagedDirectory, { recursive: true });
      await access(path.join(stagedDirectory, "charting_library.standalone.js"));
      await rm(targetDirectory, { recursive: true, force: true });
      await rename(stagedDirectory, targetDirectory);
      await writeFile(releaseMarker, `${JSON.stringify({
        library: "TradingView Advanced Charts",
        tag: releaseTag,
        version: releaseTag.slice(1),
        commit: releaseCommit,
        source: sourceRepository,
      }, null, 2)}\n`, "utf8");
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  process.stdout.write(
    `Staged authorized TradingView Advanced Charts ${releaseTag} assets outside Git.\n`,
  );
}

async function currentReleaseIsUsable() {
  const marker = await readFile(releaseMarker, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => undefined);
  if (marker?.tag !== releaseTag || marker?.commit !== releaseCommit) return false;
  return access(requiredEntry).then(() => true).catch(() => false);
}

function assertManagedTarget(target) {
  const expectedPrefix = `${path.join(
    repositoryRoot,
    "public",
    "vendor",
    "tradingview",
  )}${path.sep}`;
  if (!target.startsWith(expectedPrefix) || target === expectedPrefix) {
    throw new Error("TradingView asset target escaped the managed public vendor path.");
  }
}

function run(command, args, cwd = repositoryRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
      ));
    });
  });
}

function capture(command, args, cwd = repositoryRoot) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(
        `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${errorOutput.trim()}`,
      ));
    });
  });
}
