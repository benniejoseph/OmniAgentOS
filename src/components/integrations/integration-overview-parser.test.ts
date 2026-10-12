import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { truthfulIntegrationsOverviewSchema, type TruthfulIntegrationsOverview } from "@/lib/connectors/truthful-overview";
import { parseIntegrationOverview } from "./integration-overview-parser";

const timestamp = "2026-10-04T12:30:00.123+05:30";
function fixture(): TruthfulIntegrationsOverview {
  const inventory = () => ({ state: "ready" as const, detail: "Read succeeded." });
  return {
    version: "p11.7-truthful-integrations:1", generatedAt: timestamp, state: "ready",
    disclosure: { catalogSuggestions: "separate_from_installed", credentialValuesIncluded: false,
      rawCursorValuesIncluded: false, providerContentIncluded: false, costBasis: "recorded_attributable_usage_only" },
    summary: { installed: 1, working: 1, degraded: 0, actionRequired: 0, unavailable: 0, suggestions: 1 },
    inventory: { oauth: inventory(), mcp: inventory(), openapi: inventory(), usage: inventory() },
    installed: [{
      id: "google:0f5c2a8e-6d3b-4c1a-9e7f-2b8d4a6c1e90:gmail", name: "Gmail", kind: "google_service", adapter: "native", category: "communication",
      installation: "installed", state: "working", configured: true, connected: true, manageable: true,
      account: { connectionId: "0f5c2a8e-6d3b-4c1a-9e7f-2b8d4a6c1e90", email: "owner@example.test", label: "Personal", purpose: "personal" },
      permissions: { mode: "write_approval_required", granted: ["Read mail"], missing: ["Optional permission"], activeOperations: 2, pendingReviewOperations: 0, disabledOperations: 0, approvalRequiredOperations: 1 },
      sync: { supported: true, status: "current", coverage: "complete", coverageDetail: "Owner-scoped checkpoint.",
        cursor: { state: "checkpointed", detail: "No raw provider cursor.", rawValueIncluded: false }, lastSuccessfulAt: timestamp,
        freshness: { state: "current", ageSeconds: 1, staleAfterSeconds: 7200 } },
      failure: { state: "none", code: null, message: "No failure.", recovery: "No recovery required." },
      cost: { periodDays: 30, state: "unknown", knownEstimatedCostMicrousd: null, knownCalls: 0, unknownCalls: 1, detail: "Provider charges are unknown." },
      nextAction: "Review the next checkpoint.", updatedAt: timestamp, manageHref: "/app/integrations?connection=full-id",
    }],
    suggestions: [{ id: "slack", name: "Slack", adapter: "mcp", category: "communication", state: "credentials_required", capabilities: ["Search messages"], installed: false, detail: "Connect an account first." }],
  };
}
type Path = (string | number)[];
function at(value: unknown, path: Path): unknown {
  return path.reduce<unknown>((item, key) => (item as Record<string | number, unknown>)[key], value);
}
function change(path: Path, value: unknown) {
  const next = fixture();
  (at(next, path.slice(0, -1)) as Record<string | number, unknown>)[path.at(-1)!] = value;
  return next;
}
function paths(value: unknown, prefix: Path = []): Path[] {
  if (value === null || typeof value !== "object") return [prefix];
  return [prefix, ...Object.entries(value).flatMap(([key, item]) => paths(item, [...prefix, Array.isArray(value) ? Number(key) : key]))];
}
function parity(value: unknown, label = "overview") {
  const server = truthfulIntegrationsOverviewSchema.safeParse(value);
  const browser = parseIntegrationOverview(value);
  expect(browser.success, label).toBe(server.success);
  if (server.success && browser.success) expect(browser.data, label).toStrictEqual(server.data);
  return browser;
}

