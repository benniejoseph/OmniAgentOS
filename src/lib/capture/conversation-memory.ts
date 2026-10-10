import { databaseMemoryAccessScopeFromExecutionScope } from "@/lib/db/memory-access-scope";
import { getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { buildUserPrivateMemoryAccessBindingV1, MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { indexUserPrivateMemoryGraphRecords } from "@/lib/memory/graph";
import { saveMemories } from "@/lib/memory/store";
import { embedTexts } from "@/lib/openai/client";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { getCaptureRecording } from "@/lib/capture/recordings";
import { getCaptureMediaHead } from "@/lib/capture/media-store";
import { sha256Json } from "@/lib/capture/media-contracts";
import type { CaptureIngestGuard } from "@/lib/capture/ingest-guard";

/**
 * The owner's Listen agreement authorizes one source-backed episode per
 * conversation. This never asserts an inferred preference as a user fact or
 * executes a transcript instruction. General Knowledge uploads cannot opt in
 * by setting metadata; the original scoped recording is checked again here.
 */
type ConversationMemoryInput = {
  guard: CaptureIngestGuard;
  documentId: string;
  evidenceUnitIds: string[];
  executionScope: ExecutionScope;
  abortSignal: AbortSignal;
};

export async function rememberProcessedConversation(input: ConversationMemoryInput) {
  return runWithDatabaseActorScope(input.guard.tenantId, [input.guard.actorId], () => rememberWithinOwnerScope(input));
}

async function rememberWithinOwnerScope(input: ConversationMemoryInput) {
  if (input.guard.kind !== "recording" || input.guard.nativeRecording) return 0;
  const { tenantId, actorId, captureId: recordingId } = input.guard;
  const owner = { tenantId, actorId };
  const recording = await getCaptureRecording(recordingId, owner);
  if (!recording || recording.metadata.listen !== true || recording.metadata.processingTerms !== "listen-processing:1" ||
    recording.ingestJobId !== input.guard.ingestJobId) return 0;
  const [source] = await getSql()`SELECT 1 AS accepted FROM omni_listen_sources
    WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND recording_id = ${recordingId}
      AND source_key_sha256 = ${String(recording.metadata.listenSourceKeySha256 || "")}
      AND tombstoned_at IS NULL`;
  if (!source) return 0;
  const media = await getCaptureMediaHead(recordingId, owner);
  const output = media?.output;
  if (!output?.conversation || output.conversation.processedTurnCount !== output.turns.length) {
    throw new Error("The conversation's complete notes are not ready to remember.");
  }
  if (input.executionScope.tenantId !== tenantId || input.executionScope.initiatingActorId !== actorId) {
    throw new Error("Conversation memory does not match its owner.");
  }
  const canonicalActorId = recording.metadata.listenCanonicalActorId;
  if (typeof canonicalActorId !== "string" || canonicalActorId !== `actor:${recording.metadata.listenAuthUserId}`) {
    throw new Error("The conversation's memory owner could not be verified.");
  }
  const [identity] = await getSql()`SELECT public.omni_native_private_memory_owner_v1(
    ${tenantId}, ${actorId}, ${canonicalActorId}, TRUE) AS allowed`;
  if (identity?.allowed !== true) throw new Error("The conversation owner no longer has permission to save memory.");
  const executionScope = createExecutionScope({ ...input.executionScope,
    initiatingActorId: canonicalActorId, purpose: "capture.conversation.remember" });
  const observedAt = typeof recording.metadata.recordedAt === "string"
    ? recording.metadata.recordedAt : recording.startedAt;
  const content = [
    `Conversation recorded on ${observedAt}. These are automatic source notes; stated claims and relationships have not been independently verified.`,
    `Context: ${recording.metadata.contextCategory || "unfiled"}.`,
    `Topics: ${output.conversation.categories.join(", ")}.`,
    boundedNotes("Overview", output.summary.text.split("\n\n"), 3_000),
    boundedNotes("Stated context", output.conversation.keyFacts.map((item) => item.text), 2_000),
    boundedNotes("Relationships mentioned", output.conversation.relationships.map((item) => item.text), 1_500),
    boundedNotes("Decisions", output.decisions.map((item) => item.text), 1_000),
    boundedNotes("Follow-ups", output.actionItems.map((item) => `(${item.ownerParticipantId ? "speaker confirmed in source" : "owner needs confirmation"}${item.dueAt ? `, due ${item.dueAt}` : ""}): ${item.text}`), 2_000),
    boundedNotes("Open questions", output.conversation.openQuestions.map((item) => item.text), 1_000),
    "This memory is a condensed index. Read the linked conversation in Knowledge for complete notes, exact citations and the transcript.",
  ].filter(Boolean).join("\n\n");
  const [embedding] = await embedTexts([`${recording.title}\n\n${content}`], input.abortSignal, {
    tenantId, actorId: canonicalActorId, sourceStreamId: `capture-recording:${recording.id}`,
    operation: "embedding", purpose: "capture.conversation.remember",
    correlationId: executionScope.correlationId,
    causationId: executionScope.causationId || undefined,
    executionScope, credentialSource: "deployment_environment",
  }) || [];
  input.abortSignal.throwIfAborted();
  const accessBinding = buildUserPrivateMemoryAccessBindingV1({
    tenantId, ownerActorId: canonicalActorId, originPurpose: "capture.conversation.remember",
    accessBoundAt: output.processedAt,
  });
  const databaseAccessScope = databaseMemoryAccessScopeFromExecutionScope(executionScope, {
    purposeId: MEMORY_PURPOSE_IDS.write,
    auditPurpose: "Remember source notes from an explicitly enabled Listen conversation.",
  });
  const records = await saveMemories([{
    id: `conversation-memory:${sha256Json({ tenantId, actorId, recordingId, documentId: input.documentId })}`,
    tenantId, type: "episode", tier: "episodic", title: recording.title,
    content, source: recording.source, scope: "user", assertedBy: "import",
    formationOrigin: "source_observation", confidence: 0.75, importance: 0.7,
    validFrom: observedAt,
    tags: [...new Set(["conversation", recording.metadata.sourceKind === "call" ? "call notes" : "listening notes",
      ...output.conversation.categories, ...recording.tags])].slice(0, 50),
    evidenceRefs: [`knowledge:${input.documentId}`, output.mediaRevisionId,
      ...input.evidenceUnitIds.slice(0, 20).map((id) => `evidence:${id}`),
      ...output.summary.citations.map((citation) => citation.turnId)].slice(0, 50),
    embedding, accessBinding, databaseAccessScope, executionScope,
  }], { captureIngestGuard: input.guard });
  input.abortSignal.throwIfAborted();
  await indexUserPrivateMemoryGraphRecords(records, "capture.conversation.remember", {
    tenantId, accessScope: databaseAccessScope,
  });
  return records.length;
}

function boundedNotes(label: string, notes: string[], budget: number) {
  if (!notes.length) return "";
  const selected = notes.length <= 20 ? notes : Array.from({ length: 20 }, (_, index) =>
    notes[Math.round(index * (notes.length - 1) / 19)]);
  const share = Math.floor((budget - label.length - 30) / selected.length) - 2;
  return `${label}:\n${selected.map((note) => note.length > share ? `${note.slice(0, share - 1)}…` : note).join("\n")}\n${selected.length < notes.length ? "More in the linked notes." : ""}`;
}
