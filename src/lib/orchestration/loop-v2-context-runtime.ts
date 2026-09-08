import type { ResolvedAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import type { RequestEntityAccessV1 } from "@/lib/entities/request-access";
import {
  resolveAgentPromptMemoryAccess,
  type RequestMemoryAccessV1,
} from "@/lib/memory/request-access";
import {
  resolvePersonalContextMemoryAccess,
  type RequestPersonalContextMemoryAccessV1,
} from "@/lib/memory/personal-context-access";
import {
  resolveSharedAgentPromptMemoryAccess,
  type RequestSharedMemoryAccessV1,
} from "@/lib/memory/shared-context";
import {
  buildLoopV2ContextBindingV1,
  type LoopV2ContextBindingV1,
} from "@/lib/orchestration/loop-v2-context-contract";
import {
  buildLoopV2ContextManifest,
  loopV2ContextManifestSha256,
} from "@/lib/orchestration/loop-v2-outcome";
import { escapeUntrustedPromptText } from "@/lib/orchestration/prompts";
import type { ChatMessage } from "@/lib/orchestration/types";
import { estimateContextTokens } from "@/lib/rag/context-budget";
import { buildCitationSources } from "@/lib/rag/citations";
import { buildContextPack } from "@/lib/rag/context-engine";
import { CONTEXT_COMPILER_V2_AUTOMATIC_VERSION_ID } from "@/lib/rag/context-compiler-v2";
import type { ContextScopeId } from "@/lib/rag/context-scope";
import type { ContextSelectionLockBinding } from "@/lib/rag/context-selection-lock";
import { buildContextUseReceiptV1 } from "@/lib/rag/context-use-receipt";
import type { ContextManifestV1 } from "@/lib/runs/contracts";
import {
  appendContextCompilerV2AutomaticEvent,
  appendContextCompilerV2CanaryEvent,
  appendContextCompilerV2ShadowEventSafely,
  appendContextUseReceiptEvent,
  appendLoopV2ContextBinding,
  updateRunContextCount,
} from "@/lib/runs/store";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  workflowAgentPrivateAuthoritySha256,
  workflowAgentPrivateDatabaseAccessScope,
} from "@/lib/workflows/agent-private-context";

const MAX_SESSION_CONTEXT_CHARS = 6_000;
const MAX_RETRIEVED_CONTEXT_TOKENS = 2_048;

export type LoopV2ContextRuntimeRequest = Readonly<{
  message: string;
  summaryInput: string;
  messages: readonly ChatMessage[];
  contextScope: ContextScopeId;
  contextSelection?: ContextSelectionLockBinding;
  promptMemoryAccess?: RequestMemoryAccessV1;
  promptSharedMemoryAccess?: RequestSharedMemoryAccessV1;
  promptPersonalMemoryAccess?: RequestPersonalContextMemoryAccessV1;
  promptEntityGraphAccess?: RequestEntityAccessV1;
  securityContext: SecurityContext;
  executionScope: ExecutionScope;
  agentId: string;
  agentIdentity: ResolvedAgentIdentityV1;
  runId: string;
  providerId: string;
}>;

export type PreparedLoopV2Context = Readonly<{
  modelInput: string;
  contextManifest: ContextManifestV1;
  contextBinding: LoopV2ContextBindingV1;
  selectedEvidenceCount: number;
}>;

export type LoopV2ContextRuntimeDependencies = Readonly<{
  buildContext: typeof buildContextPack;
  appendCompilerShadow: typeof appendContextCompilerV2ShadowEventSafely;
  appendCompilerCanary: typeof appendContextCompilerV2CanaryEvent;
  appendCompilerAutomatic: typeof appendContextCompilerV2AutomaticEvent;
  resolvePersonalAccess: typeof resolvePersonalContextMemoryAccess;
  appendUseReceipt: typeof appendContextUseReceiptEvent;
  appendContextBinding: typeof appendLoopV2ContextBinding;
  updateContextCount: typeof updateRunContextCount;
}>;