describe("compact integration overview parser", () => {
  it("returns a normalized fresh projection without retaining mutable input", () => {
    const input = fixture(); input.installed[0].account!.label = " \t Work account \u00a0";
    const result = parity(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.installed[0].account!.label).toBe("Work account");
    expect(input.installed[0].account!.label).not.toBe("Work account");
    input.installed[0].permissions.granted.push("Later edit");
    expect(result.data.installed[0].permissions.granted).toEqual(["Read mail"]);
    expect(result.data.inventory).not.toBe(input.inventory);
  });
  it("matches required, optional, nullable and wrong-type behavior at every nested path", () => {
    const initial = fixture();
    for (const path of paths(initial)) {
      for (const value of [undefined, null, true, false, 0, "", [], {}]) {
        parity(path.length ? change(path, value) : value, `${path.join(".")} = ${String(value)}`);
      }
      if (path.length) {
        const missing = fixture();
        delete (at(missing, path.slice(0, -1)) as Record<string | number, unknown>)[path.at(-1)!];
        parity(missing, `${path.join(".")} missing`);
      }
    }
    const noAccount = fixture(); delete noAccount.installed[0].account;
    expect(parity(noAccount).success).toBe(true);
    expect(parity(change(["installed", 0, "account"], undefined)).success).toBe(true);
    expect(parity(change(["installed", 0, "account"], null)).success).toBe(false);
  });
  it("rejects unknown keys at every strict object and safely drops Zod's reserved prototype key", () => {
    for (const path of paths(fixture())) {
      const original = at(fixture(), path);
      if (!original || typeof original !== "object" || Array.isArray(original)) continue;
      for (const extra of ["unexpected", "constructor", "toString"]) {
        const input = fixture(); (at(input, path) as Record<string, unknown>)[extra] = "extra";
        expect(parity(input, `${path.join(".")}.${extra}`).success).toBe(false);
      }
      const input = fixture();
      Object.defineProperty(at(input, path), "__proto__", { value: { leaked: true }, enumerable: true });
      const result = parity(input, `${path.join(".")} reserved prototype key`);
      expect(result.success).toBe(true);
      if (result.success) expect(Object.hasOwn(at(result.data, path) as object, "__proto__")).toBe(false);
    }
  });
  it("preserves every string length boundary and only trims account labels", () => {
    const bounded: [Path, number][] = [
      [["installed", 0, "id"], 240], [["installed", 0, "name"], 160], [["installed", 0, "account", "label"], 80],
      [["installed", 0, "permissions", "granted", 0], 160], [["installed", 0, "permissions", "missing", 0], 160],
      [["installed", 0, "failure", "code"], 80], [["installed", 0, "failure", "message"], 500], [["installed", 0, "failure", "recovery"], 500],
      [["installed", 0, "sync", "coverageDetail"], 500], [["installed", 0, "sync", "cursor", "detail"], 500],
      [["installed", 0, "cost", "detail"], 500], [["installed", 0, "nextAction"], 500],
      [["suggestions", 0, "id"], 160], [["suggestions", 0, "name"], 160], [["suggestions", 0, "detail"], 500], [["suggestions", 0, "capabilities", 0], 100],
      ...["oauth", "mcp", "openapi", "usage"].map((name): [Path, number] => [["inventory", name, "detail"], 240]),
    ];
    for (const [path, maximum] of bounded) {
      for (const text of ["", " ", "x", "x".repeat(maximum), "x".repeat(maximum + 1), ` ${"x".repeat(maximum)} `, "\u0000", "💡".repeat(maximum / 2)]) {
        parity(change(path, text), `${path.join(".")} length ${text.length}`);
      }
    }
    for (const href of ["/app/", "/app/x", `/app/${"a".repeat(235)}`, `/app/${"a".repeat(236)}`, "https://other.test/app/", "//other.test/app/", "/application/", "/app/../x"]) {
      parity(change(["installed", 0, "manageHref"], href), href);
    }
  });
  it("preserves each array bound and rejects sparse or invalid entries", () => {
    for (const [path, maximum] of [
      [["installed"], 200], [["suggestions"], 100], [["installed", 0, "permissions", "granted"], 32],
      [["installed", 0, "permissions", "missing"], 32], [["suggestions", 0, "capabilities"], 12],
    ] as [Path, number][]) {
      const item = (at(fixture(), path) as unknown[])[0];
      for (const length of [0, maximum, maximum + 1]) parity(change(path, Array.from({ length }, () => structuredClone(item))), `${path.join(".")} count ${length}`);
      parity(change(path, Array(1)), `${path.join(".")} sparse`);
      parity(change(path, [null]), `${path.join(".")} null entry`);
    }
  });
  it("retains safe integer and nullable accounting semantics without inventing total consistency", () => {
    for (const path of paths(fixture()).filter((path) => typeof at(fixture(), path) === "number")) {
      for (const value of [-1, -0, 0, .5, 30, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN]) parity(change(path, value), `${path.join(".")} ${value}`);
    }
    for (const path of [["installed", 0, "cost", "knownEstimatedCostMicrousd"], ["installed", 0, "sync", "freshness", "ageSeconds"], ["installed", 0, "sync", "freshness", "staleAfterSeconds"]] as Path[]) {
      for (const value of [null, -1, .5, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN]) parity(change(path, value));
    }
    expect(parity(change(["summary", "installed"], 199)).success).toBe(true);
  });
  it("matches RFC UUID versions, variants, nil and maximum special values", () => {
    for (const id of [
      "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      ...Array.from({ length: 10 }, (_, version) => `0f5c2a8e-6d3b-${version}c1a-9e7f-2b8d4a6c1e90`),
      ...["0", "7", "8", "9", "a", "b", "c", "f"].map((variant) => `0f5c2a8e-6d3b-4c1a-${variant}e7f-2b8d4a6c1e90`),
      "0F5C2A8E-6D3B-4C1A-9E7F-2B8D4A6C1E90", " 0f5c2a8e-6d3b-4c1a-9e7f-2b8d4a6c1e90", "0f5c2a8e-6d3b-4c1a-9e7f-2b8d4a6c1e90\n", "not-a-uuid",
    ]) parity(change(["installed", 0, "account", "connectionId"], id), id);
  });
  it("matches practical email syntax, UTF16 length and nullable emails", () => {
    for (const email of [null, "a@example.test", "OWNER+notes@example.test", "o'connor@example.test", "a@domain-.test", "a@x.a", ".a@example.test", "a..b@example.test", "a.@example.test", "a@-domain.test", "a@localhost", '"quoted"@example.test', "é@example.test", "a@example.test\n", ` ${"a@example.test"}`, `${"a".repeat(307)}@example.test`, `${"a".repeat(308)}@example.test`]) {
      parity(change(["installed", 0, "account", "email"], email), String(email));
    }
  });
  it("matches real calendar days, leap centuries, time precision and offset bounds", () => {
    const dates = [
      "0000-02-29T00:00Z", "0001-02-29T00:00Z", "1900-02-29T12:30:00Z", "2000-02-29T12:30:00Z", "2100-02-29T12:30:00Z",
      "2024-02-29T23:59:59.123456789Z", "2026-02-29T12:30Z", "2026-04-31T00:00Z", "2026-12-31T23:59Z", "9999-12-31T23:59:59-23:59",
      "2026-10-04T12:30+00:00", "2026-10-04T12:30-00:00", "2026-10-04T12:30+23:59", "2026-10-04T12:30+24:00", "2026-10-04T12:30+05:60",
      "2026-10-04T12:30+0530", "2026-10-04T12:30", "2026-10-04t12:30z", "2026-10-04T24:00Z", "2026-10-04T23:59:60Z", "2026-10-04T12:30.5Z",
      "2026-00-01T12:00Z", "2026-13-01T12:00Z", "2026-10-00T12:00Z", "2026-10-04T12:30:00.Z", "2026-10-04T12:30:00Z\n", "2026-10-04T12:30:00Z\r\n",
    ];
    for (const path of [["generatedAt"], ["installed", 0, "updatedAt"], ["installed", 0, "sync", "lastSuccessfulAt"]] as Path[]) {
      for (const date of dates) parity(change(path, date), `${path.join(".")} ${date}`);
    }
  });
  it("keeps literal claims exact at every disclosure and installed/cost boundary", () => {
    for (const path of [["version"], ...Object.keys(fixture().disclosure).map((key) => ["disclosure", key]),
      ["installed", 0, "sync", "cursor", "rawValueIncluded"], ["installed", 0, "cost", "periodDays"], ["suggestions", 0, "installed"]] as Path[]) {
      for (const value of [true, false, 0, 1, 30, "false", "p11.7-truthful-integrations:2", "unknown"]) parity(change(path, value), path.join("."));
    }
  });
  it("accepts every authoritative enum member and rejects near misses", () => {
    const root = truthfulIntegrationsOverviewSchema.shape;
    const item = root.installed.element.shape;
    const suggestion = root.suggestions.element.shape;
    const fields: [string, readonly string[]][] = [
      ["state", root.state.options],
      ...["oauth", "mcp", "openapi", "usage"].map((key): [string, readonly string[]] => [`inventory.${key}.state`, root.inventory.shape.oauth.shape.state.options]),
      ["installed.0.kind", item.kind.options], ["installed.0.adapter", item.adapter.options], ["installed.0.category", item.category.options],
      ["installed.0.installation", item.installation.options], ["installed.0.state", item.state.options],
      ["installed.0.account.purpose", item.account.unwrap().shape.purpose.options], ["installed.0.permissions.mode", item.permissions.shape.mode.options],
      ["installed.0.sync.status", item.sync.shape.status.options], ["installed.0.sync.coverage", item.sync.shape.coverage.options],
      ["installed.0.sync.cursor.state", item.sync.shape.cursor.shape.state.options], ["installed.0.sync.freshness.state", item.sync.shape.freshness.shape.state.options],
      ["installed.0.failure.state", item.failure.shape.state.options], ["installed.0.cost.state", item.cost.shape.state.options],
      ["suggestions.0.adapter", suggestion.adapter.options], ["suggestions.0.category", suggestion.category.options], ["suggestions.0.state", suggestion.state.options],
    ];
    for (const [field, members] of fields) {
      for (const value of members) expect(parity(change(field.split("."), value), `${field} ${value}`).success).toBe(true);
      for (const value of ["unknown-new-enum", ` ${members[0]}`, members[0].toUpperCase()]) {
        expect(parity(change(field.split("."), value), `${field} ${value}`).success).toBe(false);
      }
    }
  });
  it("does not pull the authoritative runtime module or Zod into the browser boundary", () => {
    const source = readFileSync(new URL("./integration-overview-parser.ts", import.meta.url), "utf8");
    const runtimeImports = source.split("\n").filter((line) => /^import\s/.test(line) && !/^import\s+type\s/.test(line));
    expect(runtimeImports).toEqual([]);
    expect(source).not.toMatch(/\b(?:require|import)\s*\(/);
  });
});
