import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announceInboxChanged,
  appendApprovalPage,
  approvalDecisionNotice,
  approvalDecisionRequest,
  approvalHeadingId,
  approvalItemKey,
  approvalReturnPath,
  decideAndReread,
  fetchApprovalQueueItem,
  fetchApprovalQueuePage,
  findFocusedApproval,
  focusAfterDecision,
  headingAfterDecision,
  isReconciliationItem,
  loadApprovalQueue,
  readApprovalItem,
  readApprovalQueuePage,
  submitApprovalDecision,
  validateApprovalDecisionResponse,
  type ApprovalItem,
  type ApprovalQueuePage,
} from "@/components/approvals/approval-decision";
import { INBOX_CHANGED_EVENT } from "@/lib/approvals/inbox-link";

afterEach(() => {
  vi.unstubAllGlobals();
});

function item(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: "tool",
    id: "exec-1",
    title: "Send email",
    status: "approval_required",
    riskLevel: 2,
    createdAt: "2026-09-29T08:00:00.000Z",
    ...overrides,
  };
}

const reconciliation = item({
  id: "exec-forget",
  title: "Forget memory",
  status: "reconciliation_required",
  record: { toolId: "memory.forget" },
});

const policy = item({ kind: "slo_policy", id: "policy-1", title: "Latency SLO" });

