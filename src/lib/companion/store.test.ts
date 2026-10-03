import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPANION_PREFERENCES, type CompanionChange } from "@/lib/companion/contracts";

const database = vi.hoisted(() => ({ hasDatabaseUrl: vi.fn(), getSql: vi.fn(), ensureDatabaseSchema: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ ...database, runWithDatabaseActorScope: (_tenant: string, _actors: string[], operation: () => unknown) => operation() }));
import { changeCompanionPreferences, readCompanionPreferences } from "@/lib/companion/store";

const owner = { tenantId: "tenant-a", actorId: "owner@example.test" };
const change: CompanionChange = { action: "save", expectedRevision: 0, preferences: { ...DEFAULT_COMPANION_PREFERENCES, intensity: "quiet" } };
const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const binding = { version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId,
  legacyOwnerActorIds: [owner.actorId], readableOwnerActorIds: [canonicalActorId, owner.actorId] };

describe("Companion local persistence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "asael-companion-fixture-"));
    vi.stubEnv("OMNIAGENT_DATA_DIR", directory);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    database.hasDatabaseUrl.mockReset().mockReturnValue(false);
    database.getSql.mockReset();
    database.ensureDatabaseSchema.mockReset();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

  it("returns missing preferences without creating files, rows, or database work", async () => {
    expect(await readCompanionPreferences(owner)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
    expect(database.getSql).not.toHaveBeenCalled();
    expect(database.ensureDatabaseSchema).not.toHaveBeenCalled();
  });

  it("persists the exact owner, separates tenant and actor records, and records one receipt per accepted request", async () => {
    const saved = await changeCompanionPreferences(owner, change, "save-a");
    expect(await readCompanionPreferences(owner)).toEqual(saved.current);
    expect(await readCompanionPreferences({ ...owner, actorId: "other-owner" })).toBeUndefined();
    expect(await readCompanionPreferences({ ...owner, tenantId: "tenant-b" })).toBeUndefined();
    await changeCompanionPreferences({ ...owner, tenantId: "tenant-b" }, change, "save-a");
    const ledger = JSON.parse(await readFile(path.join(directory, "companion-preferences.json"), "utf8"));
    expect(ledger.preferences).toHaveLength(2);
    expect(ledger.mutations).toHaveLength(2);
    expect(ledger.mutations[0].id).not.toBe(ledger.mutations[1].id);
    expect(JSON.stringify(ledger)).not.toContain('"save-a"');
  });

  it("makes simultaneous expected-revision saves a single winner without losing the accepted receipt", async () => {
    const results = await Promise.allSettled([
      changeCompanionPreferences(owner, change, "save-a"),
      changeCompanionPreferences(owner, { ...change, preferences: { ...change.preferences, visible: false } }, "save-b"),
    ]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((value) => value.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: "companion_revision_conflict" });
    const ledger = JSON.parse(await readFile(path.join(directory, "companion-preferences.json"), "utf8"));
    expect(ledger.preferences).toHaveLength(1);
    expect(ledger.preferences[0].revision).toBe(1);
    expect(ledger.mutations).toHaveLength(1);
  });

  it("replays simultaneous identical submissions once and preserves newer current settings on later retry", async () => {
    const [first, second] = await Promise.all([
      changeCompanionPreferences(owner, change, "save-a"), changeCompanionPreferences(owner, change, "save-a"),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.receipt).toEqual(second.receipt);
    await changeCompanionPreferences(owner, { action: "reset", expectedRevision: 1 }, "reset-a");
    const replay = await changeCompanionPreferences(owner, change, "save-a");
    expect(replay.current.revision).toBe(2);
    expect(replay.current.preferences).toEqual(DEFAULT_COMPANION_PREFERENCES);
    expect(replay.receipt).toEqual(first.receipt);
    const ledger = JSON.parse(await readFile(path.join(directory, "companion-preferences.json"), "utf8"));
    expect(ledger.mutations).toHaveLength(2);
  });

  it("writes a validated canonical owner, remains readable after exact email change, and rejects ambiguous aliases", async () => {
    const bound = { ...owner, requestActorBinding: binding };
    const canonical = await changeCompanionPreferences(bound, change, "canonical-save");
    expect(canonical.current.actorId).toBe(canonicalActorId);
    const changedEmail = "renamed@example.test";
    expect(await readCompanionPreferences({ ...owner, actorId: changedEmail, requestActorBinding: {
      ...binding, legacyOwnerActorIds: [changedEmail], readableOwnerActorIds: [canonicalActorId, changedEmail],
    } })).toEqual(canonical.current);
    expect(await readCompanionPreferences(owner)).toBeUndefined();
    await changeCompanionPreferences(owner, change, "exact-save");
    await expect(readCompanionPreferences(bound)).rejects.toMatchObject({ status: 409, code: "companion_owner_conflict" });
    await expect(changeCompanionPreferences(bound, { action: "reset", expectedRevision: 1 }, "reset-conflict")).rejects.toMatchObject({ code: "companion_owner_conflict" });
  });

  it("preserves an existing exact-owner row when a canonical binding is later introduced", async () => {
    await changeCompanionPreferences(owner, change, "save-a");
    const saved = await changeCompanionPreferences({ ...owner, requestActorBinding: binding }, { action: "reset", expectedRevision: 1 }, "reset-a");
    expect(saved.current.actorId).toBe(owner.actorId);
    expect(saved.current.revision).toBe(2);
    expect(await readCompanionPreferences(owner)).toEqual(saved.current);
  });

  it("keeps corrupt or invalid stored data intact and never silently resets preferences", async () => {
    const file = path.join(directory, "companion-preferences.json");
    await writeFile(file, "{ corrupt fixture");
    await expect(readCompanionPreferences(owner)).rejects.toMatchObject({ code: "companion_storage_invalid" });
    await expect(changeCompanionPreferences(owner, change, "save-a")).rejects.toMatchObject({ code: "companion_storage_invalid" });
    expect(await readFile(file, "utf8")).toBe("{ corrupt fixture");
    expect(await readdir(directory)).toEqual(["companion-preferences.json"]);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, preferences: [{ ...owner, revision: 99 }], mutations: [] }));
    await expect(readCompanionPreferences(owner)).rejects.toMatchObject({ code: "companion_storage_invalid" });
  });

  it("refuses ephemeral production storage and never falls back after a configured database failure", async () => {
    vi.stubEnv("VERCEL", "1");
    await expect(readCompanionPreferences(owner)).rejects.toMatchObject({ code: "companion_storage_unavailable" });
    await expect(changeCompanionPreferences(owner, change, "save-a")).rejects.toMatchObject({ code: "companion_storage_unavailable" });
    database.hasDatabaseUrl.mockReturnValue(true);
    database.ensureDatabaseSchema.mockRejectedValue(new Error("database unavailable"));
    await expect(readCompanionPreferences(owner)).rejects.toThrow("database unavailable");
    expect(await readdir(directory)).toEqual([]);
  });
});
