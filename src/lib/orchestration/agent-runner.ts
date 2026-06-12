import { AGENT_MAX_TOOL_STEPS, AGENT_MODEL, hasOpenAIKey } from "@/lib/config";
import { listMcpGovernedTools, listOpenApiGovernedTools } from "@/lib/connectors/governed-tools";
import { consolidateRunMemory } from "@/lib/memory/consolidator";
import { saveMemory } from "@/lib/memory/store";
import {
  embedTexts,
  streamResponseTurn,
  type ResponseFunctionCall,
  type ResponseFunctionTool,
  type ResponseTurnInput,
} from "@/lib/openai/client";
import { buildAgentInstructions, transcriptFromMessages } from "@/lib/orchestration/prompts";
import type { AgentEvent, AgentRunRequest } from "@/lib/orchestration/types";
import { buildContextPack } from "@/lib/rag/context-engine";
import {
  appendRunEvent,
  completeAgentRun,
  createAgentRun,
  failAgentRun,
  findAgentRunWaitingForToolApproval,
  markAgentRunResuming,
  markAgentRunWaitingForApproval,
  recordRunConsolidation,
  updateRunContextCount,
} from "@/lib/runs/store";
import type { AgentRunContinuation } from "@/lib/runs/types";
import type { SecurityContext, SecurityRole } from "@/lib/security/types";
import { executeGovernedTool } from "@/lib/tools/executor";
import { getGovernedTools } from "@/lib/tools/registry";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";
import { formatLiveWebSearchContext, runLiveWebSearch, shouldUseLiveWebSearch } from "@/lib/web-search/search";

const MAX_TOOL_RESULT_CHARS = 8_000;
const MAX_TOOL_CALLS_PER_TURN = 5;

