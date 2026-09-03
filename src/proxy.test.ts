import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

describe("canonical Asael origin", () => {
  it("permanently redirects the exact legacy public host with path and query intact", () => {
    const response = proxy(
      new NextRequest(
        "https://omniagent-os.vercel.app/app/command?conversation=active",
      ),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://asael.bennierichard.com/app/command?conversation=active",
    );
  });

  it("does not redirect staged Vercel deployment hosts", () => {
    const response = proxy(
      new NextRequest(
        "https://omniagent-preview-benniejosephs-projects.vercel.app/api/health",
      ),
    );

    expect(response.headers.get("location")).toBeNull();
  });
});
