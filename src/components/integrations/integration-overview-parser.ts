import type { TruthfulIntegrationsOverview } from "@/lib/connectors/truthful-overview";

// Browser projection of truthfulIntegrationsOverviewSchema. Keep the server
// authoritative and prove acceptance + normalized output parity in the adjacent
// differential tests. This module has no runtime dependency on Zod or stores.
type Read = (value: unknown) => unknown;
const invalid = (): never => { throw new TypeError("Unsupported integration overview."); };
const string = (min: number, max: number, trim = false): Read => (input) => {
  if (typeof input !== "string") return invalid();
  const value = trim ? input.trim() : input;
  return value.length >= min && value.length <= max ? value : invalid();
};
const literal = (expected: string | number | boolean): Read => (value) => value === expected ? value : invalid();
const enumeration = (...values: string[]): Read => (value) => typeof value === "string" && values.includes(value) ? value : invalid();
const boolean: Read = (value) => typeof value === "boolean" ? value : invalid();
const count: Read = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const nullable = (read: Read): Read => (value) => value === null ? null : read(value);
const optional = (read: Read): Read => (value) => value === undefined ? undefined : read(value);
const array = (read: Read, maximum: number): Read => (value) => {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) output.push(read(value[index]));
  return output;
};
const object = (shape: Record<string, Read>): Read => (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  for (const key in input) {
    // Zod 4 drops this reserved key instead of assigning a result prototype.
    if (key !== "__proto__" && !Object.hasOwn(shape, key)) return invalid();
  }
  const output: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(shape)) {
    const parsed = read(input[key]);
    if (parsed !== undefined || key in input) output[key] = parsed;
  }
  return output;
};

// Match the installed Zod 4.4.3 formats, including nil/max UUIDs, its practical
// email grammar, minute-precision times and offsets up to 23:59. Date.parse is
// deliberately not used: it normalizes impossible calendar dates.
const uuidPattern = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const emailPattern = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const uuid: Read = (value) => typeof value === "string" && uuidPattern.test(value) ? value : invalid();
const email: Read = (value) => typeof value === "string" && value.length <= 320 && emailPattern.test(value) ? value : invalid();
const timestamp: Read = (value) => {
  const match = typeof value === "string" ? timestampPattern.exec(value) : null;
  if (!match) return invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximum = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return maximum !== undefined && day >= 1 && day <= maximum ? value : invalid();
};

const detail = string(1, 500);
const adapter = enumeration("native", "mcp", "openapi");
const category = enumeration("code", "communication", "knowledge", "data", "automation", "browser");
const inventory = object({ state: enumeration("ready", "unavailable"), detail: string(1, 240) });
const failure = object({ state: enumeration("none", "present", "unknown"), code: nullable(string(1, 80)), message: detail, recovery: detail });
const sync = object({
  supported: boolean,
  status: enumeration("not_applicable", "not_started", "syncing", "current", "stale", "partial", "error", "unavailable"),
  coverage: enumeration("not_applicable", "none", "partial", "complete", "unknown"),
  coverageDetail: detail,
  cursor: object({ state: enumeration("not_applicable", "not_started", "advancing", "checkpointed", "unknown", "unavailable"), detail, rawValueIncluded: literal(false) }),
  lastSuccessfulAt: nullable(timestamp),
  freshness: object({ state: enumeration("not_applicable", "never", "current", "stale", "unavailable"), ageSeconds: nullable(count), staleAfterSeconds: nullable(count) }),
});
const cost = object({
  periodDays: literal(30), state: enumeration("known", "partial", "unknown", "no_recorded_activity", "unavailable"),
  knownEstimatedCostMicrousd: nullable(count), knownCalls: count, unknownCalls: count, detail,
});
const installed = object({
  id: string(1, 240), name: string(1, 160), kind: enumeration("google_service", "mcp", "openapi"),
  adapter, category, installation: enumeration("installed", "retained_read_only"),
  state: enumeration("working", "degraded", "action_required", "unavailable"), configured: nullable(boolean), connected: boolean, manageable: boolean,
  account: optional(object({ connectionId: uuid, email: nullable(email), label: string(1, 80, true), purpose: enumeration("personal", "work") })),
  permissions: object({
    mode: enumeration("no_access", "read_only", "read_write", "write_approval_required", "unclassified"),
    granted: array(string(1, 160), 32), missing: array(string(1, 160), 32), activeOperations: count,
    pendingReviewOperations: count, disabledOperations: count, approvalRequiredOperations: count,
  }),
  sync, failure, cost, nextAction: detail, updatedAt: nullable(timestamp),
  manageHref: (value) => typeof value === "string" && value.startsWith("/app/") && value.length <= 240 ? value : invalid(),
});
const suggestion = object({
  id: string(1, 160), name: string(1, 160), adapter, category,
  state: enumeration("setup_available", "credentials_required", "configuration_required", "planned", "availability_unknown"),
  capabilities: array(string(1, 100), 12), installed: literal(false), detail,
});
const overview = object({
  version: literal("p11.7-truthful-integrations:1"), generatedAt: timestamp, state: enumeration("ready", "partial", "empty"),
  disclosure: object({ catalogSuggestions: literal("separate_from_installed"), credentialValuesIncluded: literal(false),
    rawCursorValuesIncluded: literal(false), providerContentIncluded: literal(false), costBasis: literal("recorded_attributable_usage_only") }),
  summary: object({ installed: count, working: count, degraded: count, actionRequired: count, unavailable: count, suggestions: count }),
  inventory: object({ oauth: inventory, mcp: inventory, openapi: inventory, usage: inventory }),
  installed: array(installed, 200), suggestions: array(suggestion, 100),
});

export function parseIntegrationOverview(value: unknown):
  | { success: true; data: TruthfulIntegrationsOverview }
  | { success: false } {
  try { return { success: true, data: overview(value) as TruthfulIntegrationsOverview }; }
  catch { return { success: false }; }
}
