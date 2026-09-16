import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/security/network", () => ({
  fetchPublicHttpUrl: vi.fn((input: string | URL | Request, init?: RequestInit) => fetch(input, init)),
}));

import {
  builderVercelProjectName,
  createBuilderVercelProduction,
  createBuilderVercelPreview,
  discoverBuilderSmokeRoutes,
  ensureBuilderVercelProtectionBypass,
  getBuilderVercelDeployment,
  getBuilderVercelLogEvidence,
  getBuilderVercelProductionDeployment,
  getBuilderVercelStatus,
  runBuilderVercelRouteSmokes,
} from "@/lib/app-builder/vercel";

const original = {
  token: process.env.OMNIAGENT_VERCEL_ACCESS_TOKEN,
  teamId: process.env.OMNIAGENT_VERCEL_TEAM_ID,
  bypass: process.env.OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN,
  previewSecret: process.env.OMNIAGENT_APP_BUILDER_PREVIEW_SECRET,
};

describe("App Builder Vercel preview broker", () => {
  beforeEach(() => {
    process.env.OMNIAGENT_VERCEL_ACCESS_TOKEN = "vercel_test_token_abcdefghijklmnopqrstuvwxyz";
    process.env.OMNIAGENT_VERCEL_TEAM_ID = "team_asaelprivate";
    delete process.env.OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN;
    process.env.OMNIAGENT_APP_BUILDER_PREVIEW_SECRET = "app-builder-preview-test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restore("OMNIAGENT_VERCEL_ACCESS_TOKEN", original.token);
    restore("OMNIAGENT_VERCEL_TEAM_ID", original.teamId);
    restore("OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN", original.bypass);
    restore("OMNIAGENT_APP_BUILDER_PREVIEW_SECRET", original.previewSecret);
  });

  it("reports readiness without exposing credentials and derives one opaque project name", () => {
    expect(getBuilderVercelStatus()).toEqual({ configured: true, missing: [] });
    expect(builderVercelProjectName("tenant-a", "actor-a", "project-a")).toMatch(/^asael-app-[a-f0-9]{16}$/);
    expect(JSON.stringify(getBuilderVercelStatus())).not.toContain("vercel_test_token");
    delete process.env.OMNIAGENT_VERCEL_TEAM_ID;
    expect(getBuilderVercelStatus()).toEqual({ configured: false, missing: ["Vercel team ID"] });
  });

  it("uploads only provider-requested SHA-1 files and creates a preview without a production target", async () => {
    const content = "export default function Page() { return <main>Ready</main> }";
    const sha = createHash("sha1").update(content).digest("hex");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "missing_files", message: "upload files", missing: [sha] } }, 400))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        id: "dpl_Abc123",
        projectId: "prj_Def456",
        readyState: "QUEUED",
        url: "research-abc.vercel.app",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createBuilderVercelPreview({
      deploymentReceiptId: `app_build_deployment_${"a".repeat(48)}`,
      projectName: "asael-app-1234567890abcdef",
      checkpointId: `app_build_checkpoint_${"b".repeat(48)}`,
      workspaceSha256: "c".repeat(64),
      source: {
        kind: "files",
        files: [{ path: "app/page.tsx", content, sha256: "e".repeat(64), size: Buffer.byteLength(content) }],
      },
    });

    expect(result).toEqual({
      projectId: "prj_Def456",
      deploymentId: "dpl_Abc123",
      state: "QUEUED",
      url: "https://research-abc.vercel.app/",
    });
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(firstBody).toMatchObject({
      name: "asael-app-1234567890abcdef",
      version: 2,
      files: [{ file: "app/page.tsx", sha, size: Buffer.byteLength(content), mode: 0o100644 }],
      meta: { asaelWorkspaceSha256: "c".repeat(64) },
    });
    expect(firstBody.target).toBeUndefined();
    expect(String(fetchMock.mock.calls[1][0])).toContain("/v2/files?teamId=team_asaelprivate");
    expect(fetchMock.mock.calls[1][1].headers["x-now-digest"]).toBe(sha);
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe("Bearer vercel_test_token_abcdefghijklmnopqrstuvwxyz");
  });

  it("deploys a reviewed repository commit through Git without uploading workspace files", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      id: "dpl_Git123",
      projectId: "prj_Git456",
      readyState: "QUEUED",
      url: "omniagent-review.vercel.app",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createBuilderVercelPreview({
      deploymentReceiptId: `app_build_deployment_${"a".repeat(48)}`,
      projectName: "asael-app-1234567890abcdef",
      checkpointId: `app_build_checkpoint_${"b".repeat(48)}`,
      workspaceSha256: "c".repeat(64),
      source: {
        kind: "github",
        repositoryId: "1260961340",
        ref: "asael/omniagent-review-canary-30adb663",
        commitSha: "d".repeat(40),
      },
    })).resolves.toMatchObject({ deploymentId: "dpl_Git123" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({
      name: "asael-app-1234567890abcdef",
      gitSource: {
        type: "github",
        repoId: "1260961340",
        ref: "asael/omniagent-review-canary-30adb663",
        sha: "d".repeat(40),
      },
      meta: { asaelCommitSha: "d".repeat(40) },
    });
  });

  it("reads bounded state and log evidence while retaining only a digest and count", async () => {
    const logs = `${JSON.stringify({ event: "stdout", payload: { text: "building" } })}\n${JSON.stringify({ event: "state", payload: { value: "READY" } })}\n`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "dpl_Abc123", projectId: "prj_Def456", readyState: "READY", url: "research-abc.vercel.app" }))
      .mockResolvedValueOnce(new Response(logs, { status: 200, headers: { "content-type": "application/jsonl" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBuilderVercelDeployment("dpl_Abc123")).resolves.toMatchObject({ state: "READY" });
    await expect(getBuilderVercelLogEvidence("dpl_Abc123")).resolves.toEqual({
      status: "captured",
      sha256: createHash("sha256").update(logs).digest("hex"),
      eventCount: 2,
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain("/events?");
  });

  it("configures one deterministic project-scoped verification bypass without persisting it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ protectionBypass: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const secret = await ensureBuilderVercelProtectionBypass("prj_Def456");

    expect(secret).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/projects/prj_Def456/protection-bypass?teamId=team_asaelprivate");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      generate: { secret, note: "Asael App Builder verification" },
    });
  });

  it("reuses an existing deterministic verification bypass after a provider conflict", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "already exists" } }, 409))
      .mockResolvedValueOnce(jsonResponse({ protectionBypass: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const secret = await ensureBuilderVercelProtectionBypass("prj_Def456");

    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      update: { secret, note: "Asael App Builder verification" },
    });
  });

  it("records an exact rollback candidate and promotes only the reviewed preview to production", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ deployments: [{ uid: "dpl_Previous123", url: "asael-app-old.vercel.app" }] }))
      .mockResolvedValueOnce(jsonResponse({
        id: "dpl_Production456",
        projectId: "prj_Def456",
        readyState: "QUEUED",
        url: "asael-app-live.vercel.app",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBuilderVercelProductionDeployment("prj_Def456")).resolves.toEqual({
      deploymentId: "dpl_Previous123",
      url: "https://asael-app-old.vercel.app/",
    });
    await expect(createBuilderVercelProduction({
      releaseReceiptId: `app_build_release_${"a".repeat(48)}`,
      projectName: "asael-app-1234567890abcdef",
      previewDeploymentId: "dpl_Abc123",
      workspaceSha256: "c".repeat(64),
    })).resolves.toMatchObject({
      projectId: "prj_Def456",
      deploymentId: "dpl_Production456",
      state: "QUEUED",
      url: "https://asael-app-live.vercel.app/",
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain("/v7/deployments?projectId=prj_Def456&target=production&state=READY&limit=1");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      deploymentId: "dpl_Abc123",
      name: "asael-app-1234567890abcdef",
      target: "production",
      meta: {
        action: "promote",
        asaelReleaseId: `app_build_release_${"a".repeat(48)}`,
        asaelWorkspaceSha256: "c".repeat(64),
      },
    });
  });

  it("discovers static App Router pages and smokes only exact Vercel preview hosts", async () => {
    expect(discoverBuilderSmokeRoutes([
      { path: "app/page.tsx" },
      { path: "app/(public)/research/page.tsx" },
      { path: "app/items/[id]/page.tsx" },
      { path: "src/app/about/page.jsx" },
    ])).toEqual(["/", "/about", "/research"]);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("ready", { status: 200 }))));
    const protectionBypassSecret = "a".repeat(32);
    await expect(runBuilderVercelRouteSmokes("https://research-abc.vercel.app/", ["/", "/about"], { protectionBypassSecret }))
      .resolves.toMatchObject({ status: "passed", routes: [{ path: "/", status: "passed", statusCode: 200 }, { path: "/about", status: "passed", statusCode: 200 }] });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers).toEqual({
      "x-vercel-protection-bypass": protectionBypassSecret,
    });
    await expect(runBuilderVercelRouteSmokes("https://127.0.0.1/", ["/"])).rejects.toThrow(/invalid preview URL/i);
  });

  it("follows only bounded same-origin application redirects", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/welcome" } }))
      .mockResolvedValueOnce(new Response("ready", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runBuilderVercelRouteSmokes("https://research-abc.vercel.app/", ["/"]))
      .resolves.toMatchObject({ status: "passed", routes: [{ path: "/", status: "passed", statusCode: 200 }] });
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://research-abc.vercel.app/welcome");
  });

  it("fails closed on a Vercel authentication redirect", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://vercel.com/sso-api?redacted=1" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runBuilderVercelRouteSmokes("https://research-abc.vercel.app/", ["/"]))
      .resolves.toMatchObject({ status: "failed", routes: [{ path: "/", status: "failed", statusCode: 302 }] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
