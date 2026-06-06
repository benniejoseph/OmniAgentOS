"use client";

import {
  Activity,
  BookOpen,
  Brain,
  Cable,
  CheckCircle2,
  Database,
  FileText,
  Globe2,
  HardDrive,
  History,
  Layers3,
  Play,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";

type Role = "user" | "assistant";
type Mode = "orchestrate" | "research" | "execute" | "learn";

type Message = {
  role: Role;
  content: string;
};

type Capability = {
  id: string;
  name: string;
  description: string;
  status: "active" | "planned";
};

type RiskLevel = 0 | 1 | 2 | 3;
type ToolExecutionStatus = "dry_run" | "executed" | "approval_required" | "blocked" | "failed";

type GovernedTool = {
  id: string;
  name: string;
  description: string;
  status: "active" | "planned";
  riskLevel: RiskLevel;
  dryRunSupported: boolean;
  approvalRequired: boolean;
};

type ToolExecutionRecord = {
  id: string;
  toolId: string;
  toolName: string;
  riskLevel: RiskLevel;
  status: ToolExecutionStatus;
  dryRun: boolean;
  approvalRequired: boolean;
  input: Record<string, unknown>;
  output?: unknown;
  reason?: string;
  createdAt: string;
  completedAt?: string;
};

type ToolAuditSummary = {
  total: number;
  byStatus: Record<string, number>;
  byRisk: Record<string, number>;
  latest: ToolExecutionRecord[];
};

type ToolsResponse = {
  tools: GovernedTool[];
  audits: ToolAuditSummary;
  policy: {
    riskLevels: {
      level: RiskLevel;
      label: string;
      approvalRequired: boolean;
    }[];
    defaultBehavior: string;
  };
};

type McpConnectorRecord = {
  id: string;
  name: string;
  endpoint: string;
  transport: "streamable_http";
  authType: "none" | "bearer_env";
  authTokenEnv?: string;
  status: "active" | "error" | "disabled";
  defaultRiskLevel: RiskLevel;
  approvalRequired: boolean;
  toolCount: number;
  lastDiscoveredAt?: string;
  lastError?: string;
  updatedAt: string;
};

type McpToolRecord = {
  id: string;
  connectorId: string;
  connectorName: string;
  name: string;
  title?: string;
  description?: string;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  status: "active" | "disabled";
  updatedAt: string;
};

type ConnectorStats = {
  total: number;
  active: number;
  error: number;
  toolCount: number;
  latest: McpConnectorRecord[];
};

type ConnectorsResponse = {
  connectors: McpConnectorRecord[];
  tools: McpToolRecord[];
  stats: ConnectorStats;
};

type OpenApiConnectorRecord = {
  id: string;
  name: string;
  specUrl?: string;
  baseUrl: string;
  authType: "none" | "bearer_env" | "api_key_header_env";
  authTokenEnv?: string;
  authHeaderName?: string;
  status: "active" | "error" | "disabled";
  defaultRiskLevel: RiskLevel;
  approvalRequired: boolean;
  operationCount: number;
  lastImportedAt?: string;
  lastError?: string;
  updatedAt: string;
};

type OpenApiOperationRecord = {
  id: string;
  connectorId: string;
  connectorName: string;
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  status: "active" | "disabled";
  updatedAt: string;
};

type OpenApiConnectorStats = {
  total: number;
  active: number;
  error: number;
  operationCount: number;
  latest: OpenApiConnectorRecord[];
};

type OpenApiConnectorsResponse = {
  connectors: OpenApiConnectorRecord[];
  operations: OpenApiOperationRecord[];
  stats: OpenApiConnectorStats;
};

type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

type WorkflowRunRecord = {
  id: string;
  workflowType: string;
  status: WorkflowRunStatus;
  goal: string;
  currentStep?: string;
  attempt: number;
  maxAttempts: number;
  approvalRequired: boolean;
  approvedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type WorkflowStepRecord = {
  id: string;
  workflowRunId: string;
  stepKey: string;
  label: string;
  status: WorkflowStepStatus;
  attempt: number;
  maxAttempts: number;
  error?: string;
  updatedAt: string;
};

type WorkflowRunDetail = {
  run: WorkflowRunRecord;
  steps: WorkflowStepRecord[];
};

type WorkflowStats = {
  total: number;
  byStatus: Record<string, number>;
  active: number;
  waitingApproval: number;
  latest: WorkflowRunRecord[];
};

type WorkflowsResponse = {
  runs: WorkflowRunRecord[];
  stats: WorkflowStats;
};

type CapabilityResponse = {
  openaiConfigured: boolean;
  databaseConfigured: boolean;
  storageBackend: "postgres" | "ephemeral" | "file";
  memory: {
    total: number;
    embedded: number;
    byType: Record<string, number>;
  };
  knowledge: {
    documents: number;
    chunks: number;
    characters: number;
    embedded: number;
  };
  runs: {
    total: number;
    byStatus: Record<string, number>;
    consolidated: {
      runs: number;
      memories: number;
    };
    latest: AgentRun[];
  };
  toolExecutions: ToolAuditSummary;
  mcpConnectors: ConnectorStats;
  openApiConnectors: OpenApiConnectorStats;
  workflows: WorkflowStats;
  registry: {
    agents: Capability[];
    tools: Capability[];
    connectorTypes: Capability[];
  };
};

type AgentRun = {
  id: string;
  mode: Mode;
  status: "running" | "completed" | "failed";
  prompt: string;
  model?: string;
  memoryContextCount: number;
  consolidationCount?: number;
  consolidatedAt?: string;
  startedAt: string;
};

type MemoryRecord = {
  id: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  updatedAt: string;
};

type KnowledgeDocument = {
  id: string;
  title: string;
  source: string;
  sourceType: string;
  tags: string[];
  chunkCount: number;
  totalCharacters: number;
  updatedAt: string;
};

type KnowledgeChunk = {
  id: string;
  documentId: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  tokenEstimate: number;
  updatedAt: string;
};

const starterMessages: Message[] = [
  {
    role: "assistant",
    content:
      "OmniAgent OS is online. Give me a goal, and I will route it through planning, memory retrieval, tool selection, execution strategy, and verification.",
  },
];

const modes: { id: Mode; label: string }[] = [
  { id: "orchestrate", label: "Orchestrate" },
  { id: "research", label: "Research" },
  { id: "execute", label: "Execute" },
  { id: "learn", label: "Learn" },
];

const defaultToolInputs: Record<string, string> = {
  "memory.search": JSON.stringify({ query: "structured memory consolidation", limit: 3 }, null, 2),
  "knowledge.search": JSON.stringify({ query: "RAG v2 production smoke", limit: 3 }, null, 2),
  "memory.write": JSON.stringify(
    {
      title: "Governed tool policy",
      content: "Tool executions should be schema-validated, dry-runnable, risk-scored, and audit logged.",
      type: "procedure",
      tags: ["tool-governance"],
      importance: 0.74,
    },
    null,
    2,
  ),
  "knowledge.ingest": JSON.stringify(
    {
      title: "Tool governance note",
      content:
        "A governed tool layer keeps low-risk reads fast while requiring explicit approval for external side effects.",
      source: "operator",
      tags: ["tool-governance"],
    },
    null,
    2,
  ),
  "runs.list": JSON.stringify({ limit: 3 }, null, 2),
  "connector.external_action": JSON.stringify(
    {
      connector: "example",
      action: "send",
      payload: { message: "dry run only" },
    },
    null,
    2,
  ),
};

export function CommandCenter() {
  const [messages, setMessages] = useState<Message[]>(starterMessages);
  const [input, setInput] = useState("Design the first durable workflow for our agent OS.");
  const [mode, setMode] = useState<Mode>("orchestrate");
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [capabilities, setCapabilities] = useState<CapabilityResponse | null>(null);
  const [memoryTitle, setMemoryTitle] = useState("Project operating principles");
  const [memoryContent, setMemoryContent] = useState(
    "Prefer durable workflows, permissioned tools, and verifiable outputs over single-shot autonomous claims.",
  );
  const [knowledgeTitle, setKnowledgeTitle] = useState("Agent framework architecture notes");
  const [knowledgeContent, setKnowledgeContent] = useState(
    "Store source documents as chunks with embeddings, keep every chunk tied to provenance, and retrieve context with hybrid semantic and keyword ranking.",
  );
  const [browserQuery, setBrowserQuery] = useState("");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [toolState, setToolState] = useState<ToolsResponse | null>(null);
  const [selectedToolId, setSelectedToolId] = useState("memory.search");
  const [toolInput, setToolInput] = useState(defaultToolInputs["memory.search"]);
  const [toolResult, setToolResult] = useState("");
  const [connectorState, setConnectorState] = useState<ConnectorsResponse | null>(null);
  const [connectorName, setConnectorName] = useState("Primary MCP server");
  const [connectorEndpoint, setConnectorEndpoint] = useState("https://example.com/mcp");
  const [connectorAuthEnv, setConnectorAuthEnv] = useState("");
  const [connectorResult, setConnectorResult] = useState("");
  const [openApiState, setOpenApiState] = useState<OpenApiConnectorsResponse | null>(null);
  const [openApiName, setOpenApiName] = useState("Public API connector");
  const [openApiSpecUrl, setOpenApiSpecUrl] = useState("https://petstore3.swagger.io/api/v3/openapi.json");
  const [openApiBaseUrl, setOpenApiBaseUrl] = useState("");
  const [openApiAuthEnv, setOpenApiAuthEnv] = useState("");
  const [openApiAuthHeader, setOpenApiAuthHeader] = useState("x-api-key");
  const [openApiResult, setOpenApiResult] = useState("");
  const [workflowState, setWorkflowState] = useState<WorkflowsResponse | null>(null);
  const [workflowGoal, setWorkflowGoal] = useState("Run a durable Plan-Execute-Verify workflow for this agent OS.");
  const [workflowResult, setWorkflowResult] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/capabilities")
      .then((response) => response.json())
      .then(setCapabilities)
      .catch(() => setStatus("capability check failed"));
    fetch("/api/memory?limit=5")
      .then((response) => response.json())
      .then((data) => setMemories(data.memories || []))
      .catch(() => undefined);
    fetch("/api/knowledge?limit=5")
      .then((response) => response.json())
      .then((data) => {
        setDocuments(data.documents || []);
        setChunks(data.chunks || []);
      })
      .catch(() => undefined);
    fetch("/api/tools")
      .then((response) => response.json())
      .then(setToolState)
      .catch(() => undefined);
    fetch("/api/connectors")
      .then((response) => response.json())
      .then(setConnectorState)
      .catch(() => undefined);
    fetch("/api/openapi-connectors")
      .then((response) => response.json())
      .then(setOpenApiState)
      .catch(() => undefined);
    fetch("/api/workflows?limit=5")
      .then((response) => response.json())
      .then(setWorkflowState)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    viewportRef.current?.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const activeTools = useMemo(
    () => capabilities?.registry.tools.filter((tool) => tool.status === "active") || [],
    [capabilities],
  );
  const governedActiveTools = useMemo(
    () => toolState?.tools.filter((tool) => tool.status === "active") || [],
    [toolState],
  );
  const latestRuns = capabilities?.runs.latest || [];
  const toolAuditStats = toolState?.audits || capabilities?.toolExecutions;
  const latestToolAudits = toolAuditStats?.latest || [];
  const selectedTool = toolState?.tools.find((tool) => tool.id === selectedToolId);
  const connectorStats = connectorState?.stats || capabilities?.mcpConnectors;
  const latestConnectors = connectorState?.connectors.slice(0, 5) || [];
  const latestMcpTools = connectorState?.tools.slice(0, 5) || [];
  const openApiStats = openApiState?.stats || capabilities?.openApiConnectors;
  const latestOpenApiConnectors = openApiState?.connectors.slice(0, 5) || [];
  const latestOpenApiOperations = openApiState?.operations.slice(0, 5) || [];
  const workflowStats = workflowState?.stats || capabilities?.workflows;
  const latestWorkflows = workflowState?.runs.slice(0, 5) || capabilities?.workflows.latest || [];
  const storageLabel =
    capabilities?.storageBackend === "postgres"
      ? "Postgres"
      : capabilities?.storageBackend === "ephemeral"
        ? "Ephemeral"
        : "File";

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || isRunning) {
      return;
    }

    const nextMessages = [...messages, { role: "user" as const, content: prompt }];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setInput("");
    setIsRunning(true);
    setStatus("starting run");

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, mode }),
      });

      if (!response.body) {
        throw new Error("No response body returned.");
      }

      await readEventStream(response.body, (event) => {
        if (event.type === "status") {
          setStatus(event.detail ? `${event.label}: ${event.detail}` : event.label);
        }

        if (event.type === "memory") {
          setStatus(`${event.title}${event.count ? ` (${event.count})` : ""}`);
        }

        if (event.type === "delta") {
          setMessages((current) => {
            const copy = [...current];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = {
              ...last,
              content: `${last.content}${event.text}`,
            };
            return copy;
          });
        }

        if (event.type === "error") {
          setStatus(event.message);
        }

        if (event.type === "done") {
          setStatus("run complete");
          refreshWorkspace();
        }
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "run failed");
    } finally {
      setIsRunning(false);
    }
  }

  async function saveManualMemory() {
    if (!memoryTitle.trim() || !memoryContent.trim()) {
      return;
    }

    setStatus("saving memory");
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: memoryTitle,
        content: memoryContent,
        type: "procedure",
        tags: ["project", "operating-principle"],
        importance: 0.85,
      }),
    });
    setStatus("memory saved");
    refreshWorkspace();
  }

  async function saveKnowledgeDocument() {
    if (!knowledgeTitle.trim() || !knowledgeContent.trim()) {
      return;
    }

    setStatus("ingesting knowledge");
    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: knowledgeTitle,
        content: knowledgeContent,
        source: "manual",
        sourceType: "manual",
        tags: ["workspace", "operator-ingest"],
      }),
    });

    if (!response.ok) {
      setStatus("knowledge ingest failed");
      return;
    }

    setStatus("knowledge ingested");
    refreshWorkspace();
  }

  async function searchWorkspace() {
    const query = browserQuery.trim();
    if (!query) {
      refreshWorkspace();
      return;
    }

    setStatus("searching memory");
    const [memoryResponse, knowledgeResponse] = await Promise.all([
      fetch(`/api/memory?q=${encodeURIComponent(query)}&limit=5`).then((response) => response.json()),
      fetch(`/api/knowledge?q=${encodeURIComponent(query)}&limit=5`).then((response) => response.json()),
    ]);
    setMemories((memoryResponse.results || []).map((result: { record: MemoryRecord }) => result.record));
    setDocuments([]);
    setChunks((knowledgeResponse.results || []).map((result: { chunk: KnowledgeChunk }) => result.chunk));
    setStatus("search complete");
  }

  async function runGovernedTool(dryRun: boolean) {
    let parsedInput: Record<string, unknown>;
    try {
      const parsed = JSON.parse(toolInput || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Tool input must be a JSON object.");
      }
      parsedInput = parsed as Record<string, unknown>;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Tool input must be valid JSON.");
      return;
    }

    setStatus(dryRun ? "dry-running tool" : "executing tool");

    try {
      const response = await fetch("/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolId: selectedToolId,
          input: parsedInput,
          dryRun,
        }),
      });
      const data = await response.json();
      setToolResult(formatToolResult(data.result ?? data.record ?? data));
      setStatus(data.record?.status ? `tool ${data.record.status}` : response.ok ? "tool complete" : "tool failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "tool execution failed");
    }
  }

  async function registerConnector(discover: boolean) {
    if (!connectorName.trim() || !connectorEndpoint.trim()) {
      return;
    }

    setStatus(discover ? "registering and discovering MCP" : "registering MCP");
    setConnectorResult("");

    try {
      const response = await fetch("/api/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: connectorName,
          endpoint: connectorEndpoint,
          authType: connectorAuthEnv.trim() ? "bearer_env" : "none",
          authTokenEnv: connectorAuthEnv.trim() || undefined,
          defaultRiskLevel: 2,
          approvalRequired: true,
          discover,
        }),
      });
      const data = await response.json();
      setConnectorResult(formatToolResult(data));
      setStatus(data.error ? "MCP discovery held" : discover ? "MCP discovered" : "MCP registered");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP registration failed");
    }
  }

  async function discoverConnector(connectorId: string) {
    setStatus("discovering MCP");
    setConnectorResult("");

    try {
      const response = await fetch(`/api/connectors/${connectorId}/discover`, {
        method: "POST",
      });
      const data = await response.json();
      setConnectorResult(formatToolResult(data));
      setStatus(data.error ? "MCP discovery held" : "MCP discovered");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "MCP discovery failed");
    }
  }

  async function registerOpenApiConnector(importSpec: boolean) {
    if (!openApiName.trim() || (!openApiSpecUrl.trim() && importSpec === true)) {
      return;
    }

    setStatus(importSpec ? "registering and importing OpenAPI" : "registering OpenAPI");
    setOpenApiResult("");

    try {
      const authType = openApiAuthEnv.trim() ? "api_key_header_env" : "none";
      const response = await fetch("/api/openapi-connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: openApiName,
          specUrl: openApiSpecUrl.trim() || undefined,
          baseUrl: openApiBaseUrl.trim() || undefined,
          authType,
          authTokenEnv: openApiAuthEnv.trim() || undefined,
          authHeaderName: authType === "api_key_header_env" ? openApiAuthHeader.trim() || "x-api-key" : undefined,
          defaultRiskLevel: 2,
          approvalRequired: true,
          importSpec,
        }),
      });
      const data = await response.json();
      setOpenApiResult(formatToolResult(data));
      setStatus(data.error ? "OpenAPI import held" : importSpec ? "OpenAPI imported" : "OpenAPI registered");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OpenAPI registration failed");
    }
  }

  async function importOpenApiConnector(connectorId: string) {
    setStatus("importing OpenAPI");
    setOpenApiResult("");

    try {
      const response = await fetch(`/api/openapi-connectors/${connectorId}/import`, {
        method: "POST",
      });
      const data = await response.json();
      setOpenApiResult(formatToolResult(data));
      setStatus(data.error ? "OpenAPI import held" : "OpenAPI imported");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OpenAPI import failed");
    }
  }

  async function startWorkflow() {
    const goal = workflowGoal.trim();
    if (!goal) {
      return;
    }

    setStatus("starting workflow");
    setWorkflowResult("");

    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          mode,
          requireApproval: true,
          maxAttempts: 3,
        }),
      });
      const data = (await response.json()) as WorkflowRunDetail;
      setWorkflowResult(formatToolResult(data));
      setStatus(response.ok ? "workflow queued" : "workflow failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "workflow start failed");
    }
  }

  async function tickWorkflow(workflowId?: string) {
    setStatus(workflowId ? "ticking workflow" : "ticking queued workflows");
    setWorkflowResult("");

    try {
      const response = await fetch(workflowId ? `/api/workflows/${workflowId}/tick` : "/api/workflows/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: workflowId ? undefined : JSON.stringify({ limit: 3 }),
      });
      const data = await response.json();
      setWorkflowResult(formatToolResult(data));
      setStatus(response.ok ? "workflow tick complete" : "workflow tick failed");
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "workflow tick failed");
    }
  }

  async function signalWorkflow(workflowId: string, signal: "pause" | "resume" | "cancel" | "approve" | "retry") {
    setStatus(`workflow ${signal}`);
    setWorkflowResult("");

    try {
      const response = await fetch(`/api/workflows/${workflowId}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal }),
      });
      const data = await response.json();
      setWorkflowResult(formatToolResult(data));
      setStatus(response.ok ? "workflow signal applied" : `workflow ${signal} failed`);
      refreshWorkspace();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `workflow ${signal} failed`);
    }
  }

  function refreshCapabilities() {
    fetch("/api/capabilities")
      .then((response) => response.json())
      .then(setCapabilities)
      .catch(() => undefined);
  }

  function refreshTools() {
    fetch("/api/tools")
      .then((response) => response.json())
      .then(setToolState)
      .catch(() => undefined);
  }

  function refreshConnectors() {
    fetch("/api/connectors")
      .then((response) => response.json())
      .then(setConnectorState)
      .catch(() => undefined);
  }

  function refreshOpenApiConnectors() {
    fetch("/api/openapi-connectors")
      .then((response) => response.json())
      .then(setOpenApiState)
      .catch(() => undefined);
  }

  function refreshWorkflows() {
    fetch("/api/workflows?limit=5")
      .then((response) => response.json())
      .then(setWorkflowState)
      .catch(() => undefined);
  }

  function refreshWorkspace() {
    refreshCapabilities();
    fetch("/api/memory?limit=5")
      .then((response) => response.json())
      .then((data) => setMemories(data.memories || []))
      .catch(() => undefined);
    fetch("/api/knowledge?limit=5")
      .then((response) => response.json())
      .then((data) => {
        setDocuments(data.documents || []);
        setChunks(data.chunks || []);
      })
      .catch(() => undefined);
    refreshTools();
    refreshConnectors();
    refreshOpenApiConnectors();
    refreshWorkflows();
  }

  return (
    <main className="min-h-screen subtle-grid px-4 py-4 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="panel flex flex-col gap-4 rounded-lg px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex size-12 items-center justify-center rounded-md bg-primary text-primary-ink">
              <Layers3 size={24} strokeWidth={2.4} />
            </div>
            <div>
              <p className="text-sm font-medium text-primary">OmniAgent OS</p>
              <h1 className="text-2xl font-semibold">Agentic orchestration command center</h1>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 xl:grid-cols-11">
            <StatusPill icon={<Brain size={15} />} label="Memory" value={`${capabilities?.memory.total ?? 0}`} />
            <StatusPill
              icon={<Database size={15} />}
              label="Learned"
              value={`${capabilities?.runs.consolidated.memories ?? 0}`}
            />
            <StatusPill icon={<BookOpen size={15} />} label="Docs" value={`${capabilities?.knowledge.documents ?? 0}`} />
            <StatusPill icon={<History size={15} />} label="Runs" value={`${capabilities?.runs.total ?? 0}`} />
            <StatusPill icon={<Activity size={15} />} label="Flows" value={`${workflowStats?.active ?? 0}`} />
            <StatusPill icon={<Cable size={15} />} label="Tools" value={`${governedActiveTools.length || activeTools.length}`} />
            <StatusPill icon={<Cable size={15} />} label="MCP" value={`${connectorStats?.toolCount ?? 0}`} />
            <StatusPill icon={<Globe2 size={15} />} label="REST" value={`${openApiStats?.operationCount ?? 0}`} />
            <StatusPill icon={<ShieldCheck size={15} />} label="Audits" value={`${toolAuditStats?.total ?? 0}`} />
            <StatusPill icon={<HardDrive size={15} />} label="Store" value={storageLabel} />
            <StatusPill
              icon={<Sparkles size={15} />}
              label="OpenAI"
              value={capabilities?.openaiConfigured ? "Live" : "Fallback"}
            />
          </div>
        </header>

        <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="panel flex min-h-[680px] flex-col rounded-lg">
            <div className="flex flex-col gap-3 border-b border-line px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm text-muted">Run state</p>
                <p className="font-mono text-sm text-accent">{status}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {modes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setMode(item.id)}
                    className={clsx(
                      "h-9 rounded-md border px-3 text-sm transition",
                      mode === item.id
                        ? "border-primary bg-primary text-primary-ink"
                        : "border-line bg-surface text-muted hover:border-primary hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div ref={viewportRef} className="flex-1 overflow-y-auto px-5 py-5">
              <div className="flex flex-col gap-4">
                {messages.map((message, index) => (
                  <article
                    key={`${message.role}-${index}`}
                    className={clsx(
                      "max-w-[86%] rounded-lg border px-4 py-3",
                      message.role === "user"
                        ? "ml-auto border-primary/40 bg-primary/12"
                        : "border-line bg-background/62",
                    )}
                  >
                    <div className="mb-2 flex items-center gap-2 text-xs uppercase text-muted">
                      {message.role === "user" ? <Send size={13} /> : <Activity size={13} />}
                      {message.role}
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                      {message.content || (isRunning ? "Thinking..." : "")}
                    </p>
                  </article>
                ))}
              </div>
            </div>

            <form onSubmit={submitMessage} className="border-t border-line p-4">
              <label className="mb-2 block text-sm text-muted" htmlFor="agent-command">
                Command
              </label>
              <div className="flex flex-col gap-3 md:flex-row">
                <textarea
                  id="agent-command"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  className="min-h-24 flex-1 resize-none rounded-md border border-line bg-background px-3 py-3 text-sm leading-6 outline-none transition placeholder:text-muted focus:border-primary"
                  placeholder="Give the agent a goal..."
                />
                <button
                  type="submit"
                  disabled={isRunning}
                  className="flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 font-medium text-primary-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 md:self-end"
                >
                  <Play size={17} />
                  Run
                </button>
              </div>
            </form>
          </div>

          <aside className="flex flex-col gap-4">
            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <History className="text-primary" size={18} />
                <h2 className="font-semibold">Run ledger</h2>
              </div>
              <div className="flex flex-col gap-3">
                {latestRuns.length ? (
                  latestRuns.map((run) => <RunRow key={run.id} run={run} />)
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No runs recorded yet.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Activity className="text-primary" size={18} />
                <h2 className="font-semibold">Workflow runtime</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Total" value={`${workflowStats?.total ?? 0}`} />
                <MiniStat label="Active" value={`${workflowStats?.active ?? 0}`} />
                <MiniStat label="Approval" value={`${workflowStats?.waitingApproval ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                <textarea
                  value={workflowGoal}
                  onChange={(event) => setWorkflowGoal(event.target.value)}
                  className="min-h-24 resize-none rounded-md border border-line bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                  aria-label="Workflow goal"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={startWorkflow}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                  >
                    <Play size={15} />
                    Start
                  </button>
                  <button
                    type="button"
                    onClick={() => tickWorkflow()}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
                  >
                    <Activity size={15} />
                    Tick queued
                  </button>
                </div>
                {workflowResult ? (
                  <pre className="max-h-48 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {workflowResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestWorkflows.length ? (
                    latestWorkflows.map((workflow) => (
                      <WorkflowRow
                        key={workflow.id}
                        workflow={workflow}
                        onTick={tickWorkflow}
                        onSignal={signalWorkflow}
                      />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No durable workflows recorded yet.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="text-primary" size={18} />
                <h2 className="font-semibold">Governed tools</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Audits" value={`${toolAuditStats?.total ?? 0}`} />
                <MiniStat label="Exec" value={`${toolAuditStats?.byStatus.executed ?? 0}`} />
                <MiniStat
                  label="Held"
                  value={`${(toolAuditStats?.byStatus.blocked ?? 0) + (toolAuditStats?.byStatus.approval_required ?? 0)}`}
                />
              </div>
              <div className="flex flex-col gap-3">
                <select
                  value={selectedToolId}
                  onChange={(event) => {
                    const nextToolId = event.target.value;
                    setSelectedToolId(nextToolId);
                    setToolInput(defaultToolInputs[nextToolId] || "{}");
                    setToolResult("");
                  }}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="Governed tool"
                >
                  {(toolState?.tools || []).map((tool) => (
                    <option key={tool.id} value={tool.id}>
                      {tool.name}
                    </option>
                  ))}
                </select>
                {selectedTool ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-background/54 px-3 py-2 text-xs">
                    <span className="line-clamp-1 text-muted">{selectedTool.description}</span>
                    <span className={clsx("shrink-0 rounded px-2 py-1 font-mono", riskTone(selectedTool.riskLevel))}>
                      R{selectedTool.riskLevel}
                    </span>
                  </div>
                ) : null}
                <textarea
                  value={toolInput}
                  onChange={(event) => setToolInput(event.target.value)}
                  className="min-h-44 resize-y rounded-md border border-line bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-primary"
                  aria-label="Tool input JSON"
                  spellCheck={false}
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => runGovernedTool(true)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
                  >
                    <Search size={15} />
                    Dry run
                  </button>
                  <button
                    type="button"
                    onClick={() => runGovernedTool(false)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                  >
                    <Play size={15} />
                    Execute
                  </button>
                </div>
                {toolResult ? (
                  <pre className="max-h-52 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {toolResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestToolAudits.length ? (
                    latestToolAudits.map((record) => <ToolAuditRow key={record.id} record={record} />)
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No tool audits recorded yet.
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Cable className="text-primary" size={18} />
                <h2 className="font-semibold">MCP connectors</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Servers" value={`${connectorStats?.total ?? 0}`} />
                <MiniStat label="Active" value={`${connectorStats?.active ?? 0}`} />
                <MiniStat label="Tools" value={`${connectorStats?.toolCount ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={connectorName}
                  onChange={(event) => setConnectorName(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="MCP connector name"
                />
                <input
                  value={connectorEndpoint}
                  onChange={(event) => setConnectorEndpoint(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="MCP endpoint URL"
                />
                <input
                  value={connectorAuthEnv}
                  onChange={(event) => setConnectorAuthEnv(event.target.value.toUpperCase())}
                  className="h-10 rounded-md border border-line bg-background px-3 font-mono text-sm outline-none focus:border-primary"
                  placeholder="TOKEN_ENV_NAME"
                  aria-label="MCP bearer token environment variable"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => registerConnector(false)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
                  >
                    <CheckCircle2 size={15} />
                    Register
                  </button>
                  <button
                    type="button"
                    onClick={() => registerConnector(true)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                  >
                    <Search size={15} />
                    Discover
                  </button>
                </div>
                {connectorResult ? (
                  <pre className="max-h-48 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {connectorResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestConnectors.length ? (
                    latestConnectors.map((connector) => (
                      <McpConnectorRow key={connector.id} connector={connector} onDiscover={discoverConnector} />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No MCP connectors registered.
                    </p>
                  )}
                  {latestMcpTools.map((tool) => (
                    <McpToolRow key={tool.id} tool={tool} />
                  ))}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Globe2 className="text-primary" size={18} />
                <h2 className="font-semibold">OpenAPI connectors</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="APIs" value={`${openApiStats?.total ?? 0}`} />
                <MiniStat label="Active" value={`${openApiStats?.active ?? 0}`} />
                <MiniStat label="Ops" value={`${openApiStats?.operationCount ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={openApiName}
                  onChange={(event) => setOpenApiName(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="OpenAPI connector name"
                />
                <input
                  value={openApiSpecUrl}
                  onChange={(event) => setOpenApiSpecUrl(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="OpenAPI spec URL"
                />
                <input
                  value={openApiBaseUrl}
                  onChange={(event) => setOpenApiBaseUrl(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  placeholder="Base URL override"
                  aria-label="OpenAPI base URL override"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={openApiAuthEnv}
                    onChange={(event) => setOpenApiAuthEnv(event.target.value.toUpperCase())}
                    className="h-10 min-w-0 rounded-md border border-line bg-background px-3 font-mono text-sm outline-none focus:border-primary"
                    placeholder="API_KEY_ENV"
                    aria-label="OpenAPI API key environment variable"
                  />
                  <input
                    value={openApiAuthHeader}
                    onChange={(event) => setOpenApiAuthHeader(event.target.value)}
                    className="h-10 min-w-0 rounded-md border border-line bg-background px-3 font-mono text-sm outline-none focus:border-primary"
                    aria-label="OpenAPI API key header"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => registerOpenApiConnector(false)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium text-foreground transition hover:border-primary"
                  >
                    <CheckCircle2 size={15} />
                    Register
                  </button>
                  <button
                    type="button"
                    onClick={() => registerOpenApiConnector(true)}
                    className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                  >
                    <Search size={15} />
                    Import
                  </button>
                </div>
                {openApiResult ? (
                  <pre className="max-h-48 overflow-auto rounded-md border border-line bg-background/70 p-3 font-mono text-[11px] leading-5 text-muted">
                    {openApiResult}
                  </pre>
                ) : null}
                <div className="flex flex-col gap-3">
                  {latestOpenApiConnectors.length ? (
                    latestOpenApiConnectors.map((connector) => (
                      <OpenApiConnectorRow
                        key={connector.id}
                        connector={connector}
                        onImport={importOpenApiConnector}
                      />
                    ))
                  ) : (
                    <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                      No OpenAPI connectors registered.
                    </p>
                  )}
                  {latestOpenApiOperations.map((operation) => (
                    <OpenApiOperationRow key={operation.id} operation={operation} />
                  ))}
                </div>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <UploadCloud className="text-primary" size={18} />
                <h2 className="font-semibold">Knowledge ingest</h2>
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={knowledgeTitle}
                  onChange={(event) => setKnowledgeTitle(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="Knowledge title"
                />
                <textarea
                  value={knowledgeContent}
                  onChange={(event) => setKnowledgeContent(event.target.value)}
                  className="min-h-32 resize-none rounded-md border border-line bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                  aria-label="Knowledge content"
                />
                <button
                  type="button"
                  onClick={saveKnowledgeDocument}
                  className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                >
                  <UploadCloud size={16} />
                  Ingest
                </button>
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Search className="text-primary" size={18} />
                <h2 className="font-semibold">Memory browser</h2>
              </div>
              <div className="mb-3 flex gap-2">
                <input
                  value={browserQuery}
                  onChange={(event) => setBrowserQuery(event.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  placeholder="Search memory..."
                  aria-label="Search memory and knowledge"
                />
                <button
                  type="button"
                  onClick={searchWorkspace}
                  className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-ink transition hover:brightness-110"
                  aria-label="Search"
                >
                  <Search size={16} />
                </button>
              </div>
              <div className="flex flex-col gap-3">
                {memories.length ? (
                  memories.map((memory) => <MemoryRow key={memory.id} memory={memory} />)
                ) : (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No memories found.
                  </p>
                )}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <FileText className="text-primary" size={18} />
                <h2 className="font-semibold">Knowledge library</h2>
              </div>
              <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
                <MiniStat label="Docs" value={`${capabilities?.knowledge.documents ?? 0}`} />
                <MiniStat label="Chunks" value={`${capabilities?.knowledge.chunks ?? 0}`} />
                <MiniStat label="Vectors" value={`${capabilities?.knowledge.embedded ?? 0}`} />
              </div>
              <div className="flex flex-col gap-3">
                {documents.map((document) => (
                  <DocumentRow key={document.id} document={document} />
                ))}
                {chunks.map((chunk) => (
                  <ChunkRow key={chunk.id} chunk={chunk} />
                ))}
                {!documents.length && !chunks.length ? (
                  <p className="rounded-md border border-line bg-background/54 p-3 text-sm leading-6 text-muted">
                    No knowledge documents found.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="text-primary" size={18} />
                <h2 className="font-semibold">Specialist agents</h2>
              </div>
              <div className="flex flex-col gap-3">
                {capabilities?.registry.agents.map((agent) => (
                  <CapabilityRow key={agent.id} capability={agent} />
                ))}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Cable className="text-primary" size={18} />
                <h2 className="font-semibold">Tool surface</h2>
              </div>
              <div className="flex flex-col gap-3">
                {capabilities?.registry.tools.map((tool) => (
                  <CapabilityRow key={tool.id} capability={tool} />
                ))}
              </div>
            </section>

            <section className="panel rounded-lg p-4">
              <div className="mb-4 flex items-center gap-2">
                <Brain className="text-primary" size={18} />
                <h2 className="font-semibold">Memory write</h2>
              </div>
              <div className="flex flex-col gap-3">
                <input
                  value={memoryTitle}
                  onChange={(event) => setMemoryTitle(event.target.value)}
                  className="h-10 rounded-md border border-line bg-background px-3 text-sm outline-none focus:border-primary"
                  aria-label="Memory title"
                />
                <textarea
                  value={memoryContent}
                  onChange={(event) => setMemoryContent(event.target.value)}
                  className="min-h-28 resize-none rounded-md border border-line bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary"
                  aria-label="Memory content"
                />
                <button
                  type="button"
                  onClick={saveManualMemory}
                  className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary/60 text-sm font-medium text-primary transition hover:bg-primary hover:text-primary-ink"
                >
                  <CheckCircle2 size={16} />
                  Save memory
                </button>
              </div>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}

function StatusPill({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-line bg-background/70 px-3 py-2">
      <div className="flex items-center gap-2 text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 font-mono text-base text-foreground">{value}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-background/70 px-2 py-2">
      <p className="text-muted">{label}</p>
      <p className="mt-1 font-mono text-sm text-foreground">{value}</p>
    </div>
  );
}

function ToolAuditRow({ record }: { record: ToolExecutionRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", statusTone(record.status))}>
          {record.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(record.riskLevel))}>
          R{record.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{record.toolName}</p>
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{record.dryRun ? "dry" : "live"}</span>
        <span>{new Date(record.createdAt).toLocaleTimeString()}</span>
      </div>
      {record.reason ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{record.reason}</p> : null}
    </div>
  );
}

function McpConnectorRow({
  connector,
  onDiscover,
}: {
  connector: McpConnectorRecord;
  onDiscover: (connectorId: string) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", connectorTone(connector.status))}>
          {connector.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(connector.defaultRiskLevel))}>
          R{connector.defaultRiskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{connector.name}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{connector.endpoint}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-muted">{connector.toolCount} tools</span>
        <button
          type="button"
          onClick={() => onDiscover(connector.id)}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          Refresh
        </button>
      </div>
      {connector.lastError ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{connector.lastError}</p>
      ) : null}
    </div>
  );
}

function McpToolRow({ tool }: { tool: McpToolRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">mcp tool</span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(tool.riskLevel))}>
          R{tool.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{tool.title || tool.name}</p>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">
        {tool.description || tool.connectorName}
      </p>
    </div>
  );
}

function OpenApiConnectorRow({
  connector,
  onImport,
}: {
  connector: OpenApiConnectorRecord;
  onImport: (connectorId: string) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", connectorTone(connector.status))}>
          {connector.status}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(connector.defaultRiskLevel))}>
          R{connector.defaultRiskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{connector.name}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{connector.baseUrl}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-muted">{connector.operationCount} ops</span>
        <button
          type="button"
          onClick={() => onImport(connector.id)}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary"
        >
          Refresh
        </button>
      </div>
      {connector.lastError ? (
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{connector.lastError}</p>
      ) : null}
    </div>
  );
}

function OpenApiOperationRow({ operation }: { operation: OpenApiOperationRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-accent/14 px-2 py-1 font-mono text-[11px] text-accent">
          {operation.method}
        </span>
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", riskTone(operation.riskLevel))}>
          R{operation.riskLevel}
        </span>
      </div>
      <p className="line-clamp-1 text-sm font-medium leading-5">{operation.summary || operation.operationId}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{operation.path}</p>
    </div>
  );
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">
          {memory.type}
        </span>
        <span className="font-mono text-[11px] text-muted">{memory.importance.toFixed(2)}</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-5">{memory.title}</p>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted">{memory.content}</p>
      <TagList tags={memory.tags} />
    </div>
  );
}

function DocumentRow({ document }: { document: KnowledgeDocument }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-primary/16 px-2 py-1 font-mono text-[11px] text-primary">
          {document.sourceType}
        </span>
        <span className="font-mono text-[11px] text-muted">{document.chunkCount} chunks</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-5">{document.title}</p>
      <p className="mt-2 truncate font-mono text-[11px] text-muted">{document.source}</p>
      <TagList tags={document.tags} />
    </div>
  );
}

function ChunkRow({ chunk }: { chunk: KnowledgeChunk }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="rounded bg-accent/14 px-2 py-1 font-mono text-[11px] text-accent">
          chunk
        </span>
        <span className="font-mono text-[11px] text-muted">{chunk.tokenEstimate} tokens</span>
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-5">{chunk.title}</p>
      <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted">{chunk.content}</p>
      <TagList tags={chunk.tags} />
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap gap-1">
      {tags.slice(0, 4).map((tag) => (
        <span key={tag} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
          {tag}
        </span>
      ))}
    </div>
  );
}

function CapabilityRow({ capability }: { capability: Capability }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{capability.name}</p>
        <span
          className={clsx(
            "rounded px-2 py-1 font-mono text-[11px]",
            capability.status === "active"
              ? "bg-primary/16 text-primary"
              : "bg-accent/14 text-accent",
          )}
        >
          {capability.status}
        </span>
      </div>
      <p className="text-xs leading-5 text-muted">{capability.description}</p>
    </div>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span
          className={clsx(
            "rounded px-2 py-1 font-mono text-[11px]",
            run.status === "completed"
              ? "bg-primary/16 text-primary"
              : run.status === "failed"
                ? "bg-danger/14 text-danger"
                : "bg-accent/14 text-accent",
          )}
        >
          {run.status}
        </span>
        <span className="font-mono text-[11px] text-muted">{run.mode}</span>
      </div>
      <p className="line-clamp-2 text-sm leading-5">{run.prompt || "Untitled run"}</p>
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{run.model || "model pending"}</span>
        <span>{run.memoryContextCount} ctx</span>
        <span>{run.consolidationCount || 0} learned</span>
      </div>
    </div>
  );
}

function WorkflowRow({
  workflow,
  onTick,
  onSignal,
}: {
  workflow: WorkflowRunRecord;
  onTick: (workflowId: string) => void;
  onSignal: (workflowId: string, signal: "pause" | "resume" | "cancel" | "approve" | "retry") => void;
}) {
  const canTick = workflow.status === "queued" || workflow.status === "running";
  const canApprove = workflow.status === "waiting_approval";
  const canPause = workflow.status === "queued" || workflow.status === "running";
  const canResume = workflow.status === "paused";
  const canRetry = workflow.status === "failed";
  const isTerminal = ["completed", "canceled"].includes(workflow.status);

  return (
    <div className="rounded-md border border-line bg-background/54 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={clsx("rounded px-2 py-1 font-mono text-[11px]", workflowTone(workflow.status))}>
          {workflow.status}
        </span>
        <span className="font-mono text-[11px] text-muted">
          {workflow.currentStep || "done"}
        </span>
      </div>
      <p className="line-clamp-2 text-sm leading-5">{workflow.goal}</p>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <button
          type="button"
          disabled={!canTick}
          onClick={() => onTick(workflow.id)}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Tick
        </button>
        <button
          type="button"
          disabled={!canApprove}
          onClick={() => onSignal(workflow.id, "approve")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={!canRetry}
          onClick={() => onSignal(workflow.id, "retry")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Retry
        </button>
        <button
          type="button"
          disabled={!canPause}
          onClick={() => onSignal(workflow.id, "pause")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Pause
        </button>
        <button
          type="button"
          disabled={!canResume}
          onClick={() => onSignal(workflow.id, "resume")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Resume
        </button>
        <button
          type="button"
          disabled={isTerminal}
          onClick={() => onSignal(workflow.id, "cancel")}
          className="h-8 rounded-md border border-line px-2 text-xs font-medium text-foreground transition hover:border-danger disabled:cursor-not-allowed disabled:opacity-45"
        >
          Cancel
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[11px] text-muted">
        <span>{workflow.workflowType}</span>
        <span>{workflow.attempt}/{workflow.maxAttempts}</span>
      </div>
      {workflow.error ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-danger">{workflow.error}</p> : null}
    </div>
  );
}

function statusTone(status: ToolExecutionStatus) {
  if (status === "executed") {
    return "bg-primary/16 text-primary";
  }

  if (status === "failed" || status === "blocked") {
    return "bg-danger/14 text-danger";
  }

  if (status === "approval_required") {
    return "bg-accent/14 text-accent";
  }

  return "bg-background text-muted";
}

function workflowTone(status: WorkflowRunStatus) {
  if (status === "completed") {
    return "bg-primary/16 text-primary";
  }

  if (status === "failed" || status === "canceled") {
    return "bg-danger/14 text-danger";
  }

  if (status === "waiting_approval" || status === "paused") {
    return "bg-accent/14 text-accent";
  }

  return "bg-background text-muted";
}

function riskTone(riskLevel: RiskLevel) {
  if (riskLevel === 0) {
    return "bg-primary/16 text-primary";
  }

  if (riskLevel === 1) {
    return "bg-accent/14 text-accent";
  }

  return "bg-danger/14 text-danger";
}

function connectorTone(status: McpConnectorRecord["status"]) {
  if (status === "active") {
    return "bg-primary/16 text-primary";
  }

  if (status === "error") {
    return "bg-danger/14 text-danger";
  }

  return "bg-background text-muted";
}

function formatToolResult(value: unknown) {
  const formatted = JSON.stringify(value, null, 2) || "";
  return formatted.length > 2600 ? `${formatted.slice(0, 2600)}\n...` : formatted;
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, string>) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));

      if (!dataLine) {
        continue;
      }

      onEvent(JSON.parse(dataLine.slice(6)));
    }
  }
}
