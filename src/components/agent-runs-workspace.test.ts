import { readFileSync } from "node:fs";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/app-shell/session-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/app-shell/session-context")>();
  return {
    ...actual,
    useWorkspaceSession: () => ({
      session: {
        authEnabled: true,
        authenticated: true,
        context: { tenantId: "test-tenant", actorId: "owner@example.test", role: "operator" },
        user: { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" },
      },
      status: "ready",
      role: "operator",
      refresh: async () => undefined,
      signOut: async () => undefined,
    }),
  };
});

const {
  AgentRunsWorkspace,
  ConversationMessageContent,
  TranscriptTurn,
  projectionForTurn,
  sameTranscriptTurn,
} = await import("@/components/agent-runs-workspace");

const source = readFileSync("src/components/agent-runs-workspace.tsx", "utf8");

describe("Command routing preference", () => {
  it("lets the server choose between a direct run and a workflow", () => {
    expect(source.match(/strategy: "auto",/g)).toHaveLength(2);
    expect(source).not.toContain('strategy: "direct",');
    expect(source).not.toContain('"auto" : "direct"');
  });
});

describe("announcing a run", () => {
  it("announces from outside the view that is busy while a run streams", () => {
    const html = renderToStaticMarkup(createElement(AgentRunsWorkspace));

    // Assistive technology may hold back what changes in a busy view, so the
    // announcer is its sibling, not inside it.
    expect(html).toMatch(
      /^<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">Run workspace ready\.<\/p><div class="[^"]*" aria-busy="(true|false)" data-testid="work-workspace">/,
    );
    expect(html.match(/role="status" aria-live="polite" aria-atomic="true">Run workspace ready\./g))
      .toHaveLength(1);
  });

  it("announces each phase of a streamed run once, and none of the steps between", () => {
    const handler = source.slice(
      source.indexOf("const handleStreamEvent = (event: StreamEvent) => {"),
      source.indexOf("const cursor: SseCursor"),
    );
    expect(handler.match(/setRunAnnouncement\(/g)).toHaveLength(1);
    expect(handler).toContain("const announcement = runStreamAnnouncement(event);");
  });
});

type TurnProps = Parameters<typeof sameTranscriptTurn>[0];

function turnProps(overrides: Partial<TurnProps> = {}): TurnProps {
  return {
    turn: {
      id: "turn-2",
      role: "assistant",
      content: "The plan is ready.",
      createdAt: "2026-09-30T10:00:00.000Z",
      runId: "run-7",
    },
    assistantName: "Ada",
    assistantRole: "Chief of staff",
    onOpenActivity: () => undefined,
    ...overrides,
  };
}

const projection: NonNullable<TurnProps["projection"]> = {
  runId: "run-7",
  artifacts: [{
    executionId: "run-7",
    sequence: 1,
    kind: "image",
    operation: "generate",
    assetId: "asset_chart",
    filename: "chart.png",
    mediaType: "image/png",
    byteCount: 2_048,
    status: "stored",
    createdAt: "2026-09-30T10:00:00.000Z",
  }],
  files: [{
    executionId: "run-7",
    sequence: 2,
    artifactId: `generated_artifact_${"a".repeat(48)}`,
    version: 1,
    kind: "document",
    title: "Quarterly plan",
    filename: "quarterly-plan.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteCount: 4_096,
    status: "ready",
    createdAt: "2026-09-30T10:00:00.000Z",
  }],
  fileState: "unavailable",
  workspaceArtifacts: [{
    executionId: "run-7",
    sequence: 3,
    provider: "google_workspace",
    kind: "spreadsheet",
    resourceId: "sheet_resource_123",
    title: "Budget sheet",
    createdAt: "2026-09-30T10:00:00.000Z",
  }],
  workspaceArtifactState: "pending",
};

const projected = [
  "chart.png",
  "Quarterly plan",
  "The created file preview is temporarily unavailable",
  "Budget sheet",
  "Checking for a Google Workspace result",
];

function findElement(node: unknown, type: string): ReactElement<{ onClick?: () => void }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<{ children?: unknown; onClick?: () => void }>(node)) return undefined;
  return node.type === type ? node : findElement(node.props.children, type);
}

describe("rendering past turns", () => {
  it("renders a past turn again only when what it shows changes", () => {
    const previous = turnProps({ projection });
    // A reloaded thread brings new objects for the same turns.
    expect(sameTranscriptTurn(previous, {
      ...previous,
      turn: { ...previous.turn, createdAt: "2026-09-30T10:05:00.000Z" },
    })).toBe(true);
    for (const [change, next] of [
      ["id", { ...previous, turn: { ...previous.turn, id: "turn-3" } }],
      ["role", { ...previous, turn: { ...previous.turn, role: "user" } }],
      ["content", { ...previous, turn: { ...previous.turn, content: "The plan changed." } }],
      ["runId", { ...previous, turn: { ...previous.turn, runId: "run-8" } }],
      ["assistantName", { ...previous, assistantName: "Grace" }],
      ["assistantRole", { ...previous, assistantRole: undefined }],
      ["projection", { ...previous, projection: { ...projection } }],
      ["onOpenActivity", { ...previous, onOpenActivity: () => undefined }],
    ] as const) {
      expect([change, sameTranscriptTurn(previous, next)]).toEqual([change, false]);
    }
    expect(TranscriptTurn).toMatchObject({ $$typeof: Symbol.for("react.memo"), compare: sameTranscriptTurn });
    expect(ConversationMessageContent).toMatchObject({ $$typeof: Symbol.for("react.memo") });
  });

  it("shows who wrote each turn, and a run's artifacts and activity on its turn", () => {
    const user = renderToStaticMarkup(createElement(TranscriptTurn, turnProps({
      turn: { id: "turn-1", role: "user", content: "Draft the plan.", createdAt: "2026-09-30T09:59:00.000Z" },
    })));
    expect(user).toContain(">You</p>");
    expect(user).toContain(">Draft the plan.</p>");
    expect(user).not.toContain("Ada");

    const shows = (props: TurnProps) => {
      const html = renderToStaticMarkup(createElement(TranscriptTurn, props));
      return ["Ada", "· Chief of staff", "The plan is ready.", "View activity", ...projected]
        .filter((text) => html.includes(text));
    };
    expect(shows(turnProps({ projection }))).toEqual([
      "Ada",
      "· Chief of staff",
      "The plan is ready.",
      "View activity",
      ...projected,
    ]);
    expect(shows(turnProps())).toEqual(["Ada", "· Chief of staff", "The plan is ready.", "View activity"]);
    expect(shows(turnProps({
      assistantRole: undefined,
      turn: { ...turnProps().turn, runId: undefined },
    }))).toEqual(["Ada", "The plan is ready."]);
  });

  it("shows a run's artifacts only on the turn that run wrote", () => {
    expect(projectionForTurn({ runId: "run-7" }, projection)).toBe(projection);
    expect(projectionForTurn({ runId: "run-8" }, projection)).toBeUndefined();
    // Before any run, the projection belongs to none.
    expect(projectionForTurn({ runId: "" }, { ...projection, runId: "" })).toBeUndefined();
    expect(projectionForTurn({}, projection)).toBeUndefined();
  });

  it("opens the activity of the turn's run", () => {
    const onOpenActivity = vi.fn();
    // A memoized component keeps the one it renders as its type.
    const render = (TranscriptTurn as unknown as { type: (props: TurnProps) => unknown }).type;
    findElement(render(turnProps({ onOpenActivity })), "button")?.props.onClick?.();
    expect(onOpenActivity.mock.calls).toEqual([["run-7"]]);
  });
});
