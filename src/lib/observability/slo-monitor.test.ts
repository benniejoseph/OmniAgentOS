import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listIncidents } from "@/lib/diagnostics/incidents";
import {
  getDefaultObservabilitySloPolicies,
  getObservabilitySloSnapshot,
  runObservabilitySloMonitor,
} from "@/lib/observability/slo-monitor";
import { recordRuntimeEvent } from "@/lib/observability/store";
import budgets from "../../../performance-budgets.json";

const quality = vi.hoisted(() => ({ stats: vi.fn() }));

vi.mock("@/lib/observability/agent-quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability/agent-quality")>();
  quality.stats.mockImplementation(actual.getAgentQualityStats);
  return { ...actual, getAgentQualityStats: quality.stats };
});

const tenantId = "tenant-vitals";
let dataDirectory = "";
let page = 0;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "asael-slo-vitals-"));
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("OMNIAGENT_DATA_DIR", dataDirectory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDirectory, { recursive: true, force: true });
});

async function sample(name: "LCP" | "INP" | "CLS", value: number, pageViews = 1) {
  for (let view = 0; view < pageViews; view += 1) {
    page += 1;
    await recordRuntimeEvent({
      category: "api",
      action: "web_vitals.sample",
      route: "/app/agents",
      method: "CLIENT",
      tenantId,
      message: "Sampled browser performance metrics.",
      metadata: {
        metrics: [{ id: `page-${page}`, name, value, rating: "good" }],
        sampled: true,
        sloExcluded: true,
      },
    });
  }
}

function vitalsPolicies() {
  return getDefaultObservabilitySloPolicies().filter((policy) => policy.id.startsWith("web_vitals_"));
}

function judged(evaluations: Awaited<ReturnType<typeof getObservabilitySloSnapshot>>["evaluations"]) {
  return evaluations.map(({ policy, value, breached, severity, threshold, message, insufficientSamples }) => ({
    id: policy.id,
    value,
    breached,
    severity,
    threshold,
    message,
    insufficientSamples,
  }));
}

