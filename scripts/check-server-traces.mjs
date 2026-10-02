#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

// Packages that load a native binary at runtime. A route handler that traces
// the loader must ship the binary beside it, or the code path fails at runtime.
const NATIVE_PACKAGES = [
  {
    name: "the canvas binding",
    loader: /^node_modules\/@napi-rs\/canvas\/[^/]+\.js$/,
    binary: /^node_modules\/@napi-rs\/canvas-[^/]+\/.+\.node$/,
    expected: "node_modules/@napi-rs/canvas-<platform>/*.node",
  },
  {
    name: "ffmpeg",
    loader: /^node_modules\/ffmpeg-static\/index\.js$/,
    binary: /^node_modules\/ffmpeg-static\/ffmpeg$/,
    expected: "node_modules/ffmpeg-static/ffmpeg",
  },
];

function isNativeBinary(file) {
  return file.endsWith(".node") || NATIVE_PACKAGES.some(({ binary }) => binary.test(file));
}

/**
 * Checks the server traces of an App Router build. Vercel ships every page in
 * one function, so a native binary in any page trace slows every cold page
 * load; pages may trace a native package's JavaScript but never its binary.
 * A route handler runs in its own function and must ship the binary of every
 * native package it traces.
 */
export function evaluateServerTraces(traces) {
  const pages = traces.filter(({ entry }) => path.posix.basename(entry) === "page");
  const routes = traces.filter(({ entry }) => path.posix.basename(entry) === "route");
  if (pages.length === 0 || routes.length === 0) {
    throw new Error("The build traced no pages or no route handlers.");
  }
  const failures = [];
  for (const { entry, files } of pages) {
    for (const file of files.filter(isNativeBinary)) {
      failures.push(
        `${entry} ships ${file}; every page shares one function, so native binaries belong in route handlers.`,
      );
    }
  }
  const nativeRoutes = new Set();
  for (const { entry, files } of routes) {
    for (const { name, loader, binary, expected } of NATIVE_PACKAGES) {
      if (!files.some((file) => loader.test(file))) continue;
      nativeRoutes.add(entry);
      if (!files.some((file) => binary.test(file))) {
        failures.push(`${entry} loads ${name} without ${expected}.`);
      }
    }
  }
  return {
    ok: failures.length === 0,
    pages: pages.length,
    nativeRoutes: nativeRoutes.size,
    failures,
  };
}

/** Reads every `*.js.nft.json` under `.next/server/app` as project paths. */
export async function loadServerTraces(projectRoot) {
  const appDir = path.join(projectRoot, ".next", "server", "app");
  const traceFiles = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const itemPath = path.join(directory, item.name);
      if (item.isDirectory()) await walk(itemPath);
      else if (item.name.endsWith(".js.nft.json")) traceFiles.push(itemPath);
    }
  }
  try {
    await walk(appDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`No server build at ${appDir}. Run \`next build\` first.`);
    }
    throw error;
  }
  return Promise.all(
    traceFiles.sort().map(async (traceFile) => {
      const { files } = JSON.parse(await readFile(traceFile, "utf8"));
      return {
        entry: toPosix(path.relative(appDir, traceFile)).replace(/\.js\.nft\.json$/, ""),
        files: (files ?? []).map((file) =>
          toPosix(path.relative(projectRoot, path.resolve(path.dirname(traceFile), file))),
        ),
      };
    }),
  );
}

function toPosix(file) {
  return file.split(path.sep).join("/");
}

async function main() {
  const projectRoot = path.resolve(process.argv[2] || DEFAULT_PROJECT_ROOT);
  const result = evaluateServerTraces(await loadServerTraces(projectRoot));
  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS ${result.pages} page traces ship no native binary, and ${result.nativeRoutes} route handlers ship the binaries of the native packages they load.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      `FAIL ${error instanceof Error ? error.message : "the server traces could not be checked."}`,
    );
    process.exitCode = 1;
  });
}
