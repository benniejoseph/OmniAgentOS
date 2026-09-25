import { describe, expect, it, vi } from "vitest";
import {
  REQUIRED_RELEASE_CHECKS,
  assessReleaseCheckRuns,
  assessReleaseComparison,
  verifyReleaseProvenance,
} from "../../../scripts/release-provenance.mjs";

const revision = "a53a77aee2e1056f8989cc19b24b0a6a620cf084";
const otherRevision = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";

let nextCheckRunId = 1;

function checkRun(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: nextCheckRunId++,
    name,
    head_sha: revision,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    ...overrides,
  };
}

function checkRunList(checkRuns: unknown[]) {
  return { total_count: checkRuns.length, check_runs: checkRuns };
}

function greenRequiredChecks() {
  return REQUIRED_RELEASE_CHECKS.map((name) => checkRun(name));
}

describe("release provenance", () => {
  it("accepts only commits GitHub reports as on the release branch", () => {
    expect(
      assessReleaseComparison(
        { status: "identical", ahead_by: 0, behind_by: 0 },
        revision,
      ),
    ).toEqual({ behindBy: 0 });
    expect(
      assessReleaseComparison(
        { status: "behind", ahead_by: 0, behind_by: 3 },
        revision,
      ),
    ).toEqual({ behindBy: 3 });

    for (const comparison of [
      { status: "ahead", ahead_by: 2, behind_by: 0 },
      { status: "diverged", ahead_by: 1, behind_by: 4 },
      { status: "behind", ahead_by: 1, behind_by: 4 },
      { status: "behind" },
      {},
      null,
    ]) {
      expect(() => assessReleaseComparison(comparison, revision)).toThrow(
        "is not on benniejoseph/OmniAgentOS main",
      );
    }
  });

  it("requires every required job to pass on the exact release commit", () => {
    expect(
      assessReleaseCheckRuns(checkRunList(greenRequiredChecks()), revision),
    ).toEqual([...REQUIRED_RELEASE_CHECKS].sort());

    const withoutIntegration = greenRequiredChecks().filter(
      (run) => run.name !== "integration",
    );
    expect(() =>
      assessReleaseCheckRuns(checkRunList(withoutIntegration), revision),
    ).toThrow("integration has not run");

    const skippedWorker = greenRequiredChecks().map((run) =>
      run.name === "worker" ? { ...run, conclusion: "skipped" } : run,
    );
    expect(() =>
      assessReleaseCheckRuns(checkRunList(skippedWorker), revision),
    ).toThrow("worker is skipped");

    const runningBuild = greenRequiredChecks().map((run) =>
      run.name === "build"
        ? { ...run, status: "in_progress", conclusion: null }
        : run,
    );
    expect(() =>
      assessReleaseCheckRuns(checkRunList(runningBuild), revision),
    ).toThrow("build is in_progress");
  });

  it("judges only the latest attempt of each job", () => {
    const rerunFixed = [
      ...greenRequiredChecks().filter((run) => run.name !== "quality"),
      checkRun("quality", { conclusion: "failure" }),
      checkRun("quality"),
    ];
    expect(() =>
      assessReleaseCheckRuns(checkRunList(rerunFixed), revision),
    ).not.toThrow();

    const rerunBroke = [
      ...greenRequiredChecks().filter((run) => run.name !== "quality"),
      checkRun("quality"),
      checkRun("quality", { conclusion: "failure" }),
    ];
    expect(() =>
      assessReleaseCheckRuns(checkRunList(rerunBroke), revision),
    ).toThrow("quality is failure");
  });

  it("ignores check runs from other apps and other commits", () => {
    const spoofedQuality = [
      ...greenRequiredChecks().filter((run) => run.name !== "quality"),
      checkRun("quality", { conclusion: "failure" }),
      checkRun("quality", { app: { slug: "another-app" } }),
    ];
    expect(() =>
      assessReleaseCheckRuns(checkRunList(spoofedQuality), revision),
    ).toThrow("quality is failure");

    const qualityOnAnotherCommit = [
      ...greenRequiredChecks().filter((run) => run.name !== "quality"),
      checkRun("quality", { head_sha: otherRevision }),
    ];
    expect(() =>
      assessReleaseCheckRuns(checkRunList(qualityOnAnotherCommit), revision),
    ).toThrow("quality has not run");
  });

  it("judges path-filtered jobs when they ran and ignores the production smoke", () => {
    expect(
      assessReleaseCheckRuns(
        checkRunList([
          ...greenRequiredChecks(),
          checkRun("macos-policy", { conclusion: "skipped" }),
          checkRun("production-smoke", { conclusion: "failure" }),
        ]),
        revision,
      ),
    ).toContain("macos-policy");
    expect(() =>
      assessReleaseCheckRuns(
        checkRunList([
          ...greenRequiredChecks(),
          checkRun("production-smoke", {
            status: "in_progress",
            conclusion: null,
          }),
        ]),
        revision,
      ),
    ).not.toThrow();

    expect(() =>
      assessReleaseCheckRuns(
        checkRunList([
          ...greenRequiredChecks(),
          checkRun("flutter", { conclusion: "failure" }),
        ]),
        revision,
      ),
    ).toThrow("flutter is failure");
    expect(() =>
      assessReleaseCheckRuns(
        checkRunList([
          ...greenRequiredChecks(),
          checkRun("flutter", { status: "queued", conclusion: null }),
        ]),
        revision,
      ),
    ).toThrow("flutter is queued");
  });

  it("fails closed on partial or unreadable check-run lists", () => {
    expect(() =>
      assessReleaseCheckRuns(
        { total_count: 101, check_runs: greenRequiredChecks() },
        revision,
      ),
    ).toThrow("refusing to judge a partial list");
    expect(() => assessReleaseCheckRuns({}, revision)).toThrow(
      "unreadable check-run list",
    );
    expect(() => assessReleaseCheckRuns(null, revision)).toThrow(
      "unreadable check-run list",
    );
  });

  it("reads the canonical repository and stops at the first failed proof", async () => {
    const readGitHub = vi.fn(async (endpoint: string) =>
      endpoint.includes("/compare/")
        ? { status: "behind", ahead_by: 0, behind_by: 2 }
        : checkRunList(greenRequiredChecks()),
    );
    await expect(
      verifyReleaseProvenance({ revision, readGitHub }),
    ).resolves.toEqual({
      revision,
      behindBy: 2,
      checks: [...REQUIRED_RELEASE_CHECKS].sort(),
    });
    expect(readGitHub.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      `repos/benniejoseph/OmniAgentOS/compare/main...${revision}`,
      `repos/benniejoseph/OmniAgentOS/commits/${revision}/check-runs?filter=latest&per_page=100`,
    ]);

    const offMain = vi.fn(async () => ({
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
    }));
    await expect(
      verifyReleaseProvenance({ revision, readGitHub: offMain }),
    ).rejects.toThrow("is not on benniejoseph/OmniAgentOS main");
    expect(offMain).toHaveBeenCalledTimes(1);

    const unread = vi.fn();
    await expect(
      verifyReleaseProvenance({ revision: "test-release", readGitHub: unread }),
    ).rejects.toThrow("exact 40-character lowercase Git SHA");
    await expect(
      verifyReleaseProvenance({
        revision: `${revision}\nINJECTED=value`,
        readGitHub: unread,
      }),
    ).rejects.toThrow("exact 40-character lowercase Git SHA");
    expect(unread).not.toHaveBeenCalled();
  });
});