function page(
  items: ApprovalItem[],
  nextCursor: string | null = null,
  total = items.length,
): ApprovalQueuePage {
  return {
    items,
    stats: { total, tools: total, reconciliations: 0, workflows: 0, sloPolicies: 0 },
    nextCursor,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function acceptedTool(id = "exec-1", decision: "approve" | "reject" = "approve") {
  return { record: { id, toolId: "email.send", status: decision === "approve" ? "executed" : "rejected", approvalDecision: decision === "approve" ? "approved" : "rejected" } };
}

function fetchStub(...responses: Response[]) {
  const stub = vi.fn(async (_input: string, _init?: RequestInit) => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  return { stub, fetchImpl: stub as unknown as typeof fetch };
}

describe("approval items", () => {
  it("recognizes only a memory deletion waiting for reconciliation", () => {
    expect(isReconciliationItem(reconciliation)).toBe(true);
    expect(isReconciliationItem({ ...reconciliation, kind: "workflow" })).toBe(false);
    expect(isReconciliationItem({ ...reconciliation, status: "approval_required" })).toBe(false);
    expect(isReconciliationItem({ ...reconciliation, record: { toolId: "email.send" } })).toBe(false);
    expect(isReconciliationItem(item())).toBe(false);
  });

  it("keys an item by its kind and id", () => {
    expect(approvalItemKey(item())).toBe("tool:exec-1");
    expect(approvalItemKey(policy)).toBe("slo_policy:policy-1");
  });
});

describe("decision request", () => {
  it("carries the note for an ordinary decision", () => {
    expect(approvalDecisionRequest(item(), "approve", { reason: "Looks right." })).toEqual({
      kind: "tool",
      decision: "approve",
      reason: "Looks right.",
      breakGlass: undefined,
      ticket: undefined,
    });
    expect(approvalDecisionRequest(item(), "reject", { reason: "" }).reason).toBeUndefined();
    expect(approvalDecisionRequest(item(), "approve").reason).toBeUndefined();
  });

  it("sends no note with a reconciliation", () => {
    expect(approvalDecisionRequest(reconciliation, "approve", { reason: "typed anyway" }))
      .toMatchObject({ kind: "tool", decision: "approve", reason: undefined });
  });

  it("sends break-glass and a ticket only when approving a policy change", () => {
    expect(approvalDecisionRequest(policy, "approve", {
      breakGlass: true,
      ticket: "INC-7",
      reason: "Pager storm, approving under the emergency policy.",
    })).toMatchObject({ breakGlass: true, ticket: "INC-7" });
    expect(approvalDecisionRequest(policy, "approve"))
      .toMatchObject({ breakGlass: false, ticket: undefined });
    expect(approvalDecisionRequest(policy, "reject", { breakGlass: true, ticket: "INC-7" }))
      .toMatchObject({ breakGlass: undefined, ticket: undefined });
    expect(approvalDecisionRequest(item(), "approve", { breakGlass: true, ticket: "INC-7" }))
      .toMatchObject({ breakGlass: undefined, ticket: undefined });
  });
});

describe("decision notice", () => {
  const resumeNote =
    " The paused agent run is resuming in the background. Its final answer will appear in Results.";

  it("reports a failed execution as a danger", () => {
    expect(approvalDecisionNotice(item(), "approve", 200, {
      record: { status: "failed", reason: "SMTP refused" },
      continuation: { scheduled: true },
    })).toEqual({
      message: `Approval recorded for Send email, but execution failed: SMTP refused${resumeNote}`,
      tone: "danger",
    });
    expect(approvalDecisionNotice(item(), "approve", 200, { record: { status: "failed" } }))
      .toEqual({ message: "Approval recorded for Send email, but execution failed.", tone: "danger" });
    expect(approvalDecisionNotice(reconciliation, "approve", 200, { record: { status: "failed" } }).message)
      .toBe("Reconciliation finished for Forget memory, but execution failed.");
  });

  it("reports a reconciliation in progress or done", () => {
    expect(approvalDecisionNotice(reconciliation, "approve", 202, {}))
      .toEqual({ message: "Reconciliation is in progress for Forget memory.", tone: "warning" });
    expect(approvalDecisionNotice(reconciliation, "approve", 200, { continuation: { scheduled: true } }))
      .toEqual({ message: `Reconciled and continued: Forget memory.${resumeNote}`, tone: "success" });
  });

  it("reports an approval that still needs others", () => {
    expect(approvalDecisionNotice(item(), "approve", 202, {
      quorum: { message: "One more admin must approve." },
    })).toEqual({
      message: "Approval recorded for Send email. One more admin must approve.",
      tone: "warning",
    });
    expect(approvalDecisionNotice(item(), "approve", 200, {
      approvalProgress: { approvals: 1, required: 2, remaining: 1 },
    })).toEqual({
      message: "Approval recorded for Send email. 1/2 required approvals are recorded.",
      tone: "warning",
    });
    expect(approvalDecisionNotice(item(), "approve", 202, {}).message)
      .toBe("Approval recorded for Send email. 0/1 required approvals are recorded.");
  });

  it("reports a released approval and a rejection", () => {
    expect(approvalDecisionNotice(item(), "approve", 200, { continuation: { scheduled: true } }))
      .toEqual({ message: `Approved and released: Send email.${resumeNote}`, tone: "success" });
    expect(approvalDecisionNotice(item(), "approve", 200, { continuation: { scheduled: false } }))
      .toEqual({ message: "Approved and released: Send email.", tone: "success" });
    expect(approvalDecisionNotice(item(), "reject", 202, {
      continuation: { scheduled: true },
      approvalProgress: { remaining: 1 },
    })).toEqual({ message: "Rejected: Send email.", tone: "success" });
  });
});

describe("submitting a decision", () => {
  it("posts the decision for the encoded id and returns its notice", async () => {
    const { stub, fetchImpl } = fetchStub(jsonResponse({ ...acceptedTool("exec/1?x"), continuation: { scheduled: true } }));

    const notice = await submitApprovalDecision(
      item({ id: "exec/1?x" }),
      "approve",
      { reason: "Looks right." },
      fetchImpl,
    );

    expect(notice.tone).toBe("success");
    expect(notice.message).toContain("Approved and released: Send email.");
    const [url, init] = stub.mock.calls[0]!;
    expect(url).toBe("/api/approvals/exec%2F1%3Fx");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "tool",
      decision: "approve",
      reason: "Looks right.",
    });
  });

  it("sends a decision again under its key until the server answers it", async () => {
    const keys: string[] = [];
    const answers: Array<Response | Error> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      const answer = answers.shift();
      if (!answer || answer instanceof Error) throw answer ?? new Error("unexpected request");
      return answer;
    }) as unknown as typeof fetch;
    const send = async (
      answer: Response | Error,
      decision: "approve" | "reject" = "approve",
      reason = "Checked.",
      id = "exec-keyed",
    ) => {
      answers.push(answer);
      await submitApprovalDecision(item({ id }), decision, { reason }, fetchImpl)
        .catch(() => undefined);
      return keys.at(-1);
    };
    const lost = () => new TypeError("Failed to fetch");

    const first = await send(lost());
    expect(first).toMatch(/^approval-approve-[0-9a-f-]{36}$/);
    await expect(submitApprovalDecision(item({ id: "exec-keyed" }), "reject", {}, fetchImpl)).rejects.toThrow("already pending");
    await expect(submitApprovalDecision(item({ id: "exec-keyed" }), "approve", { reason: "Changed" }, fetchImpl)).rejects.toThrow("already pending");
    expect(keys).toHaveLength(1);
    expect(await send(new Response("", { status: 503 }))).toBe(first);
    expect(await send(jsonResponse({ error: "Already decided." }, 409))).toBe(first);
    expect(await send(jsonResponse({}))).toBe(first);
    expect(await send(jsonResponse(acceptedTool("exec-keyed")))).toBe(first);
    expect(await send(jsonResponse(acceptedTool("exec-keyed")))).not.toBe(first);
  });

  it("throws the server's reason", async () => {
    await expect(submitApprovalDecision(
      item(),
      "reject",
      {},
      fetchStub(jsonResponse({ error: "Already decided." }, 409)).fetchImpl,
    )).rejects.toThrow("Already decided.");
    await expect(submitApprovalDecision(
      item(),
      "reject",
      {},
      fetchStub(jsonResponse({ message: "Session expired.", error: "unauthorized" }, 401)).fetchImpl,
    )).rejects.toThrow("Session expired.");
    await expect(submitApprovalDecision(
      item({ id: "exec-unavailable" }),
      "reject",
      {},
      fetchStub(new Response("<html>", { status: 502 })).fetchImpl,
    )).rejects.toThrow("unconfirmed");
  });

  it("rejects wrong identities, wrong decisions and malformed quorum receipts", () => {
    expect(() => validateApprovalDecisionResponse("exact", { kind: "tool", decision: "approve" }, 200, acceptedTool("other"))).toThrow();
    expect(() => validateApprovalDecisionResponse("exact", { kind: "tool", decision: "reject" }, 200, acceptedTool("exact"))).toThrow();
    expect(() => validateApprovalDecisionResponse("exact", { kind: "tool", decision: "approve" }, 202, { record: { id: "exact", toolId: "email.send", status: "approval_required" }, quorum: { have: 0, need: 2 } })).toThrow();
    expect(() => validateApprovalDecisionResponse("exact", { kind: "workflow", decision: "approve" }, 200, acceptedTool("exact"))).toThrow();
  });

  it("separates exact workflow and policy authority from a successful status code", () => {
    expect(validateApprovalDecisionResponse("workflow-1", { kind: "workflow", decision: "approve" }, 200, { run: { id: "workflow-1", status: "queued", approvedAt: "2026-10-04T00:00:00Z" } })).toHaveProperty("run");
    expect(() => validateApprovalDecisionResponse("workflow-1", { kind: "workflow", decision: "approve" }, 200, { run: { id: "workflow-1", status: "queued" } })).toThrow();
    expect(validateApprovalDecisionResponse("policy-1", { kind: "slo_policy", decision: "reject" }, 200, { change: { id: "policy-1", status: "rejected" } })).toHaveProperty("change");
  });

  it("never follows an accepted receipt with an old-owner read", async () => {
    let current = true;
    const stub = vi.fn(async () => { current = false; return jsonResponse(acceptedTool("owner-held")); });
    await expect(decideAndReread(item({ id: "owner-held" }), "approve", {}, stub as unknown as typeof fetch,
      { scope: "owner-held-scope", isCurrent: () => current })).rejects.toThrow("unconfirmed");
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe("reading the queue", () => {
  it("keeps only items with an id and a known kind", () => {
    expect(readApprovalItem(item())).toEqual(item());
    expect(readApprovalItem({ ...item(), id: "" })).toBeUndefined();
    expect(readApprovalItem({ ...item(), id: 7 })).toBeUndefined();
    expect(readApprovalItem({ ...item(), kind: "access" })).toBeUndefined();
    expect(readApprovalItem([item()])).toBeUndefined();
    expect(readApprovalItem(null)).toBeUndefined();
  });

  it("reads a page and fills what is missing", () => {
    expect(readApprovalQueuePage({
      items: [item(), { id: "no-kind" }, policy],
      stats: { total: 2, tools: 1, sloPolicies: "1" },
      nextCursor: "cursor-2",
    })).toEqual({
      items: [item(), policy],
      stats: { total: 2, tools: 1, reconciliations: 0, workflows: 0, sloPolicies: 1 },
      nextCursor: "cursor-2",
    });
    const empty = {
      items: [],
      stats: { total: 0, tools: 0, reconciliations: 0, workflows: 0, sloPolicies: 0 },
      nextCursor: null,
    };
    expect(readApprovalQueuePage(undefined)).toEqual(empty);
    expect(readApprovalQueuePage([item()])).toEqual(empty);
    expect(readApprovalQueuePage({ items: "x", stats: 3, nextCursor: "" })).toEqual(empty);
  });

  it("shows each item once when a later page repeats one", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const workflowA = item({ kind: "workflow", id: "a" });
    expect(appendApprovalPage([a], [a, b, workflowA, b])).toEqual([a, b, workflowA]);
    expect(appendApprovalPage([], [a])).toEqual([a]);
  });

  it("requests a page with its limit and cursor", async () => {
    const { stub, fetchImpl } = fetchStub(
      jsonResponse(page([item()], "cursor-2", 3)),
      jsonResponse(page([], null, 3)),
    );

    await expect(fetchApprovalQueuePage({}, fetchImpl))
      .resolves.toMatchObject({ items: [item()], nextCursor: "cursor-2" });
    await fetchApprovalQueuePage({ limit: 10, cursor: "cursor-2" }, fetchImpl);

    expect(stub.mock.calls.map(([url]) => url)).toEqual([
      "/api/approvals?limit=25",
      "/api/approvals?limit=10&cursor=cursor-2",
    ]);
    expect(stub.mock.calls[0]![1]).toEqual({ cache: "no-store" });
  });

  it("throws when a page cannot be read", async () => {
    await expect(fetchApprovalQueuePage(
      {},
      fetchStub(jsonResponse({ error: "The cursor is not valid." }, 400)).fetchImpl,
    )).rejects.toThrow("The cursor is not valid.");
    await expect(fetchApprovalQueuePage(
      {},
      fetchStub(new Response("", { status: 503 })).fetchImpl,
    )).rejects.toThrow("Approvals returned 503");
  });
});

describe("loading the shown part of the queue", () => {
  it("reads one page when it holds what is shown", async () => {
    const shown = Array.from({ length: 25 }, (_, index) => item({ id: `exec-${index}` }));
    const fetchPage = vi.fn(async () => page(shown, "cursor-2", 30));

    await expect(loadApprovalQueue(25, fetchPage)).resolves.toEqual(page(shown, "cursor-2", 30));
    expect(fetchPage.mock.calls).toEqual([[{ limit: 25 }]]);
  });

  it("reads further pages from the top until the shown count", async () => {
    const first = Array.from({ length: 100 }, (_, index) => item({ id: `first-${index}` }));
    const second = Array.from({ length: 50 }, (_, index) => item({ id: `second-${index}` }));
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page(first, "cursor-2", 180))
      .mockResolvedValueOnce({ ...page(second, "cursor-3", 999) });

    const queue = await loadApprovalQueue(150, fetchPage);

    expect(fetchPage.mock.calls).toEqual([
      [{ limit: 100 }],
      [{ limit: 50, cursor: "cursor-2" }],
    ]);
    expect(queue.items).toHaveLength(150);
    expect(queue.stats.total).toBe(180);
    expect(queue.nextCursor).toBe("cursor-3");
  });

  it("stops at the end of the queue", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce(page([item({ id: "a" })], "cursor-2"))
      .mockResolvedValueOnce(page([item({ id: "b" })], null));

    const queue = await loadApprovalQueue(75, fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(queue.items.map((value) => value.id)).toEqual(["a", "b"]);
    expect(queue.nextCursor).toBeNull();
  });

  it("asks again for items a repeated one displaced, within a bound", async () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const repeating = vi.fn()
      .mockResolvedValueOnce(page([a], "cursor-2"))
      .mockResolvedValueOnce(page([a], "cursor-3"))
      .mockResolvedValueOnce(page([b], "cursor-4"));

    await expect(loadApprovalQueue(2, repeating))
      .resolves.toMatchObject({ items: [a, b], nextCursor: "cursor-4" });
    expect(repeating.mock.calls).toEqual([
      [{ limit: 2 }],
      [{ limit: 1, cursor: "cursor-2" }],
      [{ limit: 1, cursor: "cursor-3" }],
    ]);

    const stuck = vi.fn(async () => page([a], "cursor-again"));
    await expect(loadApprovalQueue(5, stuck)).resolves.toMatchObject({ items: [a] });
    expect(stuck).toHaveBeenCalledTimes(4);
  });

  it("bounds the shown count", async () => {
    const fetchPage = vi.fn(async (request: { limit: number; cursor?: string | null }) =>
      page(
        Array.from({ length: request.limit }, (_, index) => item({ id: `${request.cursor ?? "top"}-${index}` })),
        `after-${request.cursor ?? "top"}`,
      ));

    expect((await loadApprovalQueue(1_000, fetchPage)).items).toHaveLength(200);
    expect(fetchPage.mock.calls).toEqual([
      [{ limit: 100 }],
      [{ limit: 100, cursor: "after-top" }],
    ]);
    fetchPage.mockClear();
    await loadApprovalQueue(Number.NaN, fetchPage);
    await loadApprovalQueue(0, fetchPage);
    await loadApprovalQueue(-5, fetchPage);
    expect(fetchPage.mock.calls.map(([request]) => request.limit)).toEqual([25, 25, 1]);
  });
});