export const loopV2ContextRuntimeDependencies:
  LoopV2ContextRuntimeDependencies = Object.freeze({
    buildContext: buildContextPack,
    appendCompilerShadow: appendContextCompilerV2ShadowEventSafely,
    appendCompilerCanary: appendContextCompilerV2CanaryEvent,
    appendCompilerAutomatic: appendContextCompilerV2AutomaticEvent,
    resolvePersonalAccess: resolvePersonalContextMemoryAccess,
    appendUseReceipt: appendContextUseReceiptEvent,
    appendContextBinding: appendLoopV2ContextBinding,
    updateContextCount: updateRunContextCount,
  });

export async function prepareLoopV2Context(
  request: LoopV2ContextRuntimeRequest,
  dependencies: LoopV2ContextRuntimeDependencies =
    loopV2ContextRuntimeDependencies,
): Promise<PreparedLoopV2Context> {
  const conversation = conversationForScope(
    request.contextScope,
    request.messages,
    request.message,
  );
  const conversationSha256 = sourceContractSha256(conversation);
  const access = await resolveContextAccess(request, dependencies);
  const durableScope = Boolean(access.databaseAccessScope);
  const retrieval = durableScope
    ? await dependencies.buildContext(
        request.contextSelection?.query || request.summaryInput,
        {
          limit: 8,
          tenantId: request.securityContext.tenantId,
          databaseMemoryAccessScope: access.databaseAccessScope,
          scopedMemoryOnly: true,
          persistTrace: false,
          evidenceIds: request.contextSelection?.evidenceIds,
          entityGraphAccess: request.promptEntityGraphAccess,
          contextBudget: {
            taskContextTokenLimit: MAX_RETRIEVED_CONTEXT_TOKENS,
          },
          queryPlanning: { allowSemanticModel: false },
          ...(request.contextScope === "personal"
            ? {
                contextCompilerV2Automatic: {
                  runId: request.runId,
                  executionScope: request.executionScope,
                },
              }
            : request.contextScope === "explicit_selection"
            ? {
                contextCompilerV2Canary: {
                  runId: request.runId,
                  executionScope: request.executionScope,
                },
              }
            : {
                contextCompilerV2Shadow: {
                  runId: request.runId,
                  executionScope: request.executionScope,
                },
              }),
        },
      )
    : undefined;
  const evidenceIds = retrieval
    ? buildCitationSources(retrieval.results).map((source) => source.citationId)
    : [];
  if (
    request.contextScope === "explicit_selection" &&
    !retrieval?.compilerV2Canary
  ) {
    throw new Error(
      "Loop v2 explicit context requires the authoritative compiler receipt.",
    );
  }
  if (
    request.contextScope === "personal" &&
    !retrieval?.compilerV2Automatic
  ) {
    throw new Error(
      "Loop v2 personal context requires the authoritative automatic compiler receipt.",
    );
  }
  const compiledContext = compileSupportingContext(
    conversation,
    retrieval?.contextBlock || "",
  );
  const querySha256 = sourceContractSha256(
    request.contextSelection?.query || request.summaryInput,
  );
  const compiledContextSha256 = sourceContractSha256(compiledContext);
  const contextManifest = buildLoopV2ContextManifest({
    runId: request.runId,
    querySha256,
    contextScope: request.contextScope,
    selectedContext: retrieval?.results.map((item, index) => ({
      id: evidenceIds[index] || `${item.kind}:${item.id}`,
      score: item.score,
      userIncluded: request.contextSelection?.evidenceIds.includes(
        evidenceIds[index] || `${item.kind}:${item.id}`,
      ),
    })) || [],
    userInclusionIds: request.contextSelection?.evidenceIds || [],
    userExclusionIds: request.contextSelection?.excludedEvidenceIds || [],
    compiledContextSha256,
    contextTokenCount: estimateContextTokens(compiledContext),
    providerId: request.providerId,
    compilerVersionId: retrieval?.compilerV2Automatic
      ? CONTEXT_COMPILER_V2_AUTOMATIC_VERSION_ID
      : retrieval?.compilerV2Canary
      ? "context-compiler-v2-canary:1"
      : "context-compiler-authorized:1",
    retrievalTraceId: retrieval?.trace?.id,
  });
  const contextManifestSha256 = loopV2ContextManifestSha256(contextManifest);
  const contextBinding = buildLoopV2ContextBindingV1({
    tenantId: request.securityContext.tenantId,
    runId: request.runId,
    ownerActorId: request.securityContext.actorId,
    agentPrincipalId: request.agentIdentity.principal.principalId,
    contextScope: request.contextScope,
    authoritySha256: access.authoritySha256,
    executionScope: request.executionScope,
    querySha256,
    conversationSha256,
    contextManifestSha256,
    compiledContextSha256,
    selectedEvidenceIds: evidenceIds,
    contextBudgetReceiptSha256: retrieval
      ? sourceContractSha256(retrieval.budget)
      : undefined,
    selectionSha256: request.contextSelection?.selectionSha256,
  });

  if (retrieval?.compilerV2Shadow) {
    await dependencies.appendCompilerShadow(
      request.runId,
      retrieval.compilerV2Shadow.receipt,
      scopeOptions(request),
    );
  }
  if (retrieval?.compilerV2Canary) {
    await dependencies.appendCompilerCanary(
      request.runId,
      retrieval.compilerV2Canary.receipt,
      scopeOptions(request),
    );
  }
  if (retrieval?.compilerV2Automatic) {
    await dependencies.appendCompilerAutomatic(
      request.runId,
      retrieval.compilerV2Automatic.receipt,
      scopeOptions(request),
    );
  }
  if (request.contextSelection && retrieval) {
    await dependencies.appendUseReceipt(
      request.runId,
      buildContextUseReceiptV1({
        runId: request.runId,
        selection: request.contextSelection,
        actualEvidenceIds: evidenceIds,
        retrievalTraceId: retrieval.trace?.id,
        contextManifestSha256,
        compiledContext: retrieval.contextBlock,
        contextBudget: retrieval.budget,
      }),
      scopeOptions(request),
    );
  }
  await dependencies.appendContextBinding(
    request.runId,
    contextBinding,
    scopeOptions(request),
  );
  await dependencies.updateContextCount(request.runId, evidenceIds.length);

  return Object.freeze({
    modelInput: compileModelInput(request.summaryInput, compiledContext),
    contextManifest,
    contextBinding,
    selectedEvidenceCount: evidenceIds.length,
  });
}