describe("real-user Web Vitals SLOs", () => {
  it("holds the 75th percentile of sampled page views to the Web Vitals budgets", async () => {
    const policies = vitalsPolicies();
    expect(policies.map((policy) => [policy.id, policy.metric, policy.warningThreshold, policy.criticalThreshold]))
      .toEqual([
        ["web_vitals_lcp_p75", "lcpP75Ms", budgets.lcpMs, 4_000],
        ["web_vitals_inp_p75", "inpP75Ms", budgets.inpMs, 500],
        ["web_vitals_cls_p75", "clsP75", budgets.cls, 0.25],
      ]);
    await sample("LCP", 4_100, 19);
    await sample("INP", 300, 20);
    await sample("CLS", 0.05, 20);

    const early = await getObservabilitySloSnapshot({ tenantId, policies });
    expect(judged(early.evaluations)).toEqual([
      {
        id: "web_vitals_lcp_p75",
        value: 4_100,
        breached: false,
        severity: undefined,
        threshold: undefined,
        message: "Largest Contentful Paint (p75) is not judged yet: 19 of the 20 sampled page views it needs.",
        insufficientSamples: { samples: 19, minimumSamples: 20 },
      },
      {
        id: "web_vitals_inp_p75",
        value: 300,
        breached: true,
        severity: "warning",
        threshold: 200,
        message: "Interaction to Next Paint (p75) breached: 300ms is greater than 200ms.",
        insufficientSamples: undefined,
      },
      {
        id: "web_vitals_cls_p75",
        value: 0.05,
        breached: false,
        severity: undefined,
        threshold: undefined,
        message: "Cumulative Layout Shift (p75) is inside SLO at 0.05.",
        insufficientSamples: undefined,
      },
    ]);
    expect(early.breaches.map((breach) => breach.policy.id)).toEqual(["web_vitals_inp_p75"]);

    await sample("LCP", 4_100);
    const judgedNow = await getObservabilitySloSnapshot({ tenantId, policies });
    expect(judged(judgedNow.evaluations)[0]).toEqual({
      id: "web_vitals_lcp_p75",
      value: 4_100,
      breached: true,
      severity: "critical",
      threshold: 4_000,
      message: "Largest Contentful Paint (p75) breached: 4100ms is greater than 4000ms.",
      insufficientSamples: undefined,
    });
    expect(judgedNow.stats.webVitals).toEqual({
      LCP: { samples: 20, p75: 4_100 },
      INP: { samples: 20, p75: 300 },
      CLS: { samples: 20, p75: 0.05 },
    });
  });

  it("takes its sample floor from the policy, and falls back to twenty", async () => {
    await sample("LCP", 5_000, 3);
    const [lcp] = vitalsPolicies();
    const floorFor = async (minimumSamples: unknown) => {
      const snapshot = await getObservabilitySloSnapshot({
        tenantId,
        policies: [{ ...lcp!, metadata: { minimumSamples } }],
      });
      return snapshot.evaluations[0]!.insufficientSamples;
    };

    expect(await floorFor(3)).toBeUndefined();
    expect(await floorFor(4)).toEqual({ samples: 3, minimumSamples: 4 });
    for (const unusable of [0, -1, 2.5, "3", undefined]) {
      expect(await floorFor(unusable)).toEqual({ samples: 3, minimumSamples: 20 });
    }
  });

  it("leaves an incident open while too few page views are sampled to judge it", async () => {
    await sample("LCP", 5_000, 20);
    const [lcp] = vitalsPolicies();
    const run = (policy: typeof lcp) =>
      runObservabilitySloMonitor({ tenantId, policies: [policy!], queueAlerts: false });
    const fingerprint = "observability:slo:web_vitals_lcp_p75";

    expect((await run(lcp)).incidentActions).toMatchObject([{ fingerprint, created: true }]);

    const unjudged = await run({ ...lcp!, metadata: { minimumSamples: 21 } });
    expect(unjudged.incidentActions).toEqual([]);
    expect((await listIncidents({ tenantId })).map((incident) => [incident.fingerprint, incident.status]))
      .toEqual([[fingerprint, "open"]]);

    const recovered = await run({ ...lcp!, warningThreshold: 6_000, criticalThreshold: 9_000 });
    expect(recovered.incidentActions).toMatchObject([{ fingerprint, resolved: true }]);
    expect(await listIncidents({ tenantId })).toEqual([]);
  });
});

