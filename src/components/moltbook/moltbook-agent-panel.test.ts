import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  normalizeMoltbookAutonomy,
  safeMoltbookUrl,
} from "@/components/moltbook/moltbook-agent-panel";

const panel = readFileSync(
  "src/components/moltbook/moltbook-agent-panel.tsx",
  "utf8",
);
const arsenal = readFileSync(
  "src/components/agent-arsenal-workspace.tsx",
  "utf8",
);

describe("Moltbook agent panel", () => {
  it("opens only exact HTTPS Moltbook links", () => {
    expect(safeMoltbookUrl("https://www.moltbook.com/claim/abc")).toBe(
      "https://www.moltbook.com/claim/abc",
    );
    expect(
      safeMoltbookUrl("http://www.moltbook.com/claim/abc"),
    ).toBeUndefined();
    expect(safeMoltbookUrl("https://moltbook.com/claim/abc")).toBeUndefined();
    expect(
      safeMoltbookUrl("https://www.moltbook.com.attacker.example/claim/abc"),
    ).toBeUndefined();
    expect(
      safeMoltbookUrl("https://user@www.moltbook.com/claim/abc"),
    ).toBeUndefined();
    expect(
      safeMoltbookUrl("https://www.moltbook.com:444/claim/abc"),
    ).toBeUndefined();
    expect(safeMoltbookUrl("not a URL")).toBeUndefined();
  });
});

describe("Moltbook Agent console boundaries", () => {
  it("holds ambiguous registration outcomes without offering a retry", () => {
    expect(panel).not.toContain("retry_registration");
    expect(panel).not.toContain("Retry registration");
    expect(panel).toContain("Registration is held");
  });

  it("shows management only for the exact isolated Moltbook boundary", () => {
    expect(arsenal).toContain(
      "isExactMoltbookAgentCapabilityBoundary(selected.custom)",
    );
    expect(arsenal).toContain("{selectedIsExactMoltbook ? (");
    expect(arsenal).toContain(
      "selected.custom?.manageable === true && !selectedIsExactMoltbook",
    );
    expect(arsenal).not.toContain("selectedHasMoltbook");
  });

  it("renders uncertain and pending-verification activity as warnings", () => {
    expect(panel).toContain('["uncertain", "pending_verification"]');
    expect(panel).toContain("data-tone={tone}");
  });

  it("requires explicit autonomy disclosure and exposes an immediate pause", () => {
    expect(panel).toContain("MOLTBOOK_AUTONOMY_DISCLOSURE_VERSION");
    expect(panel).toContain("autonomyDisclosureAccepted");
    expect(panel).toContain('onAction("pause_autonomy")');
    expect(panel).toContain("Pause now");
    expect(panel).toContain("Run once");
    expect(panel).toContain("Revoke authority");
  });

  it("holds run and resume controls when effective authority is unavailable", () => {
    expect(panel).toContain('displayStatus === "blocked"');
    expect(panel).toContain('data-state={displayStatus}');
    expect(panel).toContain("Public actions are held.");
    expect(panel).toContain("!autonomy.executable");
    expect(panel).toContain("autonomyBlockedMessage(effectiveBlockedReason)");
  });

  it("gates a new standing grant on the live claimed credentialed connection", () => {
    expect(panel).toContain('connection?.status === "claimed"');
    expect(panel).toContain('connection.claimState === "claimed"');
    expect(panel).toContain("connection.credentialConfigured === true");
    expect(panel).toContain("Boolean(busyAction) || !connectionReady");
    expect(panel).toContain('!connectionReady\n      ? "connection_unavailable"');
  });

  it("makes the public autonomy boundary plain", () => {
    expect(panel).toContain("independently read and take at most one public");
    expect(panel).toContain("action per check-in");
    expect(panel).toContain("strict daily budgets");
    expect(panel).toContain("control of this");
    expect(panel).toContain("Mac remain excluded");
  });
});

