import { describe, expect, it } from "vitest";
import {
  GET as listProfiles,
  POST as createProfile,
} from "@/app/api/browser/profiles/route";
import {
  DELETE as revokeProfile,
  PATCH as updateProfile,
} from "@/app/api/browser/profiles/[id]/route";
import { GET as readActivity } from "@/app/api/runs/[id]/activity/route";
import { GET as streamActivity } from "@/app/api/runs/[id]/activity/stream/route";
import { GET as readFrame } from "@/app/api/runs/[id]/activity/frames/[frameId]/route";
import { GET as readSnapshot } from "@/app/api/runs/[id]/activity/snapshots/[snapshotId]/route";
import {
  GET as readTakeover,
  POST as mutateTakeover,
} from "@/app/api/runs/[id]/takeover/route";

describe("isolated browser retirement routes", () => {
  it.each([
    ["profile list", listProfiles],
    ["profile create", createProfile],
    ["profile update", updateProfile],
    ["profile revoke", revokeProfile],
    ["activity read", readActivity],
    ["activity stream", streamActivity],
    ["frame read", readFrame],
    ["snapshot read", readSnapshot],
    ["takeover read", readTakeover],
    ["takeover mutation", mutateTakeover],
  ])("retires %s without opening a runtime path", async (_label, handler) => {
    const response = handler();

    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "isolated_browser_retired",
    });
  });
});
