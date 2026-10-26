import assert from "node:assert/strict";
import { test } from "node:test";
import { studioProbeRequestMethod, studioProjectProbeEnabled } from "./studio-project-probe.mjs";

test("Project exercise requires explicit demo admission and rejects paid or recovery combinations", () => {
  assert.equal(studioProjectProbeEnabled({}, { mode: "live" }), false);
  assert.equal(studioProjectProbeEnabled({ SMOKE_STUDIO_PROJECTS: "CONFIRMED" }, { mode: "demo" }), true);
  for (const [env, options] of [
    [{ SMOKE_STUDIO_PROJECTS: "true" }, { mode: "demo" }],
    [{ SMOKE_STUDIO_PROJECTS: "CONFIRMED" }, { mode: "live" }],
    [{ SMOKE_STUDIO_PROJECTS: "CONFIRMED" }, { mode: "demo", recovery: {} }],
    [{ SMOKE_STUDIO_PROJECTS: "CONFIRMED", OMNIAGENT_RELEASE_STUDIO_READBACK: "{}" }, { mode: "demo" }],
    [{ SMOKE_STUDIO_PROJECTS: "CONFIRMED", LIVE_VERIFY_STUDIO_GENERATION: "CONFIRMED" }, { mode: "demo" }],
  ]) assert.throws(() => studioProjectProbeEnabled(env, options));
});

test("Readback guards the actual method, including mutations without a body", () => {
  for (const method of ["POST", "PATCH"]) {
    for (const body of [undefined, {}, { action: "advance" }]) {
      assert.throws(() => studioProbeRequestMethod("/api/studio/runs/run-1", body, method, "readback"), /cannot mutate/);
    }
  }
  assert.equal(studioProbeRequestMethod("/api/studio/projects/project-1/profile", undefined, "GET", "readback"), "GET");
  assert.equal(studioProbeRequestMethod("/api/studio/projects/project-1/profile", {}, "PATCH", "exercise"), "PATCH");
  for (const path of ["/api/auth/login", "/api/auth/logout"]) {
    assert.equal(studioProbeRequestMethod(path, {}, "POST", "readback"), "POST");
    assert.throws(() => studioProbeRequestMethod(path, undefined, "PATCH", "readback"), /cannot mutate/);
  }
  assert.throws(() => studioProbeRequestMethod("/api/auth/logout?extra=1", {}, "POST", "readback"), /cannot mutate/);
  assert.throws(() => studioProbeRequestMethod("/api/studio/flows/flow-1", {}, "GET", "readback"), /cannot have a body/);
  for (const method of ["DELETE", "PUT", "HEAD", "patch"]) {
    assert.throws(() => studioProbeRequestMethod("/api/studio/flows/flow-1", undefined, method, "exercise"), /Unsupported/);
  }
});