describe("the item a link opened", () => {
  it("reads one item by id and kind", async () => {
    const { stub, fetchImpl } = fetchStub(
      jsonResponse({ item: item({ id: "exec/1" }) }),
      jsonResponse({ item: null }),
    );

    await expect(fetchApprovalQueueItem({ id: "exec/1", kind: "tool" }, fetchImpl))
      .resolves.toEqual(item({ id: "exec/1" }));
    await expect(fetchApprovalQueueItem({ id: "decided" }, fetchImpl)).resolves.toBeUndefined();
    expect(stub.mock.calls.map(([url]) => url)).toEqual([
      "/api/approvals?id=exec%2F1&kind=tool",
      "/api/approvals?id=decided",
    ]);
    expect(stub.mock.calls[0]![1]).toEqual({ cache: "no-store" });
  });

  it.each([
    { label: "malformed item", body: { item: { id: "exec-1", kind: "bogus" } } },
    { label: "missing item field", body: {} },
    { label: "different item identity", body: { item: item({ id: "exec-other" }) } },
    { label: "different item kind", body: { item: item({ kind: "workflow" }) } },
  ])("rejects a $label instead of presenting it as absent", async ({ body }) => {
    await expect(fetchApprovalQueueItem(
      { id: "exec-1", kind: "tool" },
      fetchStub(jsonResponse(body)).fetchImpl,
    )).rejects.toThrow("The approval response did not match the requested item.");
  });

  it("throws when the item cannot be read", async () => {
    await expect(fetchApprovalQueueItem(
      { id: "exec-1" },
      fetchStub(jsonResponse({ error: "Operator role required." }, 403)).fetchImpl,
    )).rejects.toThrow("Operator role required.");
    await expect(fetchApprovalQueueItem(
      { id: "exec-1" },
      fetchStub(new Response("", { status: 500 })).fetchImpl,
    )).rejects.toThrow("The approval could not be loaded (500).");
  });

  it("uses the shown queue when it answers", async () => {
    const fetchItem = vi.fn();
    const shown = item({ id: "exec-2" });

    await expect(findFocusedApproval(page([item(), shown], "cursor-2"), { id: "exec-2", kind: "tool" }, fetchItem))
      .resolves.toEqual({ status: "ready", item: shown });
    await expect(findFocusedApproval(page([item(), shown], "cursor-2"), { id: "exec-2" }, fetchItem))
      .resolves.toEqual({ status: "ready", item: shown });
    await expect(findFocusedApproval(page([item()]), { id: "exec-2" }, fetchItem))
      .resolves.toEqual({ status: "missing" });
    await expect(findFocusedApproval(page([item()]), { id: "exec-1", kind: "workflow" }, fetchItem))
      .resolves.toEqual({ status: "missing" });
    expect(fetchItem).not.toHaveBeenCalled();
  });

  it("reads the item by id when later pages may hold it", async () => {
    const later = item({ id: "exec-9" });
    const fetchItem = vi.fn()
      .mockResolvedValueOnce(later)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(item({ kind: "workflow", id: "exec-9" }));
    const queue = page([item()], "cursor-2");

    await expect(findFocusedApproval(queue, { id: "exec-9", kind: "tool" }, fetchItem))
      .resolves.toEqual({ status: "ready", item: later });
    await expect(findFocusedApproval(queue, { id: "exec-9", kind: "tool" }, fetchItem))
      .resolves.toEqual({ status: "missing" });
    await expect(findFocusedApproval(queue, { id: "exec-9", kind: "tool" }, fetchItem))
      .resolves.toEqual({ status: "missing" });
    expect(fetchItem).toHaveBeenCalledWith({ id: "exec-9", kind: "tool" });
  });
});

