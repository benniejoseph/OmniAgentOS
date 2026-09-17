import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getDevice: vi.fn(),
  updateDevice: vi.fn(),
  claimCommand: vi.fn(),
  completeCommand: vi.fn(),
  stopDevice: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (request: Request, route?: unknown) => Promise<Response>) =>
      handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/local-computer/store", () => ({
  LocalComputerUnavailableError: class extends Error {
    readonly status = 409;
  },
  LocalComputerCommandError: class extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
  getLocalComputerDevice: mocks.getDevice,
  updateLocalComputerDevice: mocks.updateDevice,
  claimLocalComputerCommand: mocks.claimCommand,
  completeLocalComputerCommand: mocks.completeCommand,
  stopLocalComputerDevice: mocks.stopDevice,
}));

import {
  GET as getDevice,
  PUT as putDevice,
} from "@/app/api/mobile/computer-use/device/route";
import { POST as claimCommand } from "@/app/api/mobile/computer-use/commands/claim/route";
import { POST as completeCommand } from "@/app/api/mobile/computer-use/commands/[id]/complete/route";
import { POST as stopDevice } from "@/app/api/mobile/computer-use/stop/route";

const context = {
  tenantId: "tenant-one",
  actorId: "operator@example.test",
  role: "operator" as const,
  source: "mobile" as const,
  auth: {
    userId: "user-one",
    email: "operator@example.test",
    sessionId: "session-one",
    tenantName: "Example",
  },
  native: {
    deviceId: "device-one",
    platform: "macos" as const,
    appVersion: "1.6.0",
    buildNumber: 7,
    clientContractVersion: 11,
    clientAttestedAt: "2026-09-17T08:00:00.000Z",
  },
};

const device = {
  schemaVersion: 1,
  deviceId: "device-one",
  enabled: true,
  online: true,
  helperVersion: "1.0.0",
  permissions: {
    accessibility: "granted",
    screenRecording: "granted",
  },
  activityState: "idle",
  lifecycleRevision: 1,
  lastSeenAt: "2026-09-17T08:00:00.000Z",
  leaseExpiresAt: "2026-09-17T08:00:24.000Z",
};

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.getDevice.mockReset().mockResolvedValue(device);
  mocks.updateDevice.mockReset().mockResolvedValue(device);
  mocks.claimCommand.mockReset().mockResolvedValue({
    schemaVersion: 1,
    command: null,
    pollAfterMs: 600,
  });
  mocks.completeCommand.mockReset().mockResolvedValue({
    schemaVersion: 1,
    accepted: true,
    commandId: commandId,
    outcome: "succeeded",
    resultSha256: "a".repeat(64),
    completedAt: "2026-09-17T08:00:01.000Z",
  });
  mocks.stopDevice.mockReset().mockResolvedValue({
    schemaVersion: 1,
    stopped: true,
    reason: "user_stop",
    canceledCommands: 1,
  });
});

describe("local macOS Computer Use native routes", () => {
  it("reads and updates only the authenticated installation readiness", async () => {
    const read = await getDevice(request("/device"));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    await expect(read.json()).resolves.toEqual(device);

    const update = await putDevice(request("/device", "PUT", {
      schemaVersion: 1,
      enabled: true,
      helperVersion: "1.0.0",
      permissions: {
        accessibility: "granted",
        screenRecording: "granted",
      },
      activityState: "idle",
    }));
    expect(update.status).toBe(200);
    expect(update.headers.get("x-asael-native-contract-version")).toBe("11");
    expect(mocks.updateDevice).toHaveBeenCalledWith(context, expect.objectContaining({
      enabled: true,
      helperVersion: "1.0.0",
    }));
    expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nativeMutationCapability: "computer.use.device.update",
      }),
    );
  });

  it("rejects a malformed readiness update before authorization", async () => {
    mocks.authorizeRequest.mockClear();
    const response = await putDevice(request("/device", "PUT", {
      schemaVersion: 1,
      enabled: true,
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });

  it("claims through the v11-gated command capability", async () => {
    const response = await claimCommand(request("/commands/claim", "POST", {
      schemaVersion: 1,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      command: null,
      pollAfterMs: 600,
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "execute.tool",
        nativeMutationCapability: "computer.use.command.claim",
      }),
    );
  });

  it("completes an exact claimed command with a bounded receipt", async () => {
    const response = await completeCommand(
      request(`/commands/${commandId}/complete`, "POST", {
        schemaVersion: 1,
        claimToken: "claim-token-that-is-long-enough-123456",
        outcome: "succeeded",
        result: { summary: "Focused the requested window." },
      }),
      { params: Promise.resolve({ id: commandId }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.completeCommand).toHaveBeenCalledWith(
      context,
      commandId,
      expect.objectContaining({ outcome: "succeeded" }),
    );
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: commandId,
        nativeMutationCapability: "computer.use.command.complete",
      }),
    );
  });

  it("stops the exact device and returns the canceled command count", async () => {
    const response = await stopDevice(request("/stop", "POST", {
      schemaVersion: 1,
      reason: "user_stop",
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stopped: true,
      reason: "user_stop",
      canceledCommands: 1,
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ nativeMutationCapability: "computer.use.stop" }),
    );
  });
});

const commandId = `local_computer_command_${"b".repeat(48)}`;

function request(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
) {
  return new Request(`https://app.example.test/api/mobile/computer-use${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}
