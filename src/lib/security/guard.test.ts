import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guardMocks = vi.hoisted(() => ({
  resolveSecurityContext: vi.fn(),
  recordSecurityAudit: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
}));

vi.mock("@/lib/security/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/context")>()),
  resolveSecurityContext: guardMocks.resolveSecurityContext,
}));

vi.mock("@/lib/security/audit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/audit-store")>()),
  recordSecurityAudit: guardMocks.recordSecurityAudit,
}));

vi.mock("@/lib/observability/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/store")>()),
  recordRuntimeEventSafely: guardMocks.recordRuntimeEventSafely,
}));

import {
  assertTrustedSessionMutation,
  authorizeRequest,
  shouldDeferAllowedAudit,
} from "@/lib/security/guard";
import { SecurityPolicyError } from "@/lib/security/context";

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const originalInternalSecret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;

beforeEach(() => {
  guardMocks.resolveSecurityContext.mockReset();
  guardMocks.recordSecurityAudit.mockReset().mockResolvedValue(undefined);
  guardMocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (originalAppUrl === undefined) {
    delete process.env.NEXT_PUBLIC_APP_URL;
  } else {
    process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  }
  if (originalInternalSecret === undefined) {
    delete process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
  } else {
    process.env.OMNIAGENT_INTERNAL_AUTH_SECRET = originalInternalSecret;
  }
});

describe("synthetic authentication denial telemetry", () => {
  it("does not persist the expected verified synthetic authentication challenge", async () => {
    process.env.OMNIAGENT_INTERNAL_AUTH_SECRET = "synthetic-test-secret";
    guardMocks.resolveSecurityContext.mockRejectedValue(
      new SecurityPolicyError("Authentication required.", 401),
    );

    await expect(
      authorizeRequest({
        request: syntheticRequest(),
        action: "read",
        resourceType: "memory",
      }),
    ).rejects.toMatchObject({
      message: "Authentication required.",
      status: 401,
    });

    expect(guardMocks.recordRuntimeEventSafely).not.toHaveBeenCalled();
    expect(guardMocks.recordSecurityAudit).not.toHaveBeenCalled();
  });

  it("persists unexpected synthetic authentication failures", async () => {
    process.env.OMNIAGENT_INTERNAL_AUTH_SECRET = "synthetic-test-secret";
    guardMocks.resolveSecurityContext.mockRejectedValue(
      new SecurityPolicyError("Synthetic authentication failed.", 401),
    );

    await expect(
      authorizeRequest({
        request: syntheticRequest(),
        action: "read",
        resourceType: "memory",
      }),
    ).rejects.toThrow("Synthetic authentication failed.");

    expect(guardMocks.recordRuntimeEventSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "security.auth_failed",
        statusCode: 401,
      }),
    );
  });

  it("persists real authentication challenges", async () => {
    process.env.OMNIAGENT_INTERNAL_AUTH_SECRET = "synthetic-test-secret";
    guardMocks.resolveSecurityContext.mockRejectedValue(
      new SecurityPolicyError("Authentication required.", 401),
    );

    await expect(
      authorizeRequest({
        request: new Request("https://app.example.test/api/memory"),
        action: "read",
        resourceType: "memory",
      }),
    ).rejects.toThrow("Authentication required.");

    expect(guardMocks.recordRuntimeEventSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "security.auth_failed",
        statusCode: 401,
      }),
    );
  });
});

describe("cookie-authenticated mutation origin checks", () => {
  it("accepts same-origin session mutations", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
    const request = mutationRequest("https://app.example.test");

    expect(() =>
      assertTrustedSessionMutation(request, { source: "session" }),
    ).not.toThrow();
  });

  it("rejects missing and sibling origins for session mutations", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";

    expect(() =>
      assertTrustedSessionMutation(
        new Request("https://app.example.test/api/tools", { method: "POST" }),
        { source: "session" },
      ),
    ).toThrow(/trusted application origin/i);

    expect(() =>
      assertTrustedSessionMutation(
        mutationRequest("https://attacker.example.test"),
        { source: "session" },
      ),
    ).toThrow(/trusted application origin/i);
  });

  it("exempts safe methods and internally authenticated callers", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";

    expect(() =>
      assertTrustedSessionMutation(
        new Request("https://app.example.test/api/tools"),
        { source: "session" },
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedSessionMutation(
        new Request("https://app.example.test/api/tools", { method: "POST" }),
        { source: "headers" },
      ),
    ).not.toThrow();
  });

  it("can protect cookie-only routes such as logout", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";

    expect(() =>
      assertTrustedSessionMutation(mutationRequest("https://app.example.test")),
    ).not.toThrow();
    expect(() =>
      assertTrustedSessionMutation(mutationRequest("https://evil.example.test")),
    ).toThrow(/trusted application origin/i);
  });
});

