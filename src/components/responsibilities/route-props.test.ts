import { describe, expect, it, vi } from "vitest";
import ResponsibilityPage from "@/app/app/responsibilities/[id]/page";
import { responsibilityHref } from "./model";
import { responsibilityId } from "./client";

vi.mock("./responsibilities-workspace", () => ({ ResponsibilityWorkspace: () => null }));

describe("Responsibility exact route props", () => {
  const id = `responsibility:${"a".repeat(64)}`;
  it("round trips the list link through promised encoded route params", async () => {
    const segment = responsibilityHref(id).split("/").at(-1)!;
    const page = await ResponsibilityPage({ params: Promise.resolve({ id: segment }) });
    expect(page.props.id).toBe(id);
    expect(responsibilityId(page.props.id)).toBe(true);
  });
  it("accepts a raw identity and rejects double encoding without a second decode", async () => {
    expect((await ResponsibilityPage({ params: Promise.resolve({ id }) })).props.id).toBe(id);
    const page = await ResponsibilityPage({ params: Promise.resolve({ id: encodeURIComponent(encodeURIComponent(id)) }) });
    expect(page.props.id).toBe(encodeURIComponent(id));
    expect(responsibilityId(page.props.id)).toBe(false);
  });
  it("contains malformed escapes and preserves an invalid nonempty exact selection", async () => {
    for (const value of ["%", "%E0%A4%A", "responsibility%3Awrong", "other%2Fidentity"]) {
      const page = await ResponsibilityPage({ params: Promise.resolve({ id: value }) });
      expect(page.props.id).toBeTruthy();
      expect(responsibilityId(page.props.id)).toBe(false);
    }
  });
});
