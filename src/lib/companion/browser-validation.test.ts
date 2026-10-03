import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { companionChangeSchema, companionPreferencesSchema, companionThreadIdSchema } from "./contracts";
import {
  COMPANION_DESTINATIONS, COMPANION_INTENSITIES, COMPANION_MOTION, COMPANION_PREFERENCES_CONTRACT,
  DEFAULT_COMPANION_PREFERENCES, type CompanionChange, type CompanionPreferences, type CompanionPreferencesResponse,
} from "./model";
import {
  parseBrowserCompanionChange, parseBrowserCompanionConversation, parseBrowserCompanionEnvelope, parseBrowserCompanionPreferences,
} from "./browser-validation";

// Preserve the prior browser envelope as an independent Zod oracle. These schemas
// are test-only: production browser imports must not reach server runtime schemas.
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.string().datetime({ offset: true });
const receiptSchema = z.object({
  outcome: z.enum(["saved", "replayed"]), receiptId: z.string().regex(/^companion:[a-f0-9]{64}$/),
  revision: revision.min(1), savedAt: instant, preferences: companionPreferencesSchema,
}).strict();
const responseSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(COMPANION_PREFERENCES_CONTRACT),
  snapshot: z.object({ revision, persisted: z.boolean(), updatedAt: instant.nullable(), preferences: companionPreferencesSchema }).strict(),
  home: z.object({ state: z.enum(["not_set", "available", "unavailable", "unconfirmed"]), preferredThreadId: companionThreadIdSchema.nullable(),
    href: z.string().nullable(), fallbackHref: z.literal("/app/command") }).strict(),
  destination: z.object({ href: z.string(), state: z.enum(["configured", "fallback"]) }).strict(),
  mutation: receiptSchema.optional(),
}).strict();
const now = "2026-10-03T10:00:00.000Z";
const id = "11111111-1111-4111-8111-111111111111";
function envelope(): CompanionPreferencesResponse {
  return { schemaVersion: 1, contract: COMPANION_PREFERENCES_CONTRACT,
    snapshot: { revision: 1, persisted: true, updatedAt: now, preferences: { ...DEFAULT_COMPANION_PREFERENCES } },
    home: { state: "not_set", preferredThreadId: null, href: null, fallbackHref: "/app/command" },
    destination: { href: "/app/command", state: "configured" },
    mutation: { outcome: "saved", receiptId: `companion:${"a".repeat(64)}`, revision: 1, savedAt: now, preferences: { ...DEFAULT_COMPANION_PREFERENCES } } };
}
function agrees<T>(schema: z.ZodType<T>, parse: (input: unknown) => T | undefined, value: unknown) {
  const expected = schema.safeParse(value);
  expect(parse(value), JSON.stringify(value)).toEqual(expected.success ? expected.data : undefined);
}

