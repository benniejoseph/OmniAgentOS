import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  executeLocalComputerCommand: vi.fn(),
}));

vi.mock("@/lib/local-computer/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-computer/store")>()),
  executeLocalComputerCommand: mocks.executeLocalComputerCommand,
}));

describe("governed local Mac tools", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-local-computer-tool-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    mocks.executeLocalComputerCommand.mockResolvedValue({
      publicResult: { summary: "Observed the active Mac workspace." },
      observation: {
        snapshotRevision: "a".repeat(64),
        frontmostApplication: {
          name: "Finder",
          bundleId: "com.apple.finder",
          pid: 123,
        },
        accessibilitySnapshot: "id=e1 role=AXWindow label=Finder",
        screenshot: {
          mimeType: "image/png",
          dataBase64: Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          ]).toString("base64"),
          widthPixels: 1_440,
          heightPixels: 900,
          coordinateSpace: "screenshot_pixel",
          coordinateContract: {
            display: { id: 42, logicalBounds: { x: -1_512, y: 0 } },
          },
        },
      },
    });
  });

  it("discloses an observation for one model turn but never persists it", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const execution = await executeGovernedTool({
      toolId: "local.macos.observe",
      input: { includeScreenshot: true, presentScreenshot: true },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("observe"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-observe",
    });

    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "observe",
        runId: "run-local",
        toolInput: {
          includeScreenshot: true,
          presentScreenshot: true,
        },
        executionScope: expect.objectContaining({
          tenantId: "tenant-local",
          initiatingActorId: "owner-local",
        }),
      }),
    );
    expect(execution.result).toEqual({
      summary: "Observed the active Mac workspace.",
    });
    expect(execution.record.output).toEqual(execution.result);
    expect(execution.record.output).not.toHaveProperty("observation");
    expect(execution.record.output).not.toHaveProperty("presentScreenshot");
    expect(execution.computerObservation).toMatchObject({
      source: "local_macos",
      snapshotRevision: "a".repeat(64),
      applicationState: {
        name: "Finder",
        bundleId: "com.apple.finder",
      },
      screenshot: {
        mimeType: "image/png",
        widthPixels: 1_440,
        heightPixels: 900,
        coordinateSpace: "screenshot_pixel",
      },
    });
    expect(execution.computerObservation).not.toHaveProperty(
      "screenshot.coordinateContract",
    );
  });

  it("exposes preview presentation as an explicit, default-off tool input", async () => {
    const { getGovernedTool } = await import("@/lib/tools/registry");
    const observe = getGovernedTool("local.macos.observe");
    const properties = observe?.inputSchema.properties as
      | Record<string, unknown>
      | undefined;

    expect(observe?.description).toContain("short-lived in-memory preview");
    expect(properties?.presentScreenshot).toMatchObject({
      type: "boolean",
      default: false,
      description: expect.stringContaining("explicit request"),
    });
  });

  it("does not use a caller-supplied native version as screenshot authority", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const result = await executeGovernedTool({
      toolId: "local.macos.observe",
      input: { includeScreenshot: true, presentScreenshot: true },
      dryRun: false,
      context: {
        ...securityContext(),
        native: {
          ...securityContext().native,
          clientContractVersion: 11,
        },
      },
      executionScope: executionScope("observe-v11"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-observe-v11",
    });

    expect(result.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledOnce();
  });

  it("presents one screenshot after approval reconstruction without a client-version claim", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const result = await executeGovernedTool({
      toolId: "local.macos.observe",
      input: { includeScreenshot: true, presentScreenshot: true },
      dryRun: false,
      context: {
        tenantId: "tenant-local",
        actorId: "owner-local",
        role: "admin",
        source: "session",
      },
      executionScope: executionScope("observe-after-approval"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-observe-after-approval",
    });

    expect(result.record.status).toBe("executed");
    expect(result.computerObservation?.screenshot).toEqual({
      mimeType: "image/png",
      dataBase64: expect.any(String),
      widthPixels: 1_440,
      heightPixels: 900,
      coordinateSpace: "screenshot_pixel",
    });
    expect(result.computerObservation).not.toHaveProperty(
      "screenshot.coordinateContract",
    );
    expect(result.record.output).not.toHaveProperty("observation");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-local",
        executionScope: expect.objectContaining({
          tenantId: "tenant-local",
          initiatingActorId: "owner-local",
          correlationId: "local-mac-observe-after-approval",
        }),
      }),
    );
  });

  it("validates native URL-opening input before it can reach the command store", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");

    await expect(executeGovernedTool({
      toolId: "local.macos.open_url",
      input: {
        browser: "chrome",
        url: "file:///Users/example/private.html",
        loadWaitSeconds: 3,
      },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("open-url-invalid"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-open-url-invalid",
    })).rejects.toMatchObject({ name: "ToolInputValidationError" });

    expect(mocks.executeLocalComputerCommand).not.toHaveBeenCalled();
  });

  it("carries an explicit post-navigation preview request into the native command", async () => {
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const pending = await executor.executeGovernedTool({
      toolId: "local.macos.open_url",
      input: {
        browser: "chrome",
        url: "https://in.tradingview.com/chart/example?symbol=OANDA%3AXAUUSD",
        loadWaitSeconds: 8,
        presentScreenshot: true,
      },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("open-url-preview"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-open-url-preview",
    });
    const claimToken = "local-mac-open-url-preview-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId: "tenant-local",
      approvedBy: "owner-local",
      approvedRole: "admin",
      claimToken,
    });
    const result = await executor.executeGovernedTool({
      toolId: pending.record.toolId,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: securityContext(),
      agentRunId: "run-local",
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(result.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "open_url",
        toolInput: expect.objectContaining({ presentScreenshot: true }),
      }),
    );
    expect(result.record.output).not.toHaveProperty("observation");
  });

  it("fails closed when an idempotent observe call tries to replay consumed evidence", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const input = {
      toolId: "local.macos.observe",
      input: { includeScreenshot: true },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("observe-replay"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-observe-replay",
    } as const;

    const first = await executeGovernedTool(input);
    expect(first.computerObservation).toBeDefined();

    await expect(executeGovernedTool(input)).rejects.toMatchObject({
      name: "LocalComputerObservationExpiredError",
      code: "local_computer_observation_expired",
    });
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledOnce();
  });

  it("rejects a successful observe command that has no fresh observation", async () => {
    mocks.executeLocalComputerCommand.mockResolvedValueOnce({
      publicResult: { summary: "Observation already consumed." },
    });
    const { executeGovernedTool } = await import("@/lib/tools/executor");

    const result = await executeGovernedTool({
      toolId: "local.macos.observe",
      input: { includeScreenshot: true },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("observe-empty"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-observe-empty",
    });

    expect(result).toMatchObject({
      record: {
        status: "failed",
        reason: expect.stringContaining("fresh visual evidence"),
      },
      result: null,
    });
    expect(result).not.toHaveProperty("computerObservation");
  });

  it("does not enqueue a consequential local action before approval", async () => {
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = {
      snapshotRevision: "b".repeat(64),
      elementId: "e1-2",
    };
    const pending = await executor.executeGovernedTool({
      toolId: "local.macos.press",
      input,
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("press"),
      agentRunId: "run-local",
      idempotencyKey: "local-mac-press",
    });

    expect(pending.record.status).toBe("approval_required");
    expect(mocks.executeLocalComputerCommand).not.toHaveBeenCalled();

    const claimToken = "local-mac-approval-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId: "tenant-local",
      approvedBy: "owner-local",
      approvedRole: "admin",
      claimToken,
    });
    const executed = await executor.executeGovernedTool({
      toolId: pending.record.toolId,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: securityContext(),
      agentRunId: "run-local",
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(executed.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(1);
    const { listObservabilityEvents } = await import(
      "@/lib/observability/store"
    );
    expect(
      await listObservabilityEvents({
        action: "tool.authority_decided",
        tenantId: "tenant-local",
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: "persisted_approval",
          reviewed: true,
          bindingId: pending.record.id,
          executionId: pending.record.id,
        }),
      }),
    ]);
  });

  it("lets forced approval outrank This Mac task authority", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = {
      toolId: "local.macos.click",
      input: {
        snapshotRevision: "c".repeat(64),
        elementId: "e1-3",
        interactionPurpose: "navigation",
      },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("task", "run-local-task"),
      agentRunId: "run-local-task",
      localComputerTaskAuthority: { objective: "Open the next Finder item." },
    } as const;

    const covered = await executeGovernedTool({
      ...request,
      idempotencyKey: "local-mac-click-task",
    });
    expect(covered.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledOnce();

    // Voice input and "always approve" agent profiles force approval. A task
    // authorization from the same run must not skip that review.
    const forced = await executeGovernedTool({
      ...request,
      forceApproval: true,
      idempotencyKey: "local-mac-click-forced",
    });
    expect(forced.record.status).toBe("approval_required");
    expect(forced.record.reason).not.toContain("task authority");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledOnce();
  });

  it("records the task authority that let a gated Mac action run", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { listObservabilityEvents } = await import(
      "@/lib/observability/store"
    );
    const request = {
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("authority", "run-local-authority"),
      agentRunId: "run-local-authority",
      localComputerTaskAuthority: { objective: "Open the next Finder item." },
    } as const;
    const click = {
      ...request,
      toolId: "local.macos.click",
      input: {
        snapshotRevision: "d".repeat(64),
        elementId: "e1-7",
        interactionPurpose: "navigation",
      },
    } as const;

    // Neither a scroll, which needs no approval, nor a dry run is recorded.
    const scrolled = await executeGovernedTool({
      ...request,
      toolId: "local.macos.scroll",
      input: { snapshotRevision: "d".repeat(64), deltaX: 0, deltaY: 400 },
      idempotencyKey: "local-mac-scroll-authority",
    });
    expect(scrolled.record).toMatchObject({
      status: "executed",
      approvalRequired: false,
    });
    const dryRun = await executeGovernedTool({ ...click, dryRun: true });
    expect(dryRun.record.status).toBe("dry_run");
    const executed = await executeGovernedTool({
      ...click,
      idempotencyKey: "local-mac-click-authority",
    });

    expect(executed.record.status).toBe("executed");
    expect(
      await listObservabilityEvents({
        action: "tool.authority_decided",
        tenantId: "tenant-local",
      }),
    ).toEqual([
      expect.objectContaining({
        level: "info",
        category: "security",
        actorId: "owner-local",
        resourceType: "tool",
        resourceId: "local.macos.click",
        correlationId: "run-local-authority",
        message: `${executed.record.toolName} was authorized by the user's This Mac task authority.`,
        metadata: {
          source: "task_authority",
          reviewed: false,
          forcedReview: false,
          toolName: executed.record.toolName,
          riskLevel: 2,
          executionId: executed.record.id,
          agentRunId: "run-local-authority",
        },
      }),
    ]);
  });

  it("never lets task authority run a record the approval store has not claimed", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = {
      toolId: "local.macos.click",
      input: {
        snapshotRevision: "8".repeat(64),
        elementId: "e1-8",
        interactionPurpose: "navigation",
      },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("unclaimed", "run-local-unclaimed"),
      agentRunId: "run-local-unclaimed",
    } as const;
    const pending = await executeGovernedTool({
      ...request,
      idempotencyKey: "local-mac-click-unclaimed",
    });
    expect(pending.record.status).toBe("approval_required");

    const replayed = await executeGovernedTool({
      ...request,
      existingRecord: pending.record,
      localComputerTaskAuthority: { objective: "Open the next Finder item." },
    });

    expect(replayed.record).toMatchObject({
      id: pending.record.id,
      status: "approval_required",
    });
    expect(mocks.executeLocalComputerCommand).not.toHaveBeenCalled();
  });

  it("keeps task-authorized typing to short single-line text", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const typeText = (text: string, key: string) => executeGovernedTool({
      toolId: "local.macos.type",
      input: { snapshotRevision: "d".repeat(64), text },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("type", "run-local-type"),
      agentRunId: "run-local-type",
      idempotencyKey: `local-mac-type-${key}`,
      localComputerTaskAuthority: { objective: "Search TradingView for gold." },
    });

    const search = await typeText("XAUUSD gold", "search");
    expect(search.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledOnce();

    // A typed line break reaches the app as Return, which sends in most chat
    // and mail apps. Tab moves focus mid-text. Neither may skip review.
    for (const [key, text] of [
      ["line-feed", "Looks good\n"],
      ["carriage-return", "Looks good\r"],
      ["tab", "name\tsecond field"],
      ["line-separator", "first\u2028second"],
      ["escape", "text\u001b"],
      ["c1-next-line", "text\u0085more"],
      ["long", "x".repeat(501)],
    ] as const) {
      const pending = await typeText(text, key);
      expect(pending.record.status, key).toBe("approval_required");
      expect(pending.record.reason, key).toContain("single-line");
    }
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledOnce();
  });

  it("keeps task-authorized navigation on sites the user named", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const openUrl = (url: string, key: string, objective: string) =>
      executeGovernedTool({
        toolId: "local.macos.open_url",
        input: { browser: "chrome", url },
        dryRun: false,
        context: securityContext(),
        executionScope: executionScope("open", "run-local-open"),
        agentRunId: "run-local-open",
        idempotencyKey: `local-mac-open-${key}`,
        localComputerTaskAuthority: { objective },
      });
    const named = "Open tradingview.com and show the XAUUSD chart.";

    for (const [key, url] of [
      ["apex", "https://tradingview.com/chart/?symbol=OANDA%3AXAUUSD"],
      ["www", "https://www.tradingview.com/chart/?symbol=OANDA%3AXAUUSD"],
    ] as const) {
      const opened = await openUrl(url, key, named);
      expect(opened.record.status, key).toBe("executed");
    }
    expect(
      (await openUrl(
        "https://www.youtube.com/results?search_query=gold",
        "named-url",
        "Search https://www.youtube.com/ for gold price videos",
      )).record.status,
    ).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(3);

    // A URL can carry page data to whoever runs the destination. On-screen
    // text must not be able to pick a destination the user never named.
    for (const [key, url, objective] of [
      ["unnamed", "https://attacker.example/c?d=secret", named],
      ["suffix-lookalike", "https://tradingview.com.attacker.example/", named],
      ["prefix-lookalike", "https://eviltradingview.com/", named],
      ["other-subdomain", "https://accounts.tradingview.com/", named],
      ["brand-only", "https://www.tradingview.com/", "Open TradingView."],
      ["email-domain", "https://example.org/", "Email me at owner@example.org."],
    ] as const) {
      const pending = await openUrl(url, key, objective);
      expect(pending.record.status, key).toBe("approval_required");
      expect(pending.record.reason, key).toContain("sites named");
    }
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(3);
  });

  it("switches apps on task authority only to apps the user named", async () => {
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const activate = (bundleId: string, key: string, objective?: string) =>
      executor.executeGovernedTool({
        toolId: "local.macos.activate_app",
        input: { bundleId },
        dryRun: false,
        context: securityContext(),
        executionScope: executionScope("activate", "run-local-activate"),
        agentRunId: "run-local-activate",
        idempotencyKey: `local-mac-activate-${key}`,
        ...(objective === undefined
          ? {}
          : { localComputerTaskAuthority: { objective } }),
      });

    for (const [key, bundleId, objective] of [
      ["spotify", "com.spotify.client", "Play my focus playlist on Spotify."],
      ["chrome", "com.google.Chrome.beta", "Open tradingview.com in Chrome."],
      ["zoom", "us.zoom.xos", "Join the standup in Zoom."],
      ["two-words", "com.microsoft.VSCode", "Open the repo in VS Code."],
      ["edition", "com.microsoft.teams2", "Post the notes to Teams."],
      ["hyphenated", "org.whispersystems.signal-desktop", "Message Sam on Signal."],
      ["no-task", "com.apple.MobileSMS", undefined],
    ] as const) {
      expect((await activate(bundleId, key, objective)).record.status, key)
        .toBe("executed");
    }
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(7);

    // On-screen text must not pick the next app that task authority drives.
    const pending = [];
    for (const [key, bundleId, objective] of [
      ["unnamed", "com.apple.MobileSMS", "Open tradingview.com in Chrome."],
      ["maker-only", "com.google.Chrome", "Search Google for the gold price."],
      ["lookalike", "com.evil.chromex", "Open tradingview.com in Chrome."],
      ["longer-word", "com.google.Chrome", "Compare Chromebook prices."],
      ["kind-only", "com.example.desktop", "Open the desktop app."],
      ["short-name", "com.apple.TV", "Play the next episode on TV."],
    ] as const) {
      const review = await activate(bundleId, key, objective);
      expect(review.record.status, key).toBe("approval_required");
      expect(review.record.reason, key).toContain("apps named in your request");
      pending.push(review.record);
    }
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(7);

    const claimToken = "local-mac-activate-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending[0].id,
      tenantId: "tenant-local",
      approvedBy: "owner-local",
      approvedRole: "admin",
      claimToken,
    });
    const approved = await executor.executeGovernedTool({
      toolId: pending[0].toolId,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: securityContext(),
      agentRunId: "run-local-activate",
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });
    expect(approved.record.status).toBe("executed");
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(8);
  });

  it.each([
    ["task_authority_unattested", "cannot check what a task-authorized action"],
    ["task_authority_refused", "could not confirm that what this action would touch"],
  ] as const)(
    "offers a task-authorized click the Mac turned back (%s) for review",
    async (code, reason) => {
      const { LocalComputerCommandError } = await import(
        "@/lib/local-computer/store"
      );
      const executor = await import("@/lib/tools/executor");
      const store = await import("@/lib/tools/audit-store");
      const seen = markerProbe(store);
      mocks.executeLocalComputerCommand.mockImplementation(async (command) => {
        await seen.record(command.executionId);
        if (seen.marked.length === 1) {
          throw new LocalComputerCommandError(
            code,
            `The installed Mac did not complete the action (${code}).`,
          );
        }
        return { publicResult: { summary: "Opened the next Finder item." } };
      });
      const input = {
        snapshotRevision: "e".repeat(64),
        elementId: "e1-4",
        interactionPurpose: "navigation",
      };

      const review = await executor.executeGovernedTool({
        toolId: "local.macos.click",
        input,
        dryRun: false,
        context: securityContext(),
        executionScope: executionScope(code, `run-local-${code}`),
        agentRunId: `run-local-${code}`,
        idempotencyKey: `local-mac-click-${code}`,
        localComputerTaskAuthority: { objective: "Open the next Finder item." },
      });

      // Task authority alone let this click run, so the Mac had to check what
      // it would touch. When it cannot, or it refuses, the user decides.
      expect(review.record.status).toBe("approval_required");
      expect(review.record.reason).toContain(reason);
      expect(seen.marked).toEqual([true]);
      expect(seen.publicMarkerLeaked).toBe(false);
      const turnedBack = mocks.executeLocalComputerCommand.mock.calls[0]![0]
        .executionId as string;
      expect(review.record.id).not.toBe(turnedBack);
      expect(
        await store.getToolExecution(turnedBack, { tenantId: "tenant-local" }),
      ).toMatchObject({ status: "failed" });

      const claimToken = `local-mac-${code}-review-claim`;
      const claim = await store.approveAndClaimToolExecution({
        id: review.record.id,
        tenantId: "tenant-local",
        approvedBy: "owner-local",
        approvedRole: "admin",
        claimToken,
      });
      const executed = await executor.executeGovernedTool({
        toolId: review.record.toolId,
        input: store.openToolExecutionInput(claim.record!),
        dryRun: false,
        approved: true,
        context: securityContext(),
        agentRunId: `run-local-${code}`,
        existingRecord: claim.record,
        executionClaimToken: claimToken,
      });

      // The approved click is a new command, and a reviewed action never
      // carries the task-authority marker.
      expect(executed.record.status).toBe("executed");
      expect(seen.marked).toEqual([true, false]);
      expect(mocks.executeLocalComputerCommand.mock.calls[1]![0]).toMatchObject({
        executionId: review.record.id,
        toolInput: input,
      });
    },
  );

  it("marks a task-only click that carries no idempotency key", async () => {
    const { LocalComputerCommandError } = await import(
      "@/lib/local-computer/store"
    );
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const seen = markerProbe(store);
    mocks.executeLocalComputerCommand.mockImplementationOnce(async (command) => {
      await seen.record(command.executionId);
      throw new LocalComputerCommandError(
        "task_authority_unattested",
        "The installed Mac did not complete the action (task_authority_unattested).",
      );
    });

    const review = await executor.executeGovernedTool({
      toolId: "local.macos.click",
      input: {
        snapshotRevision: "9".repeat(64),
        elementId: "e1-6",
        interactionPurpose: "navigation",
      },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("unkeyed", "run-local-unkeyed"),
      agentRunId: "run-local-unkeyed",
      localComputerTaskAuthority: { objective: "Open the next Finder item." },
    });

    expect(seen.marked).toEqual([true]);
    expect(review.record.status).toBe("approval_required");
  });

  it("keeps other Mac failures, and failures of reviewed actions, as failures", async () => {
    const { LocalComputerCommandError } = await import(
      "@/lib/local-computer/store"
    );
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const seen = markerProbe(store);
    const failWith = (code: string) =>
      mocks.executeLocalComputerCommand.mockImplementationOnce(
        async (command) => {
          await seen.record(command.executionId);
          throw new LocalComputerCommandError(code, `Failed (${code}).`);
        },
      );
    const click = {
      toolId: "local.macos.click",
      input: {
        snapshotRevision: "f".repeat(64),
        elementId: "e1-5",
        interactionPurpose: "selection",
      },
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("failures", "run-local-failures"),
      agentRunId: "run-local-failures",
    } as const;

    failWith("command_timeout");
    const timedOut = await executor.executeGovernedTool({
      ...click,
      idempotencyKey: "local-mac-click-timeout",
      localComputerTaskAuthority: { objective: "Select the Finder item." },
    });
    expect(timedOut.record.status).toBe("failed");

    const pending = await executor.executeGovernedTool({
      ...click,
      idempotencyKey: "local-mac-click-reviewed",
    });
    expect(pending.record.status).toBe("approval_required");
    const claimToken = "local-mac-click-reviewed-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId: "tenant-local",
      approvedBy: "owner-local",
      approvedRole: "admin",
      claimToken,
    });
    failWith("task_authority_refused");
    const refused = await executor.executeGovernedTool({
      toolId: pending.record.toolId,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: securityContext(),
      agentRunId: "run-local-failures",
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    // The user already reviewed this click, so a refusal code from the Mac
    // cannot start another review.
    expect(refused.record.status).toBe("failed");
    expect(seen.marked).toEqual([true, false]);
    expect(mocks.executeLocalComputerCommand).toHaveBeenCalledTimes(2);
  });
});