describe("the way back after deciding", () => {
  const back = "/app/command?thread=thread-1&run=run-1";
  const released = { message: "Approved and released: Send email.", tone: "success" as const };

  it("goes back once the item a link opened went through", () => {
    expect(approvalReturnPath(item(), released, { id: "exec-1", kind: "tool" }, back)).toBe(back);
    expect(approvalReturnPath(item(), released, { id: "exec-1" }, back)).toBe(back);
  });

  it("stays for another item, a notice to read, or nowhere to go", () => {
    expect(approvalReturnPath(item({ id: "exec-2" }), released, { id: "exec-1" }, back)).toBeUndefined();
    expect(approvalReturnPath(item(), released, { id: "exec-1", kind: "workflow" }, back)).toBeUndefined();
    expect(approvalReturnPath(item(), released, undefined, back)).toBeUndefined();
    expect(approvalReturnPath(item(), released, { id: "exec-1" }, undefined)).toBeUndefined();
    for (const tone of ["warning", "danger", "neutral"] as const) {
      expect(approvalReturnPath(item(), { message: "", tone }, { id: "exec-1" }, back)).toBeUndefined();
    }
  });
});

describe("deciding outside the inbox", () => {
  function recordingFetch(...responses: Response[]) {
    const events: string[] = [];
    const target = new EventTarget();
    target.addEventListener(INBOX_CHANGED_EVENT, () => events.push("changed"));
    vi.stubGlobal("window", target);
    const calls: Array<{ url: string; method?: string; announced: number }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, announced: events.length });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as unknown as typeof fetch;
    return { events, calls, fetchImpl };
  }

  it("sends the decision, tells the badge, then reads the item again", async () => {
    const recorded = item({
      riskLevel: 3,
      record: { approvals: [{ by: "first-admin", role: "admin" }] },
    });
    const { events, calls, fetchImpl } = recordingFetch(
      jsonResponse({ record: { id: "exec-1", toolId: "email.send", status: "approval_required" }, quorum: { have: 1, need: 2 }, approvalProgress: { approvals: 1, required: 2, remaining: 1 } }, 202),
      jsonResponse({ item: recorded }),
    );

    await expect(decideAndReread(item({ riskLevel: 3 }), "approve", { reason: "Checked." }, fetchImpl))
      .resolves.toEqual({
        notice: {
          message: "Approval recorded for Send email. 1/2 required approvals are recorded.",
          tone: "warning",
        },
        item: recorded,
      });
    expect(calls).toEqual([
      { url: "/api/approvals/exec-1", method: "POST", announced: 0 },
      { url: "/api/approvals?id=exec-1&kind=tool", method: undefined, announced: 1 },
    ]);
    expect(events).toEqual(["changed"]);
  });

  it("keeps the notice when the item is gone or cannot be read", async () => {
    const released = { message: "Approved and released: Send email.", tone: "success" };

    const gone = recordingFetch(jsonResponse(acceptedTool()), jsonResponse({ item: null }));
    await expect(decideAndReread(item(), "approve", {}, gone.fetchImpl))
      .resolves.toEqual({ notice: released, item: undefined });

    const unreadable = recordingFetch(jsonResponse(acceptedTool()), new Response("", { status: 500 }));
    await expect(decideAndReread(item(), "approve", {}, unreadable.fetchImpl))
      .resolves.toEqual({ notice: released, item: undefined });
    expect(unreadable.events).toEqual(["changed"]);
  });

  it("throws a refused decision without announcing or reading again", async () => {
    const { events, calls, fetchImpl } = recordingFetch(
      jsonResponse({ error: "Already decided." }, 409),
    );

    await expect(decideAndReread(item(), "reject", {}, fetchImpl)).rejects.toThrow("Already decided.");
    expect(calls).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe("inbox change announcement", () => {
  it("fires the change event on the window", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener(INBOX_CHANGED_EVENT, listener);
    vi.stubGlobal("window", target);

    announceInboxChanged();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a window", () => {
    expect(() => announceInboxChanged()).not.toThrow();
  });
});

describe("where focus goes once a decision is read back", () => {
  const shown = ["tool:a", "tool:b", "tool:c"];

  it("names each card's heading by the card's key", () => {
    expect(approvalHeadingId("tool:exec-1")).toBe("approval-heading-tool:exec-1");
  });

  it("stays on the decided card while it is still listed", () => {
    expect(headingAfterDecision({ key: "tool:b", index: 1 }, shown, "list"))
      .toBe("approval-heading-tool:b");
    expect(headingAfterDecision({ key: "tool:c", index: 0 }, shown, "list"))
      .toBe("approval-heading-tool:c");
  });

  it("goes to the card now in its place, or else the last one", () => {
    expect(headingAfterDecision({ key: "tool:x", index: 0 }, shown, "list"))
      .toBe("approval-heading-tool:a");
    expect(headingAfterDecision({ key: "tool:x", index: 1 }, shown, "list"))
      .toBe("approval-heading-tool:b");
    expect(headingAfterDecision({ key: "tool:x", index: 3 }, shown, "list"))
      .toBe("approval-heading-tool:c");
    expect(headingAfterDecision({ key: "tool:x", index: 9 }, shown, "list"))
      .toBe("approval-heading-tool:c");
  });

  it("goes to the heading of the list when no card is left", () => {
    expect(headingAfterDecision({ key: "tool:x", index: 0 }, [], "list")).toBe("list");
    expect(headingAfterDecision({ key: "tool:x", index: -1 }, shown, "list")).toBe("list");
  });

  function page(active: "body" | "nothing" | "elsewhere") {
    const body = { tagName: "BODY" };
    const focused: string[] = [];
    const fake = {
      body,
      activeElement: active === "body" ? body : active === "nothing" ? null : { tagName: "BUTTON" },
      getElementById: (id: string) => (id === "list" ? null : { focus: () => focused.push(id) }),
    };
    return { page: fake as unknown as Parameters<typeof focusAfterDecision>[0], focused };
  }

  it("moves focus there only once it was lost", () => {
    for (const active of ["body", "nothing"] as const) {
      const lost = page(active);
      focusAfterDecision(lost.page, { key: "tool:x", index: 1 }, shown, "list");
      expect(lost.focused).toEqual(["approval-heading-tool:b"]);
    }

    const moved = page("elsewhere");
    focusAfterDecision(moved.page, { key: "tool:x", index: 1 }, shown, "list");
    expect(moved.focused).toEqual([]);

    // A heading no longer in the page is passed over.
    const gone = page("body");
    expect(() => focusAfterDecision(gone.page, { key: "tool:x", index: 0 }, [], "list")).not.toThrow();
    expect(gone.focused).toEqual([]);
  });
});
