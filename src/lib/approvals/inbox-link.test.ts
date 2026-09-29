import { describe, expect, it } from "vitest";
import {
  APPROVAL_KINDS,
  INBOX_CHANGED_EVENT,
  approvalInboxHref,
  approvalReturnLabel,
  commandConversationHref,
  inboxBadgeLabel,
  parseApprovalFocusId,
  parseApprovalKind,
  readInboxCount,
  safeApprovalReturnTo,
} from "@/lib/approvals/inbox-link";

describe("approval kind and id", () => {
  it("accepts only the three approval kinds", () => {
    expect(APPROVAL_KINDS).toEqual(["tool", "workflow", "slo_policy"]);
    for (const kind of APPROVAL_KINDS) {
      expect(parseApprovalKind(kind)).toBe(kind);
    }
    for (const value of ["", "job", "Tool", " tool", "slo", undefined, 1, ["tool"]]) {
      expect(parseApprovalKind(value)).toBeUndefined();
    }
  });

  it("trims an id and refuses an empty, long, or control-character one", () => {
    expect(parseApprovalFocusId("  exec_42  ")).toBe("exec_42");
    expect(parseApprovalFocusId("x".repeat(200))).toBe("x".repeat(200));
    for (const value of [
      "",
      "   ",
      "x".repeat(201),
      "exec\n42",
      "exec\u000042",
      "exec\u001f",
      "exec\u007f",
      undefined,
      42,
      ["exec_42"],
    ]) {
      expect(parseApprovalFocusId(value)).toBeUndefined();
    }
  });
});

describe("return path", () => {
  it.each([
    ["/app", "/app"],
    ["/app/command", "/app/command"],
    [
      "/app/command?thread=0f0e1d2c-3b4a-4596-8778-695a4b3c2d1e&run=run_7",
      "/app/command?thread=0f0e1d2c-3b4a-4596-8778-695a4b3c2d1e&run=run_7",
    ],
    ["/app/results#latest", "/app/results#latest"],
    ["/app/command/../results", "/app/results"],
    ["/app/approvalsx", "/app/approvalsx"],
  ])("keeps the app path %s", (value, expected) => {
    expect(safeApprovalReturnTo(value)).toBe(expected);
  });

  it.each([
    ["an empty value", ""],
    ["a path outside the app", "/login"],
    ["the site root", "/"],
    ["a path that only starts like the app", "/application"],
    ["a relative path", "app/command"],
    ["a protocol-relative URL", "//evil.example/app"],
    ["a protocol-relative URL that names the resolving host", "//return.invalid/app/command"],
    ["an absolute URL", "https://evil.example/app"],
    ["a backslash URL", "/\\evil.example/app"],
    ["a backslash inside the path", "/app\\..\\login"],
    ["a backslash that stays inside the app", "/app\\command"],
    ["a dot segment that leaves the app", "/app/../login"],
    ["an encoded dot segment that leaves the app", "/app/%2e%2e/login"],
    ["the inbox itself", "/app/approvals"],
    ["the inbox with a query", "/app/approvals?id=exec_1"],
    ["a page under the inbox", "/app/approvals/history"],
    ["a dot segment into the inbox", "/app/command/../approvals"],
    ["whitespace", "/app/command?q=a b"],
    ["a tab", "/app/\tcommand"],
    ["a control character", "/app/command\u0000"],
    ["the last C0 control character", "/app/command\u001f"],
    ["a value over 512 characters", `/app/${"x".repeat(508)}`],
    ["a number", 42],
    ["nothing", undefined],
  ])("refuses %s", (_label, value) => {
    expect(safeApprovalReturnTo(value)).toBeUndefined();
  });

  it("accepts a path of exactly 512 characters", () => {
    const value = `/app/${"x".repeat(507)}`;
    expect(value).toHaveLength(512);
    expect(safeApprovalReturnTo(value)).toBe(value);
  });
});

