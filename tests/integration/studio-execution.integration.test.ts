/** Opt-in local PostgreSQL proof. No live generation or production data. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SecurityContext } from "@/lib/security/types";
import {
  closeDatabaseClient,
  getSql,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  createStudioFlow,
  getStudioFlow,
  getStudioRun,
  quoteStudioFlow,
  submitStudioRun,
  updateStudioFlow,
} from "@/lib/studio/service";
import { advanceStudioRun } from "@/lib/studio/advance";
import { STUDIO_CAPABILITIES } from "@/lib/studio/capabilities";
import { createStudioTemplate } from "@/lib/studio/templates";
import { studioOwner } from "@/lib/studio/authority";
import { readStudioAssetBytes } from "@/lib/studio/assets";
import { withStudioTransaction } from "@/lib/studio/store";
import { reserveStudioBudget } from "@/lib/studio/budget";
import { parseSqlMigrationFile } from "@/lib/db/sql-migration-files";
import type { StoredRun } from "@/lib/studio/server-types";

const state = vi.hoisted(() => ({
  serving: false,
  storageErrors: [] as string[],
}));
vi.mock("@/lib/db/client", async (original) => {
  const actual = await original<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    ensureDatabaseSchema: () =>
      state.serving ? Promise.resolve() : actual.ensureDatabaseSchema(),
  };
});
vi.mock("@/lib/capture/assets", async (original) => {
  const actual = await original<typeof import("@/lib/capture/assets")>();
  return {
    ...actual,
    getCaptureAssetContent: async (
      ...args: Parameters<typeof actual.getCaptureAssetContent>
    ) => {
      try {
        return await actual.getCaptureAssetContent(...args);
      } catch (error) {
        state.storageErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
    saveCaptureAsset: async (
      ...args: Parameters<typeof actual.saveCaptureAsset>
    ) => {
      try {
        return await actual.saveCaptureAsset(...args);
      } catch (error) {
        state.storageErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
  };
});
vi.mock("@/lib/studio/providers", async (original) => {
  const actual = await original<typeof import("@/lib/studio/providers")>();
  return {
    ...actual,
    resolveStudioCapabilities: async () =>
      STUDIO_CAPABILITIES.filter((c) => c.demo),
  };
});
const enabled = process.env.ASAEL_STUDIO_CANDIDATE_DATABASE === "1";
const candidate = enabled ? describe : describe.skip;
const tenantId = `studio-candidate-${randomUUID()}`;
const userId = randomUUID(),
  email = `${userId}@example.test`,
  actorId = `actor:${userId}`;
const otherId = randomUUID(),
  otherEmail = `${otherId}@example.test`,
  otherActor = `actor:${otherId}`;
const runtimeRole = `studio_candidate_${randomBytes(6).toString("hex")}`;
const context: SecurityContext = {
  tenantId,
  actorId: email,
  source: "session",
  role: "operator",
  auth: {
    userId,
    email,
    sessionId: "isolated-no-login",
    tenantName: "Studio candidate",
  },
};
const other: SecurityContext = {
  ...context,
  actorId: otherEmail,
  auth: { ...context.auth!, userId: otherId, email: otherEmail },
};
const evidence: Record<string, unknown> = {
  tenantId,
  scenario:
    "Studio real queue, persisted image/video, scoped runtime, immutable snapshot and revocation",
  provider: "fixed demo fixtures",
  storage: "loopback PostgreSQL",
};
const scoped = <T>(run: () => Promise<T>) =>
  runWithDatabaseActorScope(tenantId, [actorId, email], run);

candidate("Studio PostgreSQL candidate", () => {
  let admin: ReturnType<typeof postgres>;
  let created = false;
  beforeAll(async () => {
    const address = process.env.ASAEL_STUDIO_CANDIDATE_DATABASE_URL;
    if (!address)
      throw new Error(
        "Set ASAEL_STUDIO_CANDIDATE_DATABASE_URL for the isolated test.",
      );
    const url = new URL(address);
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "55439" ||
      url.pathname !== "/asael_studio_candidate"
    )
      throw new Error(
        "Only the disposable loopback Studio candidate database is allowed.",
      );
    await closeDatabaseClient();
    admin = postgres(address, {
      ssl: false,
      prepare: false,
      max: 2,
      onnotice: () => undefined,
    });
    expect(
      (
        await admin`SELECT version FROM omni_schema_version ORDER BY version DESC LIMIT 1`
      )[0].version,
    ).toBe(261);
    expect(
      (
        await admin`SELECT to_regclass('omni_studio_budget_reservations') AS name`
      )[0].name,
    ).toBe("omni_studio_budget_reservations");
    const password = randomBytes(24).toString("hex");
    await admin.unsafe(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS IN ROLE omni_runtime`,
    );
    created = true;
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
    // Early legacy tables predate named migration grants; this matches the explicit
    // queue/event fixture bootstrap used by responsibility integration tests. New
    // Studio tables/functions use only their migration grants. Auth/workspace
    // tables are deliberately NOT granted to this role.
    await admin.unsafe(
      `GRANT SELECT,INSERT,UPDATE ON omni_operation_jobs,omni_capture_assets,omni_events,omni_ai_usage TO ${runtimeRole}`,
    );
    // Existing generic-event RLS references these parent tables even for capture streams.
    await admin.unsafe(
      `GRANT SELECT ON omni_agent_runs,omni_tool_executions,omni_tenant_capability_rollouts TO ${runtimeRole}`,
    );
    await admin.unsafe(
      `GRANT USAGE,SELECT ON SEQUENCE omni_events_seq_seq TO ${runtimeRole}`,
    );
    await admin`INSERT INTO omni_auth_tenants(id,name,slug) VALUES(${tenantId},'Studio candidate',${tenantId})`;
    for (const [id, address] of [
      [userId, email],
      [otherId, otherEmail],
    ]) {
      await admin`INSERT INTO omni_auth_users(id,email,password_hash) VALUES(${id},${address},'synthetic-no-login')`;
      await admin`INSERT INTO omni_auth_memberships(id,tenant_id,user_id,role) VALUES(${randomUUID()},${tenantId},${id},'operator')`;
    }
    url.username = runtimeRole;
    url.password = password;
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("OMNIAGENT_DATABASE_POOL_MAX", "1");
    state.serving = true;
    await scoped(
      () =>
        getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${email})`,
    );
    await runWithDatabaseActorScope(
      tenantId,
      [otherActor, otherEmail],
      () =>
        getSql()`SELECT * FROM omni_ensure_personal_workspace_v1(${tenantId},${otherEmail})`,
    );
    evidence.rls = await scoped(
      async () =>
        (
          await getSql()`SELECT rolsuper,rolbypassrls,row_security_active('omni_studio_records') AS active FROM pg_roles WHERE rolname=current_user`
        )[0],
    );
    expect(evidence.rls).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      active: true,
    });
  });
  afterAll(async () => {
    if (admin) {
      evidence.jobs =
        await admin`SELECT type,status,last_error FROM omni_operation_jobs WHERE tenant_id=${tenantId}`;
      evidence.reservations =
        await admin`SELECT maximum_microusd,created_at FROM omni_studio_budget_reservations WHERE tenant_id=${tenantId}`;
      await closeDatabaseClient();
      if (created) {
        await admin.unsafe(`DROP OWNED BY ${runtimeRole}`);
        await admin.unsafe(`DROP ROLE ${runtimeRole}`);
      }
      await admin.end();
    }
    if (process.env.ASAEL_STUDIO_CANDIDATE_EVIDENCE_FILE)
      await writeFile(
        process.env.ASAEL_STUDIO_CANDIDATE_EVIDENCE_FILE,
        JSON.stringify(evidence, null, 2) + "\n",
        { mode: 0o600 },
      );
    vi.unstubAllEnvs();
  });
  it("commits admission and queue together, resumes after disconnect, and stores retrievable media", async () => {
    await scoped(async () => {
      const flow = await createStudioFlow(
        context,
        {
          name: "Isolated Studio image to video",
          graph: createStudioTemplate(
            "image-to-video",
            STUDIO_CAPABILITIES.filter((c) => c.demo),
          ),
        },
        randomUUID(),
      );
      const scope = { mode: "flow" as const, regenerate: false };
      const quote = await quoteStudioFlow(
        context,
        flow.id,
        { revision: 1, scope },
        randomUUID(),
      );
      expect(quote.issues).toEqual([]);
      const request = {
        quoteId: quote.id,
        scope,
        maxCostUsd: 0,
        allowUnknownCost: false,
        maxGenerations: 2,
      };
      const key = randomUUID();
      const [run, replay] = await Promise.all([
        submitStudioRun(context, flow.id, request, key),
        submitStudioRun(context, flow.id, request, key),
      ]);
      expect(replay.id).toBe(run.id);
      expect(
        await admin`SELECT id FROM omni_operation_jobs WHERE tenant_id=${tenantId} AND payload->>'runId'=${run.id}`,
      ).toHaveLength(1);
      await updateStudioFlow(
        context,
        flow.id,
        { revision: 1, name: "Changed after immutable acceptance" },
        randomUUID(),
      );
      await advanceStudioRun(context, run.id, new AbortController().signal);
      await closeDatabaseClient(); // reconnect to persisted state, not an in-memory run
      let result = run;
      for (let i = 0; i < 30; i++) {
        result = (await getStudioRun(context, run.id)).run;
        if (
          result.nodes.some((n) => n.errorCode === "studio_persistence_failed")
        )
          break;
        if (
          ["succeeded", "failed", "partial", "uncertain", "canceled"].includes(
            result.status,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 2100));
        result = await advanceStudioRun(
          context,
          run.id,
          new AbortController().signal,
        );
      }
      expect(
        result.status,
        JSON.stringify({
          storageErrors: state.storageErrors,
          nodes: result.nodes.map((n) => ({
            id: n.nodeId,
            status: n.status,
            error: n.error,
          })),
        }),
      ).toBe("succeeded");
      expect(result.flowRevision).toBe(1);
      expect(result.graph).toEqual(flow.graph);
      const video = result.nodes.find((n) => n.nodeId === "video")!
        .outputAssets[0];
      expect(video.mediaType).toBe("video/mp4");
      expect(video.durationSeconds).toBeGreaterThan(0);
      expect(
        (
          await readStudioAssetBytes(
            studioOwner(context),
            video.id,
            video.contentSha256,
          )
        ).bytes.byteLength,
      ).toBe(video.byteCount);
      const saved = await withStudioTransaction(studioOwner(context), (tx) =>
        tx.get<StoredRun>("run", run.id),
      );
      expect(
        saved!.value.nodes
          .filter((n) => n.attempts.length)
          .map((n) => n.attempts.length),
      ).toEqual([1, 1]);
      const events = (await getStudioRun(context, run.id)).events;
      expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
      await expect(getStudioRun(other, run.id)).rejects.toMatchObject({
        status: 404,
      });
      await runWithDatabaseActorScope(
        tenantId,
        [otherActor, otherEmail],
        async () =>
          expect(
            await getSql()`SELECT body FROM omni_studio_records WHERE id=${run.id}`,
          ).toEqual([]),
      );
      await expect(
        withStudioTransaction(studioOwner(context), async (tx) => {
          const value = (await tx.get<StoredRun>("run", run.id))!;
          value.value.graph.nodes = [];
          await tx.put("run", run.id, value, { parentId: flow.id });
        }),
      ).rejects.toThrow("immutable");
      evidence.flowId = flow.id;
      evidence.runId = run.id;
      evidence.status = result.status;
      evidence.assets = result.nodes
        .flatMap((n) => n.outputAssets)
        .map((a) => ({
          id: a.id,
          sha256: a.contentSha256,
          mediaType: a.mediaType,
        }));
      // Revoke tenant generation access and prove both ordinary and replay reads fail.
      await admin`UPDATE omni_auth_memberships SET status='inactive' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
      await expect(getStudioFlow(context, flow.id)).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        submitStudioRun(context, flow.id, request, key),
      ).rejects.toMatchObject({ status: 403 });
      await admin`UPDATE omni_auth_memberships SET status='active' WHERE tenant_id=${tenantId} AND user_id=${userId}`;
      evidence.revokedAccessRejected = true;
    });
  });
  it("normalizes inherited named-role function grants and rejects a foreign canonical actor", async () => {
    const source = await readFile(
      "supabase/migrations/20261025090000_creative_studio.sql",
      "utf8",
    );
    const statements = parseSqlMigrationFile(
      "20261025090000_creative_studio.sql",
      source,
    ).statements;
    const creates = statements.filter((statement) =>
      /CREATE FUNCTION public\.omni_studio_(authority|budget_totals)_v1/.test(
        statement,
      ),
    );
    const acl = statements.find((statement) =>
      statement.includes("DO $studio_acl$"),
    )!;
    expect(creates).toHaveLength(2);
    expect(acl).toBeTruthy();
    const deniedRole = `studio_provider_${randomBytes(5).toString("hex")}`;
    const rollback = new Error("Roll back isolated ACL probe");
    try {
      await admin.begin(async (sql) => {
        await sql.unsafe(
          `CREATE ROLE ${deniedRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await sql.unsafe(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${deniedRole},omni_maintenance`,
        );
        await sql.unsafe(
          "DROP FUNCTION public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT),public.omni_studio_budget_totals_v1(TEXT,TEXT,TIMESTAMPTZ)",
        );
        for (const statement of creates) await sql.unsafe(statement);
        expect(
          (
            await sql`SELECT has_function_privilege(${deniedRole},'public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT)','EXECUTE') AS allowed`
          )[0].allowed,
        ).toBe(true);
        await sql.unsafe(acl);
        const grants =
          await sql`SELECT p.proname, r.rolname, acl.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl LEFT JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid IN ('public.omni_studio_authority_v1(TEXT,TEXT,TEXT,TEXT)'::regprocedure,'public.omni_studio_budget_totals_v1(TEXT,TEXT,TIMESTAMPTZ)'::regprocedure) AND acl.grantee <> p.proowner ORDER BY p.proname,r.rolname`;
        expect(grants).toHaveLength(2);
        expect(
          grants.every(
            (row) =>
              row.rolname === "omni_runtime" && row.is_grantable === false,
          ),
        ).toBe(true);
        evidence.closedFunctionGrants = grants;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect(
      await scoped(
        () =>
          getSql()`SELECT * FROM omni_studio_authority_v1(${tenantId},${otherActor},NULL,NULL)`,
      ),
    ).toEqual([]);
    evidence.inheritedAclNormalized = true;
  });
  it("atomically bounds reservation totals across different owners", async () => {
    const first = withStudioTransaction(studioOwner(context), (tx) =>
      reserveStudioBudget(
        tx,
        studioOwner(context),
        randomUUID(),
        0.6,
        1_000_000,
      ),
    );
    const second = withStudioTransaction(studioOwner(other), (tx) =>
      reserveStudioBudget(tx, studioOwner(other), randomUUID(), 0.6, 1_000_000),
    );
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    evidence.tenantBudgetSerialization = true;
  });
});
