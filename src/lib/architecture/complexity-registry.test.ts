import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  answersGone,
  capabilityIdsIn,
  checkComplexityRegistry,
  COMPLEXITY_REGISTRY,
  isComplexityMarkedPath,
  transitionalFlagsIn,
  type ComplexityEntry,
  type ComplexityInventory,
} from "@/lib/architecture/complexity-registry";

const REGISTRY_FILE = "src/lib/architecture/complexity-registry.ts";

function repositoryInventory(): ComplexityInventory {
  const root = process.cwd();
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src", "scripts"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)));
  const flags = new Set<string>();
  const capabilities = new Set<string>();
  const retiredRoutes: string[] = [];
  for (const file of files) {
    if (
      file === REGISTRY_FILE ||
      !/\.[cm]?[jt]sx?$/.test(file) ||
      /\.(?:test|spec)\./.test(file)
    ) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf8");
    for (const flag of transitionalFlagsIn(source)) flags.add(flag);
    for (const capability of capabilityIdsIn(source)) capabilities.add(capability);
    if (/^src\/app\/.*\/route\.ts$/.test(file) && answersGone(source)) {
      retiredRoutes.push(file);
    }
  }
  return {
    files,
    markedFiles: files.filter(isComplexityMarkedPath),
    flags: [...flags],
    capabilities: [...capabilities],
    retiredRoutes,
  };
}

const entry = (overrides: Partial<ComplexityEntry> = {}): ComplexityEntry => ({
  id: "reader-shadow",
  kind: "shadow",
  owner: "runs",
  summary: "Reads beside the live reader.",
  exitMetric: "Matches for 30 days; then delete it.",
  reviewedOn: "2026-09-29",
  expiresOn: "2026-12-28",
  paths: ["src/lib/reader-shadow.ts"],
  ...overrides,
});

const inventory = (
  overrides: Partial<ComplexityInventory> = {},
): ComplexityInventory => ({
  files: ["src/lib/reader-shadow.ts", "src/lib/reader.ts"],
  markedFiles: ["src/lib/reader-shadow.ts"],
  flags: [],
  capabilities: [],
  retiredRoutes: [],
  ...overrides,
});

function check(
  registry: readonly ComplexityEntry[],
  overrides: Partial<ComplexityInventory> = {},
  today = "2026-10-01",
) {
  return checkComplexityRegistry({
    registry,
    inventory: inventory(overrides),
    today,
  }).map(({ rule, subject }) => `${rule} ${subject}`);
}