describe("Moltbook autonomy projection", () => {
  it("normalizes enrollment fields, singular budgets, interests, and cycles", () => {
    const autonomy = normalizeMoltbookAutonomy({
      executable: true,
      enrollment: {
        status: "enabled",
        budgets: {
          cycleIntervalSeconds: 14_400,
          daily: {
            posts: 1,
            comments: 6,
            votes: 12,
            follows: 2,
            subscriptions: 2,
          },
        },
        nextCycleAt: "2026-09-22T04:00:00.000Z",
      },
      dailyUsage: {
        posts: 1,
        comments: 2,
        votes: 3,
        follows: 0,
        subscriptions: 1,
        resetAt: "2026-09-22T01:00:00.000Z",
      },
      interests: [
        {
          topic: "agent safety",
          score: 0.82,
          confidence: 0.7,
          evidenceSha256s: ["digest-one", "digest-two"],
        },
      ],
      recentCycles: [
        {
          id: "cycle-1",
          status: "succeeded",
          triggerKind: "scheduled",
          completedAt: "2026-09-21T20:00:00.000Z",
          agentRunId: "run-1",
        },
      ],
    });

    expect(autonomy).toMatchObject({
      status: "enabled",
      executable: true,
      cadenceMs: 14_400_000,
      lastCycleAt: "2026-09-21T20:00:00.000Z",
      nextCycleAt: "2026-09-22T04:00:00.000Z",
      lastRunId: "run-1",
      budgetResetAt: "2026-09-22T01:00:00.000Z",
    });
    expect(
      autonomy?.budgets.map(({ key, used, limit }) => ({
        key,
        used,
        limit,
      })),
    ).toEqual([
      { key: "post", used: 1, limit: 1 },
      { key: "comment", used: 2, limit: 6 },
      { key: "vote", used: 3, limit: 12 },
      { key: "follow", used: 0, limit: 2 },
      { key: "subscribe", used: 1, limit: 2 },
    ]);
    expect(autonomy?.interests).toEqual([
      {
        topic: "agent safety",
        score: 0.82,
        confidence: 0.7,
        evidenceCount: 2,
      },
    ]);
    expect(autonomy?.cycles[0]).toMatchObject({
      id: "cycle-1",
      status: "succeeded",
      trigger: "scheduled",
      runId: "run-1",
    });
  });

  it("accepts flat aliases and fails closed on an unknown status", () => {
    expect(normalizeMoltbookAutonomy({ status: "surprise" })).toBeNull();
    expect(
      normalizeMoltbookAutonomy({
        status: "active",
        executable: true,
        cadenceMs: 28_800_000,
        dailyPostLimit: 1,
        dailyPostUsed: 0,
        dailyCommunityJoinsLimit: 2,
        dailyCommunityJoinsUsed: 1,
      }),
    ).toMatchObject({
      status: "enabled",
      executable: true,
      cadenceMs: 28_800_000,
      budgets: [
        { key: "post", used: 0, limit: 1 },
        { key: "comment", used: 0, limit: 0 },
        { key: "vote", used: 0, limit: 0 },
        { key: "follow", used: 0, limit: 0 },
        { key: "subscribe", used: 1, limit: 2 },
      ],
    });
  });

  it("fails closed on missing or unrecognized execution readiness", () => {
    expect(normalizeMoltbookAutonomy({ status: "enabled" })).toMatchObject({
      status: "enabled",
      executable: false,
      blockedReason: "authority_unavailable",
    });
    expect(normalizeMoltbookAutonomy({
      status: "paused",
      executable: false,
      blockedReason: "connection_unavailable",
    })).toMatchObject({
      status: "paused",
      executable: false,
      blockedReason: "connection_unavailable",
    });
    expect(normalizeMoltbookAutonomy({
      status: "enabled",
      executable: "true",
      blockedReason: "database_detail",
    })).toMatchObject({
      status: "enabled",
      executable: false,
      blockedReason: "authority_unavailable",
    });
  });
});
