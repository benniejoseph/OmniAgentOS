import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateServerTraces,
  loadServerTraces,
} from "../../../scripts/check-server-traces.mjs";

const CANVAS_JS = "node_modules/@napi-rs/canvas/index.js";
const CANVAS_BINDING =
  "node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node";
const FFMPEG_JS = "node_modules/ffmpeg-static/index.js";
const FFMPEG = "node_modules/ffmpeg-static/ffmpeg";
const SHARED_PAGE_FUNCTION =
  "every page shares one function, so native binaries belong in route handlers.";

function trace(entry: string, ...files: string[]) {
  return { entry, files: [".next/server/chunks/ssr/runtime.js", ...files] };
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the server trace check", () => {
  it("keeps native binaries out of every page trace", () => {
    const result = evaluateServerTraces([
      trace("page"),
      trace("app/missions/page", CANVAS_JS, FFMPEG_JS),
      trace("app/page", CANVAS_JS, CANVAS_BINDING, FFMPEG_JS, FFMPEG, "node_modules/addon/addon.node"),
      trace("api/capture/route", CANVAS_JS, CANVAS_BINDING),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      `app/page ships ${CANVAS_BINDING}; ${SHARED_PAGE_FUNCTION}`,
      `app/page ships ${FFMPEG}; ${SHARED_PAGE_FUNCTION}`,
      `app/page ships node_modules/addon/addon.node; ${SHARED_PAGE_FUNCTION}`,
    ]);
  });

  it("requires a route handler that loads a native package to ship its binary", () => {
    const result = evaluateServerTraces([
      trace("app/page", CANVAS_JS, FFMPEG_JS),
      trace("api/capture/route", CANVAS_JS),
      trace("api/agent/route", CANVAS_JS, CANVAS_BINDING, FFMPEG_JS),
      trace("api/tools/route", FFMPEG),
      trace("api/health/route"),
    ]);
    expect(result.failures).toEqual([
      "api/capture/route loads the canvas binding without node_modules/@napi-rs/canvas-<platform>/*.node.",
      "api/agent/route loads ffmpeg without node_modules/ffmpeg-static/ffmpeg.",
    ]);
  });

  it("passes pages that trace only loaders and route handlers that ship their binaries", () => {
    expect(
      evaluateServerTraces([
        trace("app/page", CANVAS_JS, FFMPEG_JS),
        trace("api/agent/route", CANVAS_JS, CANVAS_BINDING, FFMPEG_JS, FFMPEG),
        trace("api/media/video/clip/route", FFMPEG_JS, FFMPEG),
        trace("api/health/route"),
      ]),
    ).toEqual({ ok: true, pages: 1, nativeRoutes: 2, failures: [] });
  });

  it("refuses a build with no pages or no route handlers", () => {
    for (const traces of [[], [trace("app/page")], [trace("api/health/route")]]) {
      expect(() => evaluateServerTraces(traces)).toThrow(
        "The build traced no pages or no route handlers.",
      );
    }
  });
});

describe("checking a build", () => {
  function build(traces: Record<string, string[]>) {
    const root = mkdtempSync(path.join(tmpdir(), "server-traces-"));
    directories.push(root);
    for (const [entry, files] of Object.entries(traces)) {
      const traceFile = path.join(root, ".next", "server", "app", `${entry}.js.nft.json`);
      mkdirSync(path.dirname(traceFile), { recursive: true });
      writeFileSync(
        traceFile,
        JSON.stringify({
          version: 1,
          files: files.map((file) =>
            path.relative(path.dirname(traceFile), path.join(root, file)),
          ),
        }),
      );
    }
    return root;
  }

  function check(root: string) {
    return spawnSync(
      process.execPath,
      [path.resolve("scripts/check-server-traces.mjs"), root],
      { encoding: "utf8" },
    );
  }

  it("reads each trace relative to its own file", async () => {
    const root = build({
      "app/missions/[id]/page": [CANVAS_JS],
      "api/agent/route": [FFMPEG_JS, FFMPEG],
    });
    expect(await loadServerTraces(root)).toEqual([
      { entry: "api/agent/route", files: [FFMPEG_JS, FFMPEG] },
      { entry: "app/missions/[id]/page", files: [CANVAS_JS] },
    ]);
  });

  it("passes a build that keeps binaries in route handlers, and fails one that ships them with a page", () => {
    const kept = check(
      build({ "app/page": [CANVAS_JS], "api/agent/route": [CANVAS_JS, CANVAS_BINDING] }),
    );
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain(
      "PASS 1 page traces ship no native binary, and 1 route handlers ship the binaries of the native packages they load.",
    );

    const shipped = check(
      build({
        "app/page": [CANVAS_JS, CANVAS_BINDING],
        "api/agent/route": [CANVAS_JS, CANVAS_BINDING],
      }),
    );
    expect(shipped.status).toBe(1);
    expect(shipped.stderr).toContain(
      `FAIL app/page ships ${CANVAS_BINDING}; ${SHARED_PAGE_FUNCTION}`,
    );
  });

  it("fails when there is no build, rather than passing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "server-traces-"));
    directories.push(root);
    const missing = check(root);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      `FAIL No server build at ${path.join(root, ".next", "server", "app")}. Run \`next build\` first.`,
    );
  });
});