describe("inbox links", () => {
  it("opens the inbox on one item and carries the way back", () => {
    const returnTo = commandConversationHref({
      threadId: "0f0e1d2c-3b4a-4596-8778-695a4b3c2d1e",
      runId: "run_7",
    });
    const href = approvalInboxHref({ id: " exec_42 ", kind: "tool", returnTo });
    const url = new URL(href, "https://asael.test");

    expect(url.pathname).toBe("/app/approvals");
    expect([...url.searchParams]).toEqual([
      ["id", "exec_42"],
      ["kind", "tool"],
      ["returnTo", returnTo],
    ]);
    expect(safeApprovalReturnTo(url.searchParams.get("returnTo"))).toBe(returnTo);
  });

  it("drops what it cannot use", () => {
    expect(approvalInboxHref()).toBe("/app/approvals");
    expect(approvalInboxHref({ id: "", kind: "tool" })).toBe("/app/approvals");
    expect(approvalInboxHref({ id: "exec_42" })).toBe("/app/approvals?id=exec_42");
    expect(approvalInboxHref({ returnTo: "//evil.example" })).toBe("/app/approvals");
    expect(approvalInboxHref({ returnTo: "/app/command" }))
      .toBe("/app/approvals?returnTo=%2Fapp%2Fcommand");
    expect(approvalInboxHref({
      id: "exec_42",
      kind: "job" as never,
      returnTo: "/app/approvals",
    })).toBe("/app/approvals?id=exec_42");
  });

  it("reopens a conversation on its run", () => {
    expect(commandConversationHref({})).toBe("/app/command");
    expect(commandConversationHref({ threadId: "thread-1" }))
      .toBe("/app/command?thread=thread-1");
    expect(commandConversationHref({ runId: "run@a/b+c" }))
      .toBe("/app/command?run=run%40a%2Fb%2Bc");
    const href = commandConversationHref({ threadId: "thread-1", runId: "run@a/b+c" });
    const url = new URL(href, "https://asael.test");
    expect(url.searchParams.get("thread")).toBe("thread-1");
    expect(url.searchParams.get("run")).toBe("run@a/b+c");
    expect(safeApprovalReturnTo(href)).toBe(href);
  });

  it("names the way back after the page it returns to", () => {
    expect(approvalReturnLabel("/app/command?thread=thread-1&run=run-1"))
      .toBe("Back to conversation");
    expect(approvalReturnLabel("/app/command")).toBe("Back to conversation");
    expect(approvalReturnLabel("/app/command/history")).toBe("Go back");
    expect(approvalReturnLabel("/app/today#approvals")).toBe("Go back");
  });
});

describe("inbox count", () => {
  it("names the change event", () => {
    expect(INBOX_CHANGED_EVENT).toBe("asael:inbox-changed");
  });

  it("reads the count and the parts the caller may see", () => {
    expect(readInboxCount({ pending: 3, approvals: 2, accessRequests: 1 }))
      .toStrictEqual({ pending: 3, approvals: 2, accessRequests: 1 });
    expect(readInboxCount({ pending: 0, approvals: 0 }))
      .toStrictEqual({ pending: 0, approvals: 0 });
    expect(readInboxCount({ pending: 4, approvals: -1, accessRequests: "2" }))
      .toStrictEqual({ pending: 4 });
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["an array", [3]],
    ["no pending count", { approvals: 3 }],
    ["a negative count", { pending: -1 }],
    ["a fractional count", { pending: 1.5 }],
    ["a string count", { pending: "3" }],
    ["an unsafe count", { pending: 2 ** 60 }],
  ])("refuses %s", (_label, value) => {
    expect(readInboxCount(value)).toBeUndefined();
  });

  it("labels a badge", () => {
    expect(inboxBadgeLabel(undefined)).toBe("");
    expect(inboxBadgeLabel(0)).toBe("");
    expect(inboxBadgeLabel(-2)).toBe("");
    expect(inboxBadgeLabel(Number.NaN)).toBe("");
    expect(inboxBadgeLabel(Number.POSITIVE_INFINITY)).toBe("");
    expect(inboxBadgeLabel(0.5)).toBe("");
    expect(inboxBadgeLabel(1)).toBe("1");
    expect(inboxBadgeLabel(2.7)).toBe("2");
    expect(inboxBadgeLabel(99)).toBe("99");
    expect(inboxBadgeLabel(100)).toBe("99+");
  });
});
