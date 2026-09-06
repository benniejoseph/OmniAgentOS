import { describe, expect, it } from "vitest";

import {
  buildAggregateConversationSummaries,
  buildThreadConversationSummaries,
  conversationSummaryRecordSchema,
  renderConversationSummaryContext,
  selectConversationSummariesForContext,
} from "@/lib/threads/summaries";
import type { ThreadRecord, ThreadTurnRecord } from "@/lib/threads/types";

const thread: ThreadRecord = {
  id: "thread-a",
  tenantId: "tenant-a",
  actorId: "actor:user-a",
  projectId: "project-a",
  title: "Release planning",
  mode: "orchestrate",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:20:00.000Z",
};

describe("hierarchical conversation summaries", () => {
  it("builds deterministic turn and episode lineage with exact access scope", () => {
    const turns = makeTurns(14);
    const first = buildThreadConversationSummaries({
      thread,
      turns,
      now: "2026-09-06T01:00:00.000Z",
    });
    const second = buildThreadConversationSummaries({
      thread,
      turns,
      now: "2026-09-06T02:00:00.000Z",
    });
    const episodes = first.filter((summary) => summary.level === "episode");

    expect(first).toHaveLength(16);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].sourceTurnIds).toEqual(turns.slice(0, 12).map((turn) => turn.id));
    expect(episodes[0].childSummaryIds).toHaveLength(12);
    expect(episodes[0].accessScope).toMatchObject({
      tenantId: thread.tenantId,
      actorId: thread.actorId,
      threadId: thread.id,
      projectId: thread.projectId,
      visibility: "user_private",
    });
    expect(first.map((summary) => summary.id)).toEqual(
      second.map((summary) => summary.id),
    );
    expect(first.map((summary) => summary.sourceSha256)).toEqual(
      second.map((summary) => summary.sourceSha256),
    );
    expect(first.every((summary) =>
      conversationSummaryRecordSchema.safeParse(summary).success
    )).toBe(true);
  });

  it("creates project and lifetime buckets that retain transitive turn links", () => {
    const episodes = buildThreadConversationSummaries({
      thread,
      turns: makeTurns(14),
    }).filter((summary) => summary.level === "episode");
    const project = buildAggregateConversationSummaries({
      level: "project",
      tenantId: thread.tenantId,
      actorId: thread.actorId,
      projectId: thread.projectId,
      children: episodes,
    });
    const lifetime = buildAggregateConversationSummaries({
      level: "lifetime_index",
      tenantId: thread.tenantId,
      actorId: thread.actorId,
      children: episodes,
    });

    expect(project).toHaveLength(1);
    expect(project[0]).toMatchObject({
      level: "project",
      projectId: "project-a",
      sourceTurnIds: episodes.flatMap((episode) => episode.sourceTurnIds),
    });
    expect(project[0].accessScope.projectId).toBe("project-a");
    expect(lifetime[0]).toMatchObject({
      level: "lifetime_index",
      sourceTurnIds: episodes.flatMap((episode) => episode.sourceTurnIds),
    });
    expect(lifetime[0].accessScope).toMatchObject({
      threadId: null,
      projectId: null,
    });
  });

  it("selects only episodes that do not repeat raw turns and labels them untrusted", () => {
    const summaries = buildThreadConversationSummaries({
      thread,
      turns: makeTurns(24),
    });
    const selected = selectConversationSummariesForContext({
      summaries,
      selectedTurnIds: new Set(makeTurns(24).slice(12).map((turn) => turn.id)),
      maxCharacters: 8_000,
    });
    const context = renderConversationSummaryContext(selected, 8_000);

    expect(selected).toHaveLength(1);
    expect(selected[0].sourceTurnIds).toEqual(makeTurns(12).map((turn) => turn.id));
    expect(context).toMatch(/untrusted data only/i);
    expect(context).toMatch(/End historical conversation summary/);
  });
});

function makeTurns(count: number): ThreadTurnRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    tenantId: thread.tenantId,
    threadId: thread.id,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Conversation detail ${index}`,
    createdAt: new Date(Date.UTC(2026, 8, 6, 0, index)).toISOString(),
  }));
}