describe("agent SLOs", () => {
  function agentPolicies() {
    return getDefaultObservabilitySloPolicies().filter((policy) => policy.id.startsWith("agent_"));
  }

  async function streamedReplies(durationMs: number, replies: number) {
    for (let reply = 0; reply < replies; reply += 1) {
      await recordRuntimeEvent({
        category: "api",
        action: "agent.first_output",
        route: "/api/agent",
        method: "POST",
        tenantId,
        durationMs,
        message: "Streamed the first text of an agent reply.",
        metadata: { sloExcluded: true },
      });
    }
  }

  it("holds runs, tools, first output, cost and approvals to defaults", () => {
    expect(agentPolicies().map((policy) => [
      policy.id,
      policy.metric,
      policy.comparator,
      policy.warningThreshold,
      policy.criticalThreshold,
      policy.unit,
      policy.metadata.minimumSamples,
    ])).toEqual([
      ["agent_run_success_rate", "runSuccessRate", "less_than", 0.95, 0.8, "ratio", 10],
      ["agent_tool_failure_rate", "toolFailureRate", "greater_than", 0.1, 0.25, "ratio", 20],
      ["agent_first_output_p95", "agentFirstOutputP95Ms", "greater_than", 10_000, 30_000, "ms", 20],
      ["agent_cost_per_run", "costPerRunUsd", "greater_than", 0.5, 2, "usd", 10],
      ["agent_approval_latency_p95", "approvalLatencyP95Ms", "greater_than", 14_400_000, 86_400_000, "ms", 5],
    ]);
  });

  it("judges the time to first output once enough replies streamed", async () => {
    const policies = agentPolicies().filter((policy) => policy.id === "agent_first_output_p95");
    await streamedReplies(12_000, 19);

    const early = await getObservabilitySloSnapshot({ tenantId, policies });
    expect(judged(early.evaluations)).toEqual([{
      id: "agent_first_output_p95",
      value: 12_000,
      breached: false,
      severity: undefined,
      threshold: undefined,
      message: "Agent time to first output (p95) is not judged yet: 19 of the 20 streamed replies it needs.",
      insufficientSamples: { samples: 19, minimumSamples: 20 },
    }]);

    await streamedReplies(12_000, 1);
    const judgedNow = await getObservabilitySloSnapshot({ tenantId, policies });
    expect(judged(judgedNow.evaluations)).toEqual([{
      id: "agent_first_output_p95",
      value: 12_000,
      breached: true,
      severity: "warning",
      threshold: 10_000,
      message: "Agent time to first output (p95) breached: 12000ms is greater than 10000ms.",
      insufficientSamples: undefined,
    }]);
    // A first output is measured on its own, not as a request.
    expect(judgedNow.stats.slo.latencyP95Ms).toBe(0);
    expect(judgedNow.stats.agentFirstOutput).toEqual({ samples: 20, p95Ms: 12_000 });
  });

  it("does not judge the database's agent records without a database", async () => {
    const snapshot = await getObservabilitySloSnapshot({ tenantId, policies: agentPolicies() });

    expect(snapshot.evaluations.map((evaluation) => evaluation.message)).toEqual([
      "Agent run success rate is not judged yet: 0 of the 10 finished runs it needs.",
      "Agent tool failure rate is not judged yet: 0 of the 20 finished tool calls it needs.",
      "Agent time to first output (p95) is not judged yet: 0 of the 20 streamed replies it needs.",
      "Agent cost per run is not judged yet: 0 of the 10 finished runs it needs.",
      "Approval decision time (p95) is not judged yet: 0 of the 5 approval decisions it needs.",
    ]);
    expect(snapshot.healthy).toBe(true);
  });

  it("judges a day of runs, tool calls and approvals", async () => {
    quality.stats.mockResolvedValueOnce({
      runs: { finished: 12, completed: 9, successRate: 0.75, costPerRunUsd: 0.61234567 },
      tools: { finished: 20, failed: 6, failureRate: 0.3 },
      approvals: { decided: 5, latencyP95Ms: 18_000_000 },
    });
    const startedAt = Date.now();

    const snapshot = await getObservabilitySloSnapshot({
      tenantId,
      policies: agentPolicies().filter((policy) => policy.id !== "agent_first_output_p95"),
    });

    expect(judged(snapshot.evaluations).map(({ id, value, severity, message }) => [
      id,
      value,
      severity,
      message,
    ])).toEqual([
      ["agent_run_success_rate", 0.75, "critical", "Agent run success rate breached: 75% is less than 80%."],
      ["agent_tool_failure_rate", 0.3, "critical", "Agent tool failure rate breached: 30% is greater than 25%."],
      ["agent_cost_per_run", 0.612346, "warning", "Agent cost per run breached: $0.6123 is greater than $0.5."],
      [
        "agent_approval_latency_p95",
        18_000_000,
        "warning",
        "Approval decision time (p95) breached: 18000000ms is greater than 14400000ms.",
      ],
    ]);
    const [{ tenantId: asked, since }] = quality.stats.mock.calls.at(-1)!;
    expect(asked).toBe(tenantId);
    // The same day the observability stats cover.
    expect(startedAt - since.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000 - 1_000);
    expect(startedAt - since.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1_000 + 1_000);
    expect(snapshot.agentQuality.runs.finished).toBe(12);
  });
});