async function resolveContextAccess(
  request: LoopV2ContextRuntimeRequest,
  dependencies: LoopV2ContextRuntimeDependencies,
) {
  assertAgentIdentityMatchesScope(request);
  if (request.contextScope === "personal") {
    const databaseAccessScope = await dependencies.resolvePersonalAccess(
      request.promptPersonalMemoryAccess,
      {
        agentExecutionScope: request.executionScope,
        memoryMode: "all",
      },
    );
    const authoritySha256 = request.promptPersonalMemoryAccess
      ?.consentAuthority.authoritySha256;
    if (!databaseAccessScope || !authoritySha256) {
      throw new Error("Loop v2 personal context authority is unavailable.");
    }
    return { databaseAccessScope, authoritySha256 };
  }
  if (request.contextScope === "explicit_selection") {
    if (!request.contextSelection) {
      throw new Error("Loop v2 explicit context requires a reviewed selection.");
    }
    const databaseAccessScope = resolveAgentPromptMemoryAccess(
      request.promptMemoryAccess,
      {
        agentExecutionScope: request.executionScope,
        explicitEvidenceCount: request.contextSelection.evidenceIds.length,
        memoryMode: "all",
      },
    );
    if (!databaseAccessScope) {
      throw new Error("Loop v2 explicit context authority is unavailable.");
    }
    return {
      databaseAccessScope,
      authoritySha256: request.contextSelection.selectionSha256,
    };
  }
  if (["mission", "project", "workspace"].includes(request.contextScope)) {
    const databaseAccessScope = resolveSharedAgentPromptMemoryAccess(
      request.promptSharedMemoryAccess,
      {
        agentExecutionScope: request.executionScope,
        contextScope: request.contextScope,
        memoryMode: "all",
      },
    );
    const authoritySha256 = request.promptSharedMemoryAccess?.authority
      .authoritySha256;
    if (!databaseAccessScope || !authoritySha256) {
      throw new Error("Loop v2 shared context authority is unavailable.");
    }
    return { databaseAccessScope, authoritySha256 };
  }
  if (request.contextScope === "agent_private") {
    return {
      databaseAccessScope: workflowAgentPrivateDatabaseAccessScope({
        identity: request.agentIdentity,
        requestingActorId: request.securityContext.actorId,
        correlationId: request.executionScope.correlationId,
      }),
      authoritySha256: workflowAgentPrivateAuthoritySha256(
        request.agentIdentity,
      ),
    };
  }
  return {
    databaseAccessScope: undefined,
    authoritySha256: sourceContractSha256({
      policy: "loop-v2-conversation-context-v1",
      tenantId: request.securityContext.tenantId,
      actorId: request.securityContext.actorId,
      contextScope: request.contextScope,
      correlationId: request.executionScope.correlationId,
    }),
  };
}