describe("complexity registry", () => {
  it("registers every transitional path, flag, capability and retired route in the repository", () => {
    const violations = checkComplexityRegistry({
      registry: COMPLEXITY_REGISTRY,
      inventory: repositoryInventory(),
      today: new Date().toISOString().slice(0, 10),
    });

    expect(violations.map(({ message }) => message)).toEqual([]);
  });

  it("finds the repository's transitional code", () => {
    const found = repositoryInventory();

    // The scan itself must keep seeing what the registry names.
    expect(found.markedFiles).toContain("src/lib/runs/approval-checkpoint-shadow.ts");
    expect(found.flags).toContain("OMNIAGENT_CONNECTOR_ALLOW_LEGACY_SYSTEM_SECRETS");
    expect(found.capabilities).toContain("agent_run_checkpoints");
    expect(found.retiredRoutes).toContain("src/app/api/runs/[id]/takeover/route.ts");
  });

  it("passes a complete, current registry", () => {
    expect(check([entry()])).toEqual([]);
  });

  it("fails on a transitional file with no entry, and on an entry whose file is gone", () => {
    expect(check([], { markedFiles: ["src/lib/reader-shadow.ts"] }))
      .toEqual(["unregistered src/lib/reader-shadow.ts"]);
    expect(check([entry()], { files: ["src/lib/reader.ts"] }))
      .toEqual(["stale src/lib/reader-shadow.ts"]);
  });

  it("lets a directory cover its files, and fails once the directory is empty", () => {
    const directory = entry({ paths: ["src/lib/shadow/"] });

    expect(check([directory], {
      files: ["src/lib/shadow/reader.ts"],
      markedFiles: ["src/lib/shadow/reader.ts"],
    })).toEqual([]);
    expect(check([directory], { markedFiles: [] }))
      .toEqual(["stale src/lib/shadow/"]);
    // A file named like the directory is not inside it.
    expect(check([directory], {
      files: ["src/lib/shadow.ts"],
      markedFiles: ["src/lib/shadow.ts"],
    })).toEqual(["unregistered src/lib/shadow.ts", "stale src/lib/shadow/"]);
  });

  it("holds a route that answers 410 to a retired entry", () => {
    const route = "src/app/api/old/route.ts";
    const files = ["src/lib/reader-shadow.ts", route];

    expect(check([entry()], { files, retiredRoutes: [route] }))
      .toEqual([`unregistered ${route}`]);
    expect(check([entry({ paths: ["src/lib/reader-shadow.ts", route] })], {
      files,
      retiredRoutes: [route],
    })).toEqual([`unregistered ${route}`]);
    expect(check([
      entry(),
      entry({ id: "old-route", kind: "retired", paths: [route] }),
    ], { files, retiredRoutes: [route] })).toEqual([]);
  });

  it("fails on an unregistered or stale flag and capability", () => {
    expect(check([entry()], {
      flags: ["READER_CANARY"],
      capabilities: ["reader_v2"],
    })).toEqual(["unregistered READER_CANARY", "unregistered reader_v2"]);
    expect(check([entry({
      flags: ["READER_CANARY"],
      capabilities: ["reader_v2"],
    })])).toEqual(["stale READER_CANARY", "stale reader_v2"]);
    expect(check([entry({
      flags: ["READER_CANARY"],
      capabilities: ["reader_v2"],
    })], {
      flags: ["READER_CANARY"],
      capabilities: ["reader_v2"],
    })).toEqual([]);
  });

  it("fails from the expiry date, not before it", () => {
    const expiring = [entry({ expiresOn: "2026-10-17" })];

    expect(check(expiring, {}, "2026-10-16")).toEqual([]);
    expect(check(expiring, {}, "2026-10-17")).toEqual(["expired reader-shadow"]);
    expect(check(expiring, {}, "2027-01-01")).toEqual(["expired reader-shadow"]);
    expect(() => check(expiring, {}, "2026-13-01")).toThrow("Invalid date");
  });

  it("needs an expiry within the review window, after a real review date", () => {
    expect(check([entry({ expiresOn: "2027-03-28" })])).toEqual([]);
    expect(check([entry({ expiresOn: "2027-03-29" })]))
      .toEqual(["incomplete reader-shadow"]);
    expect(check([entry({ expiresOn: "2026-09-29" })], {}, "2026-09-01"))
      .toEqual(["incomplete reader-shadow"]);
    // The runtime reads September 31 as October 1; the registry does not.
    expect(check([entry({ reviewedOn: "2026-09-31" })]))
      .toEqual(["incomplete reader-shadow"]);
    expect(check([entry({ expiresOn: "12/28/2026" })]))
      .toEqual(["incomplete reader-shadow"]);
  });

  it("needs an owner, a summary, an exit metric and something to track", () => {
    expect(check([entry({ owner: " " })])).toEqual(["incomplete reader-shadow"]);
    expect(check([entry({ summary: "" })])).toEqual(["incomplete reader-shadow"]);
    expect(check([entry({ exitMetric: "" })])).toEqual(["incomplete reader-shadow"]);
    expect(check([entry({ paths: [] })], { markedFiles: [] }))
      .toEqual(["incomplete reader-shadow"]);
    expect(check([entry({ paths: [], flags: ["READER_CANARY"] })], {
      markedFiles: [],
      flags: ["READER_CANARY"],
    })).toEqual([]);
    expect(check([entry({ paths: [], capabilities: ["reader_v2"] })], {
      markedFiles: [],
      capabilities: ["reader_v2"],
    })).toEqual([]);
  });

  it("gives every id, path, flag and capability one owner", () => {
    const second = entry({
      id: "reader-canary",
      paths: ["src/lib/reader-shadow.ts"],
      flags: ["READER_CANARY"],
      capabilities: ["reader_v2"],
    });

    expect(check([
      entry({ flags: ["READER_CANARY"], capabilities: ["reader_v2"] }),
      second,
      entry({ paths: ["src/lib/reader.ts"] }),
    ], { flags: ["READER_CANARY"], capabilities: ["reader_v2"] })).toEqual([
      "duplicate src/lib/reader-shadow.ts",
      "duplicate READER_CANARY",
      "duplicate reader_v2",
      "duplicate reader-shadow",
    ]);
  });

  it("recognizes transitional files by name, and leaves their tests to them", () => {
    for (const file of [
      "src/lib/runs/tool-checkpoint-shadow.ts",
      "src/app/api/memory/semantic-shadow/route.ts",
      "src/lib/memory/Legacy-Ownership.ts",
      "src/lib/push/canary.tsx",
      "src/lib/work/compatibility.ts",
      "src/lib/memory/dormant.ts",
      "src/lib/api/deprecated.ts",
      "src/lib/api/retired.ts",
      "src/lib/rag/context-compiler-v2.ts",
      "src/components/push-canary-panel.module.css",
    ]) {
      expect(isComplexityMarkedPath(file), file).toBe(true);
    }
    for (const file of [
      "src/lib/runs/tool-checkpoint-shadow.test.ts",
      "src/lib/runs/shadow.spec.tsx",
      "src/lib/runs/__tests__/shadow.ts",
      "src/lib/rollouts/store.ts",
      "src/lib/tools/effect-receipt-v1.ts",
    ]) {
      expect(isComplexityMarkedPath(file), file).toBe(false);
    }
  });

  it("reads transitional flags from every environment access form", () => {
    expect(transitionalFlagsIn([
      'process.env.CHECKPOINT_RECOVERY_CANARY === "true";',
      "environment.OMNIAGENT_READER_SHADOW_DISABLED?.trim();",
      'env["READER_LEGACY_PATH"];',
      'const names = ["OMNIAGENT_ROUTE_ALLOW_FALLBACK"];',
      "process.env.READER_COMPATIBILITY_MODE;",
      "process.env.LEGACY_READER_MODE;",
      // Not transitional, or not an environment variable.
      "process.env.OMNIAGENT_MODEL;",
      'throw Object.assign(error, { code: "DATABASE_POOL_RETIRED" });',
      "process.env.CHECKPOINT_RECOVERY_CANARY;",
    ].join("\n"))).toEqual([
      "CHECKPOINT_RECOVERY_CANARY",
      "OMNIAGENT_READER_SHADOW_DISABLED",
      "READER_LEGACY_PATH",
      "OMNIAGENT_ROUTE_ALLOW_FALLBACK",
      "READER_COMPATIBILITY_MODE",
      "LEGACY_READER_MODE",
    ]);
  });

  it("reads exported capability ids, and routes that answer 410", () => {
    expect(capabilityIdsIn([
      'export const READER_CAPABILITY_ID = "reader_v2" as const;',
      "export const DRIVE_CAPABILITY_ID =",
      '  "source.drive.metadata";',
      'const PRIVATE_CAPABILITY_ID = "private";',
    ].join("\n"))).toEqual(["reader_v2", "source.drive.metadata"]);
    expect(answersGone("return NextResponse.json(body, { status: 410 });"))
      .toBe(true);
    expect(answersGone("return NextResponse.json(body, { status: 4100 });"))
      .toBe(false);
    expect(answersGone("return NextResponse.json(body, { status: 409 });"))
      .toBe(false);
  });
});
