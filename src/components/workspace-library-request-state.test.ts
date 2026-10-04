import { describe, expect, it } from "vitest";
import { createLibraryReadAccess } from "./workspace-library-request-state";

describe("Library collection access epochs", () => {
  it("fences a held exact response after collection authorization fails", () => {
    const access = createLibraryReadAccess();
    const list = access.begin()!, exact = access.begin()!;
    access.revoke();
    expect(access.current(list)).toBe(false);
    expect(access.current(exact)).toBe(false);
    expect(exact.controller.signal.aborted).toBe(true);
    expect(access.begin()).toBeUndefined();
    access.retry();
    expect(access.current(access.begin()!)).toBe(true);
    expect(access.current(exact)).toBe(false);
  });
  it("keeps an independent read alive when only another request is canceled", () => {
    const access = createLibraryReadAccess();
    const list = access.begin()!, exact = access.begin()!;
    access.cancel(exact);
    expect(access.current(exact)).toBe(false);
    expect(access.current(list)).toBe(true);
  });
});