/** Records what the command store would see when it claims each execution. */
function markerProbe(store: typeof import("@/lib/tools/audit-store")) {
  const probe = {
    marked: [] as boolean[],
    publicMarkerLeaked: false,
    async record(executionId: string) {
      const record = await store.getToolExecution(executionId, {
        tenantId: "tenant-local",
      });
      probe.marked.push(store.isLocalComputerTaskAuthorityExecution(record!));
      probe.publicMarkerLeaked ||= JSON.stringify(
        store.publicToolExecution(record!),
      ).includes("__localComputerTaskAuthority");
    },
  };
  return probe;
}

function securityContext() {
  return {
    tenantId: "tenant-local",
    actorId: "owner-local",
    role: "admin" as const,
    source: "mobile" as const,
    auth: {
      userId: "user-local",
      email: "owner@example.test",
      sessionId: "mobile-session-local",
      tenantName: "Local",
    },
    native: {
      deviceId: "device-local-macos",
      platform: "macos" as const,
      clientContractVersion: 12,
    },
  };
}

function executionScope(suffix: string, correlationId = `local-mac-${suffix}`) {
  return createExecutionScope({
    tenantId: "tenant-local",
    initiatingActorId: "owner-local",
    executingPrincipalType: "agent",
    executingPrincipalId: "agent:atlas",
    correlationId,
    purpose: "agent.run",
  });
}
