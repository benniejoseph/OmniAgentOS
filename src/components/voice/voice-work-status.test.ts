import { afterEach, expect, it, vi } from "vitest";
import { inspectActiveVoiceWork, readVoiceWork, voiceWorkSettled } from "@/components/voice/voice-work-status";
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it("follows Atlas after specialist assignment instead of speaking premature completion", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ run: { id: "root", threadId: "thread", status: "completed", response: "Assigned.",
    delegatedWork: { kind: "subagents", threadId: "thread", status: "accepted" } } })));
  const waiting = await readVoiceWork({ runId: "root", status: "running", text: "Working" }, "thread", signal());
  expect(waiting).toMatchObject({ runId: "root", status: "running" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ run: { id: "root", threadId: "thread", status: "completed",
    delegatedWork: { kind: "subagents", threadId: "thread", status: "accepted", runId: "resumed" } } })));
  expect(await readVoiceWork(waiting, "thread", signal())).toMatchObject({ runId: "resumed", status: "running" });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ run: { id: "resumed", threadId: "thread", status: "completed", response: "Saved and verified." } })));
  expect(await readVoiceWork({ ...waiting, runId: "resumed" }, "thread", signal())).toMatchObject({ status: "completed", text: "Saved and verified." });
});

it("reports a timed-out report as paused with its recorded reason, never a clarification", async () => {
  const fetch = vi.fn(async () => Response.json({ run: { id: "workflow", status: "paused", currentStep: "write_report",
    input: { metadata: { threadId: "thread" } }, approvalRequired: false, error: "AI request timed out after 180 seconds." },
    steps: [{ workflowRunId: "workflow", stepKey: "research", status: "completed", output: { openQuestions: ["Which audience should we serve?"] } }] }));
  vi.stubGlobal("fetch", fetch);
  const reply = await readVoiceWork({ workflowId: "workflow", runId: "root", status: "accepted", text: "Queued" }, "thread", signal());
  expect(reply).toMatchObject({ status: "paused", currentStep: "write_report", failureReason: "AI request timed out after 180 seconds." });
  expect(reply.text).toContain("Recorded reason: AI request timed out");
  expect(reply.text).not.toContain("needs your input");
  expect(reply.text).not.toContain("Which audience");
  expect(voiceWorkSettled(reply)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reads the exact current failed step when the workflow omits its error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ run: { id: "workflow", status: "paused", currentStep: "write_report" }, steps: [
    { workflowRunId: "other", stepKey: "write_report", status: "failed", error: "Foreign error" },
    { workflowRunId: "workflow", stepKey: "research", status: "failed", error: "Old error" },
    { workflowRunId: "workflow", stepKey: "write_report", status: "failed", error: "Report timed out" },
  ] })));
  expect(await readVoiceWork({ workflowId: "workflow", text: "" }, "thread", signal())).toMatchObject({ status: "paused", failureReason: "Report timed out" });
});

it.each([["queued", "accepted"], ["unknown", "unconfirmed"], ["waiting_clarification", "waiting_clarification"]])(
  "preserves %s semantics without claiming active progress", async (state, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ run: { id: "run", status: state, response: state === "waiting_clarification" ? "Which saved project?" : undefined } })));
    const reply = await readVoiceWork({ runId: "run", text: "" }, "thread", signal());
    expect(reply.status).toBe(status);
    expect(reply.text).not.toContain("still running");
    if (state === "waiting_clarification") expect(reply.text).toBe("Which saved project?");
  },
);

it("inspects active work with a single read and never resubmits it", async () => {
  const fetch = vi.fn(async () => Response.json({ run: { id: "workflow", status: "running", currentStep: "write_report", input: { metadata: { threadId: "thread" } } } }));
  vi.stubGlobal("fetch", fetch);
  const reply = await inspectActiveVoiceWork({ workflowId: "workflow", runId: "run", status: "accepted", text: "Queued" }, "thread", signal());
  expect(reply).toMatchObject({ status: "running", workflowId: "workflow", currentStep: "write_report" });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/workflows/workflow", { cache: "no-store", signal: expect.any(AbortSignal) });
});

it("does not turn an unavailable or mismatched read into a running or approval claim", async () => {
  const fetch = vi.fn(async () => Response.json({ run: { id: "other-workflow", status: "running" } }));
  vi.stubGlobal("fetch", fetch);
  expect(await inspectActiveVoiceWork({ workflowId: "workflow", status: "running", text: "Old progress" }, "thread", signal()))
    .toMatchObject({ status: "unconfirmed", workflowId: "workflow", text: expect.stringContaining("could not be checked") });
  expect(await inspectActiveVoiceWork(undefined, "thread", signal())).toMatchObject({ status: "unconfirmed" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
