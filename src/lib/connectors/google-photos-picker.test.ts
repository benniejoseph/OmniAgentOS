import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveGoogleWorkspaceAccess: vi.fn(),
}));

vi.mock("@/lib/connectors/google-workspace-access", () => ({
  getActiveGoogleWorkspaceAccess: mocks.getActiveGoogleWorkspaceAccess,
}));

import {
  GooglePhotosPickerError,
  createGooglePhotosPickerSession,
} from "@/lib/connectors/google-photos-picker";
import { OAuthCredentialError } from "@/lib/connectors/oauth-store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Google Photos Picker access", () => {
  it("maps a missing Picker capability to the existing reconnect response", async () => {
    mocks.getActiveGoogleWorkspaceAccess.mockRejectedValue(
      new OAuthCredentialError(
        "Capability unavailable.",
        "capability_not_granted",
      ),
    );

    await expect(createGooglePhotosPickerSession({
      tenantId: "tenant-a",
      actorId: "owner-a",
    }, 1)).rejects.toEqual(expect.objectContaining<Partial<GooglePhotosPickerError>>({
      status: 409,
      code: "photos_scope_required",
      reconnectRequired: true,
    }));
    expect(mocks.getActiveGoogleWorkspaceAccess).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "owner-a",
      capability: "photos.pick",
    });
  });
});
