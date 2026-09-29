import { describe, expect, it } from "vitest";

import ApprovalsPage from "@/app/app/approvals/page";

describe("Approvals page deep link", () => {
  it("opens the inbox on the linked item and keeps the way back", async () => {
    const element = await ApprovalsPage({
      searchParams: Promise.resolve({
        id: " exec-1 ",
        kind: "tool",
        returnTo: "/app/command?thread=thread-1&run=run-1",
      }),
    });

    expect(element.key).toBe("tool:exec-1");
    expect(element.props).toEqual({
      focusId: "exec-1",
      focusKind: "tool",
      returnTo: "/app/command?thread=thread-1&run=run-1",
    });
  });

  it("drops a kind, id, or way back it cannot trust", async () => {
    const element = await ApprovalsPage({
      searchParams: Promise.resolve({
        id: "exec-1",
        kind: "access",
        returnTo: "https://example.com/app/command",
      }),
    });

    expect(element.key).toBe("any:exec-1");
    expect(element.props).toEqual({
      focusId: "exec-1",
      focusKind: undefined,
      returnTo: undefined,
    });

    const repeated = await ApprovalsPage({
      searchParams: Promise.resolve({
        id: ["exec-1", "exec-2"],
        kind: "tool",
        returnTo: "/app/approvals?id=exec-1",
      }),
    });
    expect(repeated.key).toBe("queue");
    expect(repeated.props).toEqual({
      focusId: undefined,
      focusKind: undefined,
      returnTo: undefined,
    });
  });

  it("shows the whole queue without a link", async () => {
    const element = await ApprovalsPage({ searchParams: Promise.resolve({}) });

    expect(element.key).toBe("queue");
    expect(element.props).toEqual({
      focusId: undefined,
      focusKind: undefined,
      returnTo: undefined,
    });
  });
});
