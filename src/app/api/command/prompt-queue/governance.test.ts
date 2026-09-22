import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("prompt queue governed dispatch boundary", () => {
  it("authorizes the ordinary Agent route before admitting private queue headers", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/app/api/agent/route.ts"),
      "utf8",
    );
    const authorization = source.indexOf("context = await authorizeRequest({");
    const headerRead = source.indexOf("const queuedItemId = request.headers");
    const admission = source.indexOf("queuedDispatch = await validatePromptQueueDispatch({");
    const runner = source.indexOf("runAgent(", admission);

    expect(authorization).toBeGreaterThan(0);
    expect(headerRead).toBeGreaterThan(authorization);
    expect(admission).toBeGreaterThan(headerRead);
    expect(runner).toBeGreaterThan(admission);
    expect(source).toContain(
      "Boolean(queuedItemId) !== Boolean(queuedDispatchToken)",
    );
    expect(source).toContain("sessionId: queuedSessionId");
    expect(source).toContain(
      "ownerActorId: queueActorBinding.canonicalActorId",
    );
    expect(source).toContain("runtimeModelPin: queuedDispatch ? {");
  });

  it("re-enters the governed route with a freshly claimed private token", async () => {
    const source = await readFile(
      path.join(
        process.cwd(),
        "src/app/api/command/prompt-queue/[id]/dispatch/route.ts",
      ),
      "utf8",
    );

    expect(source).toContain("await claimPromptQueueDispatch({");
    expect(source).toContain(
      "headers.set(PROMPT_QUEUE_DISPATCH_TOKEN_HEADER, claimed.dispatchToken)",
    );
    expect(source).toContain(
      'response = await fetch(internalRequest, { redirect: "manual" })',
    );
    expect(source).not.toContain('@/app/api/agent/route');
    expect(source).toContain('headers.set("accept-encoding", "identity")');
    expect(source).toContain("!productionDispatchOrigins().has(requestUrl.origin)");
    expect(source).toContain("ownerActorId: authority.ownerActorId");
    expect(source).not.toMatch(/executionScope:\s*authority\.executionScope[\s\S]*body: JSON\.stringify/);
  });
});