export async function* runAgent(
  request: AgentRunRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const mode = request.mode || "orchestrate";
  const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
  const query = lastUserMessage?.content || "";
  const run = await createAgentRun({
    tenantId: request.tenantId,
    mode,
    prompt: query,
    messages: request.messages,
    model: hasOpenAIKey() ? AGENT_MODEL : "fallback",
  });

  // Persist non-delta events immediately; buffer text deltas so streaming does
  // not produce one store write per token.
  let pendingDeltaText = "";
  let lastDeltaFlush = Date.now();

  async function flushDeltas() {
    if (!pendingDeltaText) {
      return;
    }
    const chunk = pendingDeltaText;
    pendingDeltaText = "";
    lastDeltaFlush = Date.now();
    await appendRunEvent(run.id, { type: "delta", text: chunk });
  }

  async function persistDelta(text: string) {
    pendingDeltaText += text;
    if (pendingDeltaText.length >= 2_000 || Date.now() - lastDeltaFlush >= 750) {
      await flushDeltas();
    }
  }

  async function emit(event: AgentEvent) {
    await flushDeltas();
    await appendRunEvent(run.id, event);
    return event;
  }

  try {
    yield await emit({ type: "status", label: "retrieving memory", detail: "Building an adaptive evidence pack from memory, RAG, and graph context." });
    const retrieval = await buildContextPack(query, { limit: 8, tenantId: request.tenantId });
    await updateRunContextCount(run.id, retrieval.results.length);
    yield await emit({
      type: "memory",
      title: `context pack ready (${retrieval.profile.mode})`,
      count: retrieval.results.length,
    });

    let liveWebContext = "";
    if (shouldUseLiveWebSearch(query) && hasOpenAIKey()) {
      yield await emit({
        type: "status",
        label: "live web search",
        detail: "The request appears to need current information, so OmniAgentOS is searching the web before answering.",
      });
      try {
        const liveWeb = await runLiveWebSearch({
          query,
          contextSize: mode === "research" ? "high" : "medium",
          abortSignal,
        });
        liveWebContext = formatLiveWebSearchContext(liveWeb);
        yield await emit({
          type: "memory",
          title: "live web sources ready",
          count: liveWeb.sourceCount,
        });
      } catch (webSearchError) {
        yield await emit({
          type: "status",
          label: "live web unavailable",
          detail: webSearchError instanceof Error ? webSearchError.message : "Live web search failed.",
        });
      }
    }

    const toolbox = await buildAgentToolbox(request.tenantId);
    const instructions = buildAgentInstructions({
      mode,
      memoryContext: retrieval.contextBlock,
      liveWebContext,
      tools: toolbox.tools.map((entry) => ({
        id: entry.definition.id,
        description: entry.definition.description,
        riskLevel: entry.definition.riskLevel,
        approvalRequired: entry.definition.approvalRequired,
        executable: true,
      })),
    });

    let response = "";

    if (!hasOpenAIKey()) {
      yield await emit({ type: "status", label: "dev fallback", detail: "OPENAI_API_KEY is not configured. This is a simulated response, not model output." });
      for (const chunk of fallbackResponse(query, retrieval.results.length)) {
        response += chunk;
        await persistDelta(chunk);
        yield { type: "delta", text: chunk };
        await wait(18);
      }
      await flushDeltas();
    } else {
      yield await emit({ type: "status", label: "reasoning", detail: "Streaming from the OpenAI Responses API with governed tools." });

      const securityContext: SecurityContext = {
        tenantId: normalizeTenantId(request.tenantId),
        actorId: request.actorId || "agent",
        role: normalizeRole(request.role),
        source: "default",
      };

      let turnInput: ResponseTurnInput = transcriptFromMessages(request.messages);
      let previousResponseId: string | undefined;
      let toolSteps = 0;

      // Tool loop: stream a turn; if the model called tools, execute them
      // through the governed executor and continue with the outputs.
      for (;;) {
        const channel = createDeltaChannel();
        const turnPromise = streamResponseTurn({
          // The Responses API does not carry instructions across
          // previous_response_id chains, so they are sent on every turn.
          instructions,
          input: turnInput,
          previousResponseId,
          tools: toolSteps < AGENT_MAX_TOOL_STEPS ? toolbox.openAITools : undefined,
          abortSignal,
          onDelta: (text) => channel.push(text),
        }).finally(() => channel.close());

        for await (const text of channel.drain()) {
          response += text;
          await persistDelta(text);
          yield { type: "delta", text };
        }

        const turn = await turnPromise;
        previousResponseId = turn.responseId;

        if (!turn.functionCalls.length) {
          break;
        }

        toolSteps += 1;
        const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];

        for (const call of turn.functionCalls.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
          const entry = toolbox.byFunctionName.get(call.name);
          if (!entry) {
            outputs.push(functionCallOutput(call, { error: `Unknown tool ${call.name}.` }));
            continue;
          }

          const definition = entry.definition;
          yield await emit({
            type: "tool",
            toolId: definition.id,
            toolName: definition.name,
            status: "running",
            riskLevel: definition.riskLevel,
          });

          const input = parseFunctionArguments(call.argumentsJson);
          // dryRun=false lets policy decide: low-risk tools execute live,
          // gated tools persist an approval_required record that the
          // Approvals workspace can later approve and execute for real.
          const execution = await executeGovernedTool({
            toolId: definition.id,
            input,
            dryRun: false,
            approved: false,
            context: securityContext,
          });

          yield await emit({
            type: "tool",
            toolId: definition.id,
            toolName: definition.name,
            status: execution.record.status === "executed" ? "executed" : execution.record.status === "dry_run" ? "dry_run" : execution.record.status === "approval_required" ? "approval_required" : execution.record.status === "blocked" ? "blocked" : "failed",
            riskLevel: definition.riskLevel,
            dryRun: execution.record.dryRun,
            summary: execution.record.reason,
            executionId: execution.record.id,
          });

          if (execution.record.status === "approval_required") {
            const continuation: AgentRunContinuation = {
              previousResponseId: previousResponseId || turn.responseId || "",
              instructions,
              response,
              toolSteps,
              outputsBeforeApproval: outputs,
              pendingToolCall: {
                callId: call.callId,
                toolId: definition.id,
                toolName: definition.name,
                riskLevel: definition.riskLevel,
                executionId: execution.record.id,
              },
              context: {
                tenantId: securityContext.tenantId,
                actorId: securityContext.actorId,
                role: securityContext.role,
              },
              createdAt: new Date().toISOString(),
            };
            await flushDeltas();
            await markAgentRunWaitingForApproval(run.id, { response, continuation });
            yield await emit({
              type: "waiting_approval",
              executionId: execution.record.id,
              toolId: definition.id,
              message: "Run paused. Approval will resume this same agent run after the tool executes.",
            });
            return;
          }

          outputs.push(
            functionCallOutput(call, {
              status: execution.record.status,
              dryRun: execution.record.dryRun,
              approvalRequired: execution.record.approvalRequired,
              note:
                execution.record.status === "executed"
                    ? "Executed for real."
                    : execution.record.reason,
              result: execution.result,
            }),
          );
        }

        for (const call of turn.functionCalls.slice(MAX_TOOL_CALLS_PER_TURN)) {
          outputs.push(functionCallOutput(call, { error: "Per-turn tool call limit reached; call skipped." }));
        }

        if (toolSteps >= AGENT_MAX_TOOL_STEPS) {
          yield await emit({
            type: "status",
            label: "tool budget reached",
            detail: `Tool step budget (${AGENT_MAX_TOOL_STEPS}) reached; asking the model for its final answer.`,
          });
        }

        turnInput = outputs;
      }

      await flushDeltas();
    }

    await maybeConsolidateRunMemory({
      runId: run.id,
      tenantId: request.tenantId,
      mode,
      query,
      response,
      emit,
    });

    await completeAgentRun(run.id, response);
    yield await emit({ type: "done", response });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed.";
    await failAgentRun(run.id, message);
    yield await emit({ type: "error", message });
  }
}

