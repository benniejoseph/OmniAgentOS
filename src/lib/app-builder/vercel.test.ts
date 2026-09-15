import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  builderVercelProjectName,
  createBuilderVercelPreview,
  discoverBuilderSmokeRoutes,
  getBuilderVercelDeployment,
  getBuilderVercelLogEvidence,
  getBuilderVercelStatus,
  runBuilderVercelRouteSmokes,
} from "@/lib/app-builder/vercel";

const original = {
  token: process.env.OMNIAGENT_VERCEL_ACCESS_TOKEN,
  teamId: process.env.OMNIAGENT_VERCEL_TEAM_ID,
  bypass: process.env.OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN,
};

describe("App Builder Vercel preview broker", () => {
  beforeEach(() => {
    process.env.OMNIAGENT_VERCEL_ACCESS_TOKEN = "vercel_test_token_abcdefghijklmnopqrstuvwxyz";
    process.env.OMNIAGENT_VERCEL_TEAM_ID = "team_asaelprivate";
    delete process.env.OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restore("OMNIAGENT_VERCEL_ACCESS_TOKEN", original.token);
    restore("OMNIAGENT_VERCEL_TEAM_ID", original.teamId);
    restore("OMNIAGENT_VERCEL_PROTECTION_BYPASS_TOKEN", original.bypass);
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
      commitSha: "d".repeat(40),
      files: [{ path: "app/page.tsx", content, sha256: "e".repeat(64), size: Buffer.byteLength(content) }],
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
      meta: { asaelWorkspaceSha256: "c".repeat(64), asaelCommitSha: "d".repeat(40) },
    });
    expect(firstBody.target).toBeUndefined();
    expect(String(fetchMock.mock.calls[1][0])).toContain("/v2/files?teamId=team_asaelprivate");
    expect(fetchMock.mock.calls[1][1].headers["x-now-digest"]).toBe(sha);
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe("Bearer vercel_test_token_abcdefghijklmnopqrstuvwxyz");
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

  it("discovers static App Router pages and smokes only exact Vercel preview hosts", async () => {
    expect(discoverBuilderSmokeRoutes([
      { path: "app/page.tsx" },
      { path: "app/(public)/research/page.tsx" },
      { path: "app/items/[id]/page.tsx" },
      { path: "src/app/about/page.jsx" },
    ])).toEqual(["/", "/about", "/research"]);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response("ready", { status: 200 }))));
    await expect(runBuilderVercelRouteSmokes("https://research-abc.vercel.app/", ["/", "/about"]))
      .resolves.toMatchObject({ status: "passed", routes: [{ path: "/", status: "passed", statusCode: 200 }, { path: "/about", status: "passed", statusCode: 200 }] });
    await expect(runBuilderVercelRouteSmokes("https://127.0.0.1/", ["/"])).rejects.toThrow(/invalid preview URL/i);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
