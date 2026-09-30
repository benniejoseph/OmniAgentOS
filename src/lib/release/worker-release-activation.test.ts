import { describe, expect, it } from "vitest";
import { registrationShowsReleaseActivation } from "../../../scripts/worker-release-activation.mjs";

const worker = { instanceId: "machine-a", releaseRevision: "release-b" };
const recorded = {
  startup: true,
  releaseActivation: {
    instanceId: "machine-a",
    revision: "release-b",
    activatedAt: "2026-09-30T10:05:00.000Z",
  },
};

describe("registrationShowsReleaseActivation", () => {
  it("resumes only this machine's activation of the release it runs", () => {
    expect(registrationShowsReleaseActivation(recorded, worker)).toBe(true);
    for (const releaseActivation of [
      { ...recorded.releaseActivation, instanceId: "machine-b" },
      { ...recorded.releaseActivation, revision: "release-a" },
      { activatedAt: "2026-09-30T10:05:00.000Z" },
      null,
    ]) {
      expect(registrationShowsReleaseActivation(
        { startup: true, releaseActivation },
        worker,
      )).toBe(false);
    }
  });

  it("stays held without a registration body or a worker identity", () => {
    for (const body of [undefined, null, {}, { startup: true }]) {
      expect(registrationShowsReleaseActivation(body, worker)).toBe(false);
    }
    const unnamed = {
      startup: true,
      releaseActivation: { instanceId: "", revision: "" },
    };
    expect(registrationShowsReleaseActivation(unnamed, {
      instanceId: "",
      releaseRevision: "",
    })).toBe(false);
    expect(registrationShowsReleaseActivation(
      { startup: true, releaseActivation: { instanceId: "machine-a" } },
      { instanceId: "machine-a", releaseRevision: undefined },
    )).toBe(false);
  });
});
