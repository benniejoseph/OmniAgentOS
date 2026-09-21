import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isExactMoltbookAgentCapabilityBoundary,
  MOLTBOOK_TOOL_IDS,
} from "@/lib/moltbook/contracts";

import {
  createMoltbookActivityCursor,
  MoltbookConnectionError,
  parseMoltbookActivityCursor,
} from "@/lib/moltbook/store";

describe("Moltbook store contracts", () => {
  it("round-trips a bounded keyset cursor without accepting arbitrary offsets", () => {
    const createdAt = "2026-09-21T12:00:00.000Z";
    const id = `moltbook_activity_${"a".repeat(48)}`;
    const cursor = createMoltbookActivityCursor(createdAt, id);
    expect(parseMoltbookActivityCursor(cursor)).toEqual({ createdAt, id });
    expect(() => parseMoltbookActivityCursor(
      Buffer.from(JSON.stringify({ createdAt, id, offset: 100 })).toString("base64url"),
    )).toThrow(MoltbookConnectionError);
  });

  it("rejects malformed and cross-shape cursors", () => {
    expect(() => parseMoltbookActivityCursor("not-a-cursor"))
      .toThrow("Invalid activity cursor");
    expect(() => parseMoltbookActivityCursor(
      Buffer.from(JSON.stringify({ createdAt: "bad", id: "bad" })).toString("base64url"),
    )).toThrow("Invalid activity cursor");
  });

  it("accepts only the exact Moltbook Agent capability boundary", () => {
    const exact = {
      skillIds: [],
      toolIds: [...MOLTBOOK_TOOL_IDS],
      memoryScope: "session",
      autonomy: "governed",
      approvalPolicy: "risk_based",
    };
    expect(isExactMoltbookAgentCapabilityBoundary(exact)).toBe(true);
    expect(isExactMoltbookAgentCapabilityBoundary({
      ...exact,
      approvalPolicy: "always",
    })).toBe(true);
    expect(isExactMoltbookAgentCapabilityBoundary({
      ...exact,
      skillIds: ["moltbook-skill"],
    })).toBe(false);
    expect(isExactMoltbookAgentCapabilityBoundary({
      ...exact,
      toolIds: [...MOLTBOOK_TOOL_IDS, "web.search"],
    })).toBe(false);
    expect(isExactMoltbookAgentCapabilityBoundary({
      ...exact,
      memoryScope: "all",
    })).toBe(false);
    expect(isExactMoltbookAgentCapabilityBoundary({
      ...exact,
      autonomy: "execute",
    })).toBe(false);
  });

  it("keeps scheduled and manual connection checks status-only", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "src/lib/moltbook/store.ts",
    ), "utf8");
    const scheduler = source.slice(
      source.indexOf("export async function processDueMoltbookHeartbeats"),
      source.indexOf("async function observeMoltbookConnection"),
    );
    const observation = source.slice(
      source.indexOf("async function observeMoltbookConnection"),
      source.indexOf("async function transitionConnectionLocally"),
    );
    expect(scheduler).toContain("await refreshMoltbookConnection");
    expect(scheduler).not.toContain("heartbeatMoltbookConnection");
    expect(observation).toContain("await client.status()");
    expect(observation).not.toContain("client.home");
  });

  it("looks up effect evidence by unique execution identity before checking bindings", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "src/lib/moltbook/store.ts",
    ), "utf8");
    const reader = source.slice(
      source.indexOf("export async function readMoltbookEffectEvidence"),
      source.indexOf("export async function observeMoltbookRateLimit"),
    );
    const where = reader.slice(reader.indexOf("WHERE"), reader.indexOf("LIMIT 2"));
    expect(where).toContain("tool_execution_id = ${input.toolExecutionId}");
    expect(where).not.toContain("tool_input_sha256 =");
    expect(where).not.toContain("request_sha256 =");
    expect(reader).toContain("String(row.tool_input_sha256) !== input.toolInputSha256");
    expect(reader).toContain("String(row.request_sha256) !== input.requestSha256");
  });

  it("exposes no provider registration replay path", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "src/lib/moltbook/store.ts",
    ), "utf8");
    expect(source).not.toContain("retryMoltbookRegistration");
    expect(source).not.toContain("Registration retry could not claim");
    expect(source).toContain("retry is blocked to prevent a duplicate identity");
  });

  it("revalidates the canonical controller, active owner membership, and empty principal grants", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "src/lib/moltbook/store.ts",
    ), "utf8");
    const resolver = source.slice(
      source.indexOf("export async function resolveMoltbookPrincipalAuthority"),
      source.indexOf("export async function assertMoltbookAgentMayBeDeleted"),
    );
    expect(resolver).toContain("principal.controller_actor_id = ${input.canonicalActorId}");
    expect(resolver).toContain("principal.principal_generation = ${input.principalGeneration}");
    expect(resolver).toContain("auth_user.status = 'active'");
    expect(resolver).toContain("membership.status = 'active'");
    expect(resolver).toContain("membership.tenant_id = principal.tenant_id");
    expect(resolver).toContain("public.omni_actor_scope_v1_allows_canonical(");
    expect(resolver).not.toContain("JOIN omni_auth_user_actor_identifiers");
    expect(resolver).toContain("cardinality(policy.context_grant_ids) = 0");
    expect(resolver).toContain("cardinality(policy.capability_grant_ids) = 0");
  });
});