describe("Companion browser validation stays aligned with server schemas", () => {
  it("keeps model types identical to the server's strict preference and change schemas", () => {
    expectTypeOf<z.infer<typeof companionPreferencesSchema>>().toEqualTypeOf<CompanionPreferences>();
    expectTypeOf<z.infer<typeof companionChangeSchema>>().toEqualTypeOf<CompanionChange>();
    expectTypeOf<z.infer<typeof responseSchema>>().toEqualTypeOf<CompanionPreferencesResponse>();
    expect(parseBrowserCompanionPreferences(DEFAULT_COMPANION_PREFERENCES)).toEqual(DEFAULT_COMPANION_PREFERENCES);
  });

  it("accepts every public enum combination without coercing invalid values", () => {
    for (const intensity of COMPANION_INTENSITIES) for (const motion of COMPANION_MOTION) for (const defaultDestination of COMPANION_DESTINATIONS) {
      agrees(companionPreferencesSchema, parseBrowserCompanionPreferences,
        { intensity, visible: false, motion, defaultDestination, preferredThreadId: id });
    }
    for (const field of ["intensity", "visible", "motion", "defaultDestination", "preferredThreadId"]) {
      for (const value of [undefined, null, true, false, 0, "", "unknown", [], {}]) {
        agrees(companionPreferencesSchema, parseBrowserCompanionPreferences, { ...DEFAULT_COMPANION_PREFERENCES, [field]: value });
      }
    }
  });

  it("matches UUID versions, variant bits, case, nil/max and malformed thread identities", () => {
    const ids = [null, id, id.toUpperCase(), "12345678-ABCD-8ABC-BDEF-123456789ABC",
      "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "11111111-1111-0111-8111-111111111111", "11111111-1111-9111-8111-111111111111",
      "11111111-1111-4111-7111-111111111111", "11111111-1111-4111-c111-111111111111",
      `${id}suffix`, ` ${id}`, `urn:uuid:${id}`, "opaque-thread", "", 1, {}, [id]];
    for (const preferredThreadId of ids) {
      agrees(companionPreferencesSchema, parseBrowserCompanionPreferences, { ...DEFAULT_COMPANION_PREFERENCES, preferredThreadId });
      const value = envelope();
      agrees(responseSchema, parseBrowserCompanionEnvelope, { ...value, home: { ...value.home, preferredThreadId } });
    }
    for (let version = 1; version <= 8; version += 1) {
      agrees(companionPreferencesSchema, parseBrowserCompanionPreferences,
        { ...DEFAULT_COMPANION_PREFERENCES, preferredThreadId: `11111111-1111-${version}111-8111-111111111111` });
    }
  });

  it("matches ISO offsets, optional precision and calendar validity without Date normalization", () => {
    const values: unknown[] = [now, "2026-10-03T10:00Z", "2026-10-03T10:00:00Z", "2026-10-03T10:00:00.123456789Z",
      "2026-10-03T10:00+05:30", "2026-10-03T10:00:00-23:59", "2026-10-03T10:00:00+00:00",
      "2026-10-03T10:00:00", "2026-10-03T10:00:00z", "2026-10-03T10:00:00+0530", "2026-10-03T10:00:00+24:00",
      "2026-10-03T10:00:00+01:60", "2026-10-03T24:00:00Z", "2026-10-03T10:60:00Z", "2026-10-03T10:00:60Z",
      "2026-10-03T10:00.123Z", "2026-10-03T10:00:00.Z", "2026-04-31T10:00:00Z", "2026-00-01T10:00Z",
      "2026-13-01T10:00Z", "2026-01-00T10:00Z", "2026-01-32T10:00Z", "2026-2-03T10:00Z", "2026-02-3T10:00Z",
      "+010000-01-01T00:00:00Z", "not-a-date", "", null, undefined, 0, {}];
    for (const year of ["0000", "0004", "0096", "0100", "0400", "1600", "1700", "1800", "1900", "2000", "2024", "2025", "2400", "9999"]) {
      values.push(`${year}-02-29T10:00:00Z`);
    }
    for (const updatedAt of values) {
      const value = envelope();
      agrees(responseSchema, parseBrowserCompanionEnvelope, { ...value, snapshot: { ...value.snapshot, updatedAt } });
      agrees(responseSchema, parseBrowserCompanionEnvelope, { ...value, mutation: { ...value.mutation!, savedAt: updatedAt } });
      const row = { id, tenantId: "tenant", actorId: "actor", title: "Conversation", mode: "learn", updatedAt };
      const expected = instant.safeParse(updatedAt).success ? { id, title: row.title, mode: row.mode, updatedAt } : undefined;
      expect(parseBrowserCompanionConversation(row, "tenant", "actor")).toEqual(expected);
    }
  });

  it("keeps revision and CAS bounds exact for saves, resets, snapshots and receipts", () => {
    for (const value of [-1, -0, 0, 1, 0.5, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN, "1", null, undefined]) {
      agrees(companionChangeSchema, parseBrowserCompanionChange, { action: "save", expectedRevision: value, preferences: DEFAULT_COMPANION_PREFERENCES });
      agrees(companionChangeSchema, parseBrowserCompanionChange, { action: "reset", expectedRevision: value });
      const response = envelope();
      agrees(responseSchema, parseBrowserCompanionEnvelope, { ...response, snapshot: { ...response.snapshot, revision: value } });
      agrees(responseSchema, parseBrowserCompanionEnvelope, { ...response, mutation: { ...response.mutation!, revision: value } });
    }
  });

  it("rejects missing and unknown fields at every strict envelope level", () => {
    const paths = [[], ["snapshot"], ["snapshot", "preferences"], ["home"], ["destination"], ["mutation"], ["mutation", "preferences"]];
    function at(root: unknown, path: string[]) {
      return path.reduce((current, key) => current[key] as Record<string, unknown>, root as Record<string, unknown>);
    }
    for (const path of paths) {
      for (const key of Object.keys(at(envelope(), path))) {
        const missing = envelope(); delete at(missing, path)[key];
        agrees(responseSchema, parseBrowserCompanionEnvelope, missing);
      }
      for (const unknown of ["unexpected", "constructor", "_executionScope"]) {
        const extra = envelope(); at(extra, path)[unknown] = "not public";
        agrees(responseSchema, parseBrowserCompanionEnvelope, extra);
        expect(parseBrowserCompanionEnvelope(extra)).toBeUndefined();
      }
    }
    for (const value of [undefined, null, false, 1, "response", [], [envelope()], {}]) {
      agrees(responseSchema, parseBrowserCompanionEnvelope, value);
    }
  });

  it("rejects unknown change fields and malformed actions without silently stripping a draft", () => {
    const save = { action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES } };
    const reset = { action: "reset", expectedRevision: 0 };
    for (const value of [save, reset, { ...save, action: "other" }, { ...save, expectedRevision: undefined },
      { ...save, unexpected: true }, { ...save, preferences: { ...save.preferences, unexpected: true } },
      { ...reset, preferences: save.preferences }, { ...reset, unexpected: true }, {}, [], null]) {
      agrees(companionChangeSchema, parseBrowserCompanionChange, value);
    }
  });

  it("validates every response discriminator and the complete receipt identity", () => {
    const fields = {
      schemaVersion: [0, 2, "1"], contract: ["", "asael-companion-preferences:2"],
    };
    for (const [key, values] of Object.entries(fields)) for (const value of values) agrees(responseSchema, parseBrowserCompanionEnvelope, { ...envelope(), [key]: value });
    for (const state of ["not_set", "available", "unavailable", "unconfirmed", "unknown", 0, null]) {
      const value = envelope(); agrees(responseSchema, parseBrowserCompanionEnvelope, { ...value, home: { ...value.home, state } });
    }
    for (const state of ["configured", "fallback", "unknown", 0, null]) {
      const value = envelope(); agrees(responseSchema, parseBrowserCompanionEnvelope, { ...value, destination: { ...value.destination, state } });
    }
    for (const outcome of ["saved", "replayed", "queued", "", 0, null]) {
      const value = envelope(); agrees(responseSchema, parseBrowserCompanionEnvelope, { ...value, mutation: { ...value.mutation!, outcome } });
    }
    for (const receiptId of [`companion:${"0".repeat(64)}`, `companion:${"F".repeat(64)}`, `companion:${"a".repeat(63)}`, `companion:${"a".repeat(65)}`, "companion:", id, null]) {
      const value = envelope(); agrees(responseSchema, parseBrowserCompanionEnvelope, { ...value, mutation: { ...value.mutation!, receiptId } });
    }
    for (const mutation of [undefined, null, {}, [], "saved"]) agrees(responseSchema, parseBrowserCompanionEnvelope, { ...envelope(), mutation });
  });

  it("returns detached projections instead of trusting mutable transport objects", () => {
    const input = envelope(); const parsed = parseBrowserCompanionEnvelope(input)!;
    expect(parsed).toEqual(input);
    for (const key of ["snapshot", "home", "destination", "mutation"] as const) expect(parsed[key]).not.toBe(input[key]);
    expect(parsed.snapshot.preferences).not.toBe(input.snapshot.preferences);
    expect(parsed.mutation!.preferences).not.toBe(input.mutation!.preferences);
    input.snapshot.preferences.intensity = "quiet"; input.mutation!.preferences.visible = false;
    expect(parsed.snapshot.preferences.intensity).toBe("balanced"); expect(parsed.mutation!.preferences.visible).toBe(true);
    const change = { action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES } };
    const result = parseBrowserCompanionChange(change)!;
    expect(result).not.toBe(change); expect(result.action === "save" && result.preferences).not.toBe(change.preferences);
  });

  it("preserves owned thread projection and its exact metadata bounds while omitting private fields", () => {
    const schema = z.object({ id: companionThreadIdSchema, tenantId: z.literal("tenant"), actorId: z.literal("actor"),
      title: z.string().min(1).max(2_000), updatedAt: instant, mode: z.enum(["orchestrate", "research", "execute", "learn"]) });
    const row = { id, tenantId: "tenant", actorId: "actor", title: "Conversation", updatedAt: now, mode: "orchestrate", privateBody: "omit" };
    const variants: unknown[] = [row, { ...row, tenantId: "other" }, { ...row, actorId: "other" }, null, {}, []];
    for (const title of ["", "x", " ", "x".repeat(2_000), "x".repeat(2_001), 1, null]) variants.push({ ...row, title });
    for (const mode of ["orchestrate", "research", "execute", "learn", "unknown", null, 1]) variants.push({ ...row, mode });
    for (const key of Object.keys(row)) { const missing: Record<string, unknown> = { ...row }; delete missing[key]; variants.push(missing); }
    for (const value of variants) {
      const expected = schema.safeParse(value);
      const projection = expected.success ? { id: expected.data.id, title: expected.data.title, updatedAt: expected.data.updatedAt, mode: expected.data.mode } : undefined;
      expect(parseBrowserCompanionConversation(value, "tenant", "actor")).toEqual(projection);
    }
  });
});