describe("allowed audit scheduling", () => {
  it("defers only routine safe reads", () => {
    expect(
      shouldDeferAllowedAudit({ method: "GET" }, "read", 0),
    ).toBe(true);
    expect(
      shouldDeferAllowedAudit({ method: "POST" }, "read", 0),
    ).toBe(false);
    expect(
      shouldDeferAllowedAudit({ method: "GET" }, "manage.security", 0),
    ).toBe(false);
    expect(
      shouldDeferAllowedAudit({ method: "HEAD" }, "read", 2),
    ).toBe(false);
  });

  it("logs only structured diagnostics before failing a consequential action closed", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    guardMocks.resolveSecurityContext.mockResolvedValue({
      tenantId: "tenant-a",
      actorId: "actor-a",
      role: "admin",
      source: "headers",
    });
    guardMocks.recordSecurityAudit.mockRejectedValue(
      Object.assign(
        new Error(
          "Database connection acquisition timed out. postgresql://audit-user:audit-password@db.example.test/asael SELECT secret_value FROM private_table",
        ),
        {
          code: "DATABASE_ACQUIRE_TIMEOUT",
          detail: "api-key-should-never-be-logged",
        },
      ),
    );

    try {
      await expect(
        authorizeRequest({
          request: new Request("https://app.example.test/api/workflows", {
            method: "POST",
          }),
          action: "manage.workflow",
          resourceType: "workflow",
        }),
      ).rejects.toMatchObject({
        message:
          "The security audit ledger is unavailable, so this consequential action was not executed.",
        status: 503,
      });
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      const serialized = String(consoleWarn.mock.calls[0]?.[0]);
      expect(JSON.parse(serialized)).toEqual({
        level: "warn",
        event: "security.audit_write_failed",
        outcome: "blocked",
        action: "manage.workflow",
        resourceType: "workflow",
        category: "connection_acquire_timeout",
        code: "DATABASE_ACQUIRE_TIMEOUT",
      });
      expect(serialized).not.toMatch(
        /audit-user|audit-password|db\.example|select|secret_value|private_table|api-key/i,
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("continues a non-durable action and records a structured audit warning", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const context = {
      tenantId: "tenant-a",
      actorId: "actor-a",
      role: "admin" as const,
      source: "headers" as const,
    };
    guardMocks.resolveSecurityContext.mockResolvedValue(context);
    guardMocks.recordSecurityAudit.mockRejectedValue(
      Object.assign(new Error("canceling statement due to lock timeout"), {
        code: "55P03",
      }),
    );

    try {
      await expect(
        authorizeRequest({
          request: new Request("https://app.example.test/api/memory", {
            method: "POST",
          }),
          action: "read",
          resourceType: "memory",
        }),
      ).resolves.toEqual(context);
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(consoleWarn.mock.calls[0]?.[0]))).toEqual({
        level: "warn",
        event: "security.audit_write_failed",
        outcome: "continued",
        action: "read",
        resourceType: "memory",
        category: "lock_timeout",
        code: "55P03",
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });
});

function mutationRequest(origin: string) {
  return new Request("https://app.example.test/api/tools", {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
    },
  });
}

function syntheticRequest() {
  return new Request("https://app.example.test/api/memory", {
    headers: {
      "x-omni-synthetic-auth": "synthetic-test-secret",
      "x-omni-synthetic-source": "production-smoke",
      "x-omni-slo-excluded": "true",
    },
  });
}
