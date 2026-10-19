import { afterEach, expect, it, vi } from "vitest";
import { readVoiceWork } from "@/components/voice/voice-work-status";
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
