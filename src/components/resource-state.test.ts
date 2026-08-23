import { describe, expect, it } from "vitest";
import {
  beginResourceRefresh,
  settleResourceRefresh,
  type ResourceState,
} from "@/components/resource-state";

describe("progressive resource state", () => {
  it("retains stale data while refreshing and after a failed refresh", () => {
    const current: ResourceState<{ rows: string[] }> = {
      status: "ready",
      data: { rows: ["existing"] },
    };

    expect(beginResourceRefresh(current)).toEqual({
      status: "loading",
      data: { rows: ["existing"] },
    });
    expect(
      settleResourceRefresh(current, {
        status: "error",
        error: "temporarily unavailable",
      }),
    ).toEqual({
      status: "error",
      data: { rows: ["existing"] },
      error: "temporarily unavailable",
      stale: true,
    });
  });

  it("does not turn a first-load failure into empty data", () => {
    expect(
      settleResourceRefresh(
        { status: "idle" },
        { status: "error", error: "unavailable" },
      ),
    ).toEqual({
      status: "error",
      error: "unavailable",
    });
  });
});