function assertAgentIdentityMatchesScope(request: LoopV2ContextRuntimeRequest) {
  const identity = request.agentIdentity;
  const principal = identity.principal;
  if (
    identity.definition.tenantId !== request.securityContext.tenantId ||
    identity.definition.logicalAgentId !== request.agentId ||
    principal.tenantId !== request.securityContext.tenantId ||
    principal.logicalAgentId !== identity.definition.logicalAgentId ||
    principal.principalId !== request.executionScope.executingPrincipalId ||
    principal.controllerActorId !== request.securityContext.actorId ||
    principal.state !== "active" ||
    (principal.expiresAt !== null &&
      Date.parse(principal.expiresAt) <= Date.now()) ||
    !sameIds(principal.contextGrantIds, request.executionScope.contextGrantIds) ||
    !sameIds(
      principal.capabilityGrantIds,
      request.executionScope.capabilityGrantIds,
    )
  ) {
    throw new Error("Loop v2 context Agent identity is no longer exact.");
  }
}

function conversationForScope(
  scope: ContextScopeId,
  messages: readonly ChatMessage[],
  currentMessage: string,
) {
  if (scope === "none" || scope === "current_turn") return [];
  const prior = [...messages];
  if (
    prior.at(-1)?.role === "user" &&
    prior.at(-1)?.content.trim() === currentMessage.trim()
  ) {
    prior.pop();
  }
  const selected: ChatMessage[] = [];
  let characters = 0;
  for (const message of prior.reverse()) {
    const content = message.content.slice(0, MAX_SESSION_CONTEXT_CHARS);
    if (characters + content.length > MAX_SESSION_CONTEXT_CHARS) break;
    selected.push({ role: message.role, content });
    characters += content.length;
  }
  return selected.reverse();
}

function compileSupportingContext(
  conversation: readonly ChatMessage[],
  retrievedContext: string,
) {
  return [
    conversation.length
      ? `<authorized_conversation_context trust="untrusted">\n${
          escapeUntrustedPromptText(JSON.stringify(conversation))
        }\n</authorized_conversation_context>`
      : "",
    retrievedContext
      ? `<authorized_retrieved_context trust="untrusted">\n${
          escapeUntrustedPromptText(retrievedContext)
        }\n</authorized_retrieved_context>`
      : "",
  ].filter(Boolean).join("\n\n");
}

function compileModelInput(sourceText: string, supportingContext: string) {
  return [
    `<source_text trust="untrusted">\n${
      escapeUntrustedPromptText(sourceText)
    }\n</source_text>`,
    supportingContext,
  ].filter(Boolean).join("\n\n");
}

function scopeOptions(request: LoopV2ContextRuntimeRequest) {
  return {
    tenantId: request.securityContext.tenantId,
    executionScope: request.executionScope,
  };
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
