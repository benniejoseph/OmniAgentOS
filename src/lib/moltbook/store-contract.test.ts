import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isExactMoltbookAgentCapabilityBoundary,
  MOLTBOOK_TOOL_IDS,
} from "@/lib/moltbook/contracts";

import {
  createMoltbookActivityCursor,
  isDefiniteMoltbookRegistrationRejection,
  isRetryableMoltbookRegistrationRow,
  MoltbookConnectionError,
  parseMoltbookActivityCursor,
} from "@/lib/moltbook/store";
import { MoltbookProviderError } from "@/lib/moltbook/http-client";

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

  it("allows registration retry only after a definite non-effecting rejection", () => {
    expect(isDefiniteMoltbookRegistrationRejection(new MoltbookProviderError({
      code: "provider_http_409",
      message: "rejected",
      statusCode: 409,
    }))).toBe(true);
    expect(isDefiniteMoltbookRegistrationRejection(new MoltbookProviderError({
      code: "provider_http_500",
      message: "unknown outcome",
      statusCode: 500,
    }))).toBe(false);
    expect(isDefiniteMoltbookRegistrationRejection(new MoltbookProviderError({
      code: "provider_timeout",
      message: "unknown outcome",
    }))).toBe(false);
    expect(isRetryableMoltbookRegistrationRow({
      status: "error",
      claim_state: "unavailable",
      sealed_credentials: null,
      last_error_code: "registration_rejected.provider_http_409",
    })).toBe(true);
    expect(isRetryableMoltbookRegistrationRow({
      status: "error",
      claim_state: "unavailable",
      sealed_credentials: null,
      last_error_code: "provider_timeout",
    })).toBe(false);
  });
});