export async function resumeAgentRunAfterToolApproval({
  executionId,
  toolExecution,
  tenantId,
  abortSignal,
}: {
  executionId: string;
  toolExecution: { record: ToolExecutionRecord; result?: unknown };
  tenantId?: string;
  abortSignal?: AbortSignal;
}) {
  const run = await findAgentRunWaitingForToolApproval(executionId, { tenantId });
  const continuation = run?.continuation;
  if (!run || !continuation || run.status !== "waiting_approval") {
    return { resumed: false, reason: "No waiting agent run continuation found." };
  }

  if (!hasOpenAIKey()) {
    const message = "Cannot resume approved agent run because OPENAI_API_KEY is not configured.";
    await failAgentRun(run.id, message);
    await appendRunEvent(run.id, { type: "error", message });
    return { resumed: false, reason: message };
  }

  const claimed = await markAgentRunResuming(run.id);
  if (!claimed) {
    return { resumed: false, reason: "Run is already being resumed by another approval decision." };
  }
  await appendRunEvent(run.id, {
    type: "status",
    label: "resuming after approval",
    detail: `Tool approval ${executionId} resolved; continuing the same agent run.`,
  });

  const toolbox = await buildAgentToolbox(continuation.context.tenantId);
  let response = continuation.response || run.response || "";
  let previousResponseId = continuation.previousResponseId;
  let toolSteps = continuation.toolSteps;
  let turnInput: ResponseTurnInput = [
    ...continuation.outputsBeforeApproval,
    functionCallOutputFromCallId(continuation.pendingToolCall.callId, {
      status: toolExecution.record.status,
      dryRun: toolExecution.record.dryRun,
      approvalRequired: toolExecution.record.approvalRequired,
      note: toolExecution.record.status === "executed"
        ? "Approved and executed for real."
        : toolExecution.record.reason,
      result: toolExecution.result,
    }),
  ];

  try {
    for (;;) {
      const turn = await streamResponseTurn({
        instructions: continuation.instructions,
        input: turnInput,
        previousResponseId,
        tools: toolSteps < AGENT_MAX_TOOL_STEPS ? toolbox.openAITools : undefined,
        abortSignal,
        onDelta: async (text) => {
          response += text;
          await appendRunEvent(run.id, { type: "delta", text });
        },
      });
      previousResponseId = turn.responseId;

      if (!turn.functionCalls.length) {
        break;
      }

      toolSteps += 1;
      const outputs: AgentRunContinuation["outputsBeforeApproval"] = [];

      for (const call of turn.functionCalls.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
        const entry = toolbox.byFunctionName.get(call.name);
        if (!entry) {
          outputs.push(functionCallOutput(call, { error: `Unknown tool ${call.name}.` }));
          continue;
        }

        const definition = entry.definition;
        await appendRunEvent(run.id, {
          type: "tool",
          toolId: definition.id,
          toolName: definition.name,
          status: "running",
          riskLevel: definition.riskLevel,
        });

        const execution = await executeGovernedTool({
          toolId: definition.id,
          input: parseFunctionArguments(call.argumentsJson),
          dryRun: false,
          approved: false,
          context: {
            tenantId: continuation.context.tenantId,
            actorId: continuation.context.actorId,
            role: continuation.context.role,
            source: "default",
          },
        });

        await appendRunEvent(run.id, {
          type: "tool",
          toolId: definition.id,
          toolName: definition.name,
          status: toolExecutionStatus(execution.record.status),
          riskLevel: definition.riskLevel,
          dryRun: execution.record.dryRun,
          summary: execution.record.reason,
          executionId: execution.record.id,
        });

        if (execution.record.status === "approval_required") {
          await markAgentRunWaitingForApproval(run.id, {
            response,
            continuation: {
              previousResponseId,
              instructions: continuation.instructions,
              response,
              toolSteps,
              outputsBeforeApproval: outputs,
              pendingToolCall: {
                callId: call.callId,
                toolId: definition.id,
                toolName: definition.name,
                riskLevel: definition.riskLevel,
                executionId: execution.record.id,
              },
              context: continuation.context,
              createdAt: new Date().toISOString(),
            },
          });
          await appendRunEvent(run.id, {
            type: "waiting_approval",
            executionId: execution.record.id,
            toolId: definition.id,
            message: "Run paused again for a newly required approval.",
          });
          return { resumed: true, status: "waiting_approval" };
        }

        outputs.push(functionCallOutput(call, {
          status: execution.record.status,
          dryRun: execution.record.dryRun,
          approvalRequired: execution.record.approvalRequired,
          note: execution.record.status === "executed" ? "Executed for real." : execution.record.reason,
          result: execution.result,
        }));
      }

      for (const call of turn.functionCalls.slice(MAX_TOOL_CALLS_PER_TURN)) {
        outputs.push(functionCallOutput(call, { error: "Per-turn tool call limit reached; call skipped." }));
      }

      if (toolSteps >= AGENT_MAX_TOOL_STEPS) {
        await appendRunEvent(run.id, {
          type: "status",
          label: "tool budget reached",
          detail: `Tool step budget (${AGENT_MAX_TOOL_STEPS}) reached; asking the model for its final answer.`,
        });
      }

      turnInput = outputs;
    }

    await maybeConsolidateRunMemory({
      runId: run.id,
      tenantId: continuation.context.tenantId,
      mode: run.mode,
      query: run.prompt,
      response,
      emit: (event) => appendRunEvent(run.id, event),
    });
    await completeAgentRun(run.id, response);
    await appendRunEvent(run.id, { type: "done", response });
    return { resumed: true, status: "completed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approved agent run resume failed.";
    await failAgentRun(run.id, message);
    await appendRunEvent(run.id, { type: "error", message });
    return { resumed: true, status: "failed", error: message };
  }
}

export async function rejectAgentRunApproval({
  executionId,
  tenantId,
  reason,
}: {
  executionId: string;
  tenantId?: string;
  reason?: string;
}) {
  const run = await findAgentRunWaitingForToolApproval(executionId, { tenantId });
  if (!run || run.status !== "waiting_approval") {
    return { rejected: false };
  }
  const message = reason ? `Approval rejected: ${reason}` : "Approval rejected by operator.";
  await failAgentRun(run.id, message);
  await appendRunEvent(run.id, { type: "error", message });
  return { rejected: true, runId: run.id };
}

type ToolboxEntry = {
  definition: ToolDefinition;
  functionName: string;
};

async function buildAgentToolbox(tenantId?: string): Promise<{
  tools: ToolboxEntry[];
  openAITools: ResponseFunctionTool[];
  byFunctionName: Map<string, ToolboxEntry>;
}> {
  const [mcpTools, openApiTools] = await Promise.all([
    listMcpGovernedTools({ tenantId }).catch(() => [] as ToolDefinition[]),
    listOpenApiGovernedTools({ tenantId }).catch(() => [] as ToolDefinition[]),
  ]);

  const definitions = [...getGovernedTools(), ...mcpTools, ...openApiTools].filter(
    (tool) => tool.status === "active" && tool.riskLevel < 3,
  );

  const used = new Set<string>();
  const tools: ToolboxEntry[] = definitions.map((definition) => {
    let functionName = definition.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "tool";
    while (used.has(functionName)) {
      functionName = `${functionName.slice(0, 56)}_${used.size}`;
    }
    used.add(functionName);
    return { definition, functionName };
  });

  return {
    tools,
    openAITools: tools.map((entry) => ({
      type: "function" as const,
      name: entry.functionName,
      description: `${entry.definition.description} (risk ${entry.definition.riskLevel}${entry.definition.approvalRequired ? "; side effects require human approval, so the call only previews" : ""})`,
      parameters: entry.definition.inputSchema,
      strict: false as const,
    })),
    byFunctionName: new Map(tools.map((entry) => [entry.functionName, entry])),
  };
}

function functionCallOutput(call: ResponseFunctionCall, payload: unknown) {
  return functionCallOutputFromCallId(call.callId, payload);
}

function functionCallOutputFromCallId(callId: string, payload: unknown) {
  let output = JSON.stringify(payload ?? null);
  if (output.length > MAX_TOOL_RESULT_CHARS) {
    output = `${output.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated]`;
  }
  return { type: "function_call_output" as const, call_id: callId, output };
}

function parseFunctionArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function createDeltaChannel() {
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  return {
    push(text: string) {
      queue.push(text);
      notify?.();
      notify = null;
    },
    close() {
      closed = true;
      notify?.();
      notify = null;
    },
    async *drain() {
      for (;;) {
        while (queue.length) {
          yield queue.shift() as string;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}

function normalizeRole(role?: string): SecurityRole {
  return role === "viewer" || role === "operator" || role === "admin" || role === "system"
    ? role
    : "operator";
}

function toolExecutionStatus(status: ToolExecutionRecord["status"]): "executed" | "dry_run" | "approval_required" | "blocked" | "failed" {
  return status === "executed" ? "executed" :
    status === "dry_run" ? "dry_run" :
      status === "approval_required" ? "approval_required" :
        status === "blocked" ? "blocked" :
          "failed";
}

async function maybeConsolidateRunMemory({
  runId,
  tenantId,
  mode,
  query,
  response,
  emit,
}: {
  runId: string;
  tenantId?: string;
  mode: "orchestrate" | "research" | "execute" | "learn";
  query: string;
  response: string;
  emit: (event: AgentEvent) => Promise<unknown>;
}) {
  // Skip memory writes for trivial exchanges so the store does not fill with
  // low-value episodes that dilute retrieval quality.
  const worthRemembering = query.trim().length >= 12 && response.trim().length >= 280;
  if (!worthRemembering) {
    return;
  }

  const episodeContent = [`User request: ${query}`, `Assistant response: ${response}`].join("\n\n");
  const embedding = (await embedTexts([episodeContent]))?.[0];
  await saveMemory({
    tenantId,
    type: "episode",
    title: `Agent run: ${query.slice(0, 72)}`,
    content: episodeContent,
    tags: ["agent-run", mode],
    source: "agent",
    importance: 0.42,
    embedding,
  });

  await emit({
    type: "status",
    label: "consolidating memory",
    detail: "Extracting durable facts, decisions, procedures, preferences, and tasks.",
  });
  const consolidation = await consolidateRunMemory({
    tenantId,
    runId,
    mode,
    prompt: query,
    response,
  });
  await recordRunConsolidation(runId, {
    count: consolidation.saved.length,
    error: consolidation.error,
  });
  await emit({
    type: "memory",
    title: consolidation.error ? "memory consolidation failed" : "memory consolidated",
    count: consolidation.saved.length,
  });
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim() || "default";
}

function fallbackResponse(query: string, memoryCount: number) {
  const prompt = query.trim() || "No task was provided.";
  const text = [
    `[Simulated response] OPENAI_API_KEY is not configured, so no model ran. `,
    `Here is the orchestration path prepared for: "${prompt}".\n\n`,
    `Plan:\n`,
    `1. Clarify the objective and acceptance criteria.\n`,
    `2. Retrieve relevant memories and project knowledge (${memoryCount} records matched this request).\n`,
    `3. Select tools or connectors needed for the job.\n`,
    `4. Execute in small verifiable steps.\n`,
    `5. Save durable learnings back to memory.\n\n`,
    `Next action: add OPENAI_API_KEY to .env.local, then retry this command for model-backed reasoning.`,
  ].join("");

  return text.match(/.{1,42}(\s|$)/g) || [text];
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
