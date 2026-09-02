import { isOmniAgentPlaywrightMcpEndpoint } from "@/lib/connectors/mcp-trust";
import { listMcpConnectors, parseMcpToolId } from "@/lib/connectors/store";
import { listStreamEvents } from "@/lib/events/store";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import type { ToolExecutionRecord, ToolExecutionStatus } from "@/lib/tools/types";

const browserActionLabels: Readonly<Record<string, string>> = {
  browser_snapshot: "Read page structure",
  browser_take_screenshot: "Capture page view",
  browser_console_messages: "Inspect browser console",
  browser_network_requests: "Inspect network activity",
  browser_wait_for: "Wait for page update",
  browser_find: "Find an element",
  browser_navigate: "Open website",
  browser_navigate_back: "Go back",
  browser_hover: "Hover over an element",
  browser_resize: "Resize browser",
  browser_click: "Click an element",
  browser_type: "Enter text",
  browser_fill_form: "Fill form",
  browser_select_option: "Choose an option",
  browser_press_key: "Press a key",
  browser_drag: "Drag an element",
  browser_handle_dialog: "Handle browser dialog",
  browser_tabs: "Manage browser tabs",
  browser_close: "Close browser",
};

export type BrowserActivityItem = {
  id: string;
  sequence: number;
  at: string;
  action: string;
  operation: string;
  status: ToolExecutionStatus;
  targetOrigin?: string;
  durationMs?: number;
  summary: string;
  error?: string;
};

export async function listRunBrowserActivity(
  runId: string,
  options: { tenantId: string; actorId: string },
): Promise<BrowserActivityItem[]> {
  const events = await listStreamEvents(`run:${runId}`, {
    tenantId: options.tenantId,
    limit: 2_000,
  });
  const eventByExecutionId = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (event.type !== "run.tool") continue;
    const executionId = stringField(event.payload, "executionId");
    if (executionId) eventByExecutionId.set(executionId, event);
  }
  if (!eventByExecutionId.size) return [];

  const [executions, connectors] = await Promise.all([
    getToolExecutionsByIds([...eventByExecutionId.keys()], {
      tenantId: options.tenantId,
    }),
    listMcpConnectors(100, { tenantId: options.tenantId }),
  ]);
  const playwrightConnectorIds = new Set(
    connectors
      .filter((connector) => isOmniAgentPlaywrightMcpEndpoint(connector.endpoint))
      .map((connector) => connector.id),
  );

  return executions.flatMap((execution) => {
    if (execution.actorId !== options.actorId) return [];
    const parsed = safelyParseMcpToolId(execution.toolId);
    const operation = parsed?.toolName.trim().toLowerCase() || "";
    if (
      !parsed ||
      !playwrightConnectorIds.has(parsed.connectorId) ||
      !browserActionLabels[operation]
    ) {
      return [];
    }
    const event = eventByExecutionId.get(execution.id);
    if (!event) return [];
    const durationMs = executionDurationMs(execution);
    const failure = browserFailure(execution);
    return [{
      id: execution.id,
      sequence: event.seq,
      at: execution.completedAt || event.at,
      action: browserActionLabels[operation],
      operation,
      status: execution.status,
      targetOrigin: browserTargetOrigin(operation, execution.input),
      durationMs,
      summary: browserActivitySummary(execution.status),
      error: failure,
    }];
  }).sort((left, right) => left.sequence - right.sequence);
}

function safelyParseMcpToolId(toolId: string) {
  try {
    return parseMcpToolId(toolId);
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function browserTargetOrigin(
  operation: string,
  input: Record<string, unknown>,
) {
  if (operation !== "browser_navigate" && operation !== "browser_tabs") {
    return undefined;
  }
  const candidate = typeof input.url === "string" ? input.url : "";
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function executionDurationMs(execution: ToolExecutionRecord) {
  if (!execution.completedAt) return undefined;
  const startedAt = Date.parse(execution.createdAt);
  const completedAt = Date.parse(execution.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    return undefined;
  }
  return Math.max(0, completedAt - startedAt);
}

function browserActivitySummary(status: ToolExecutionStatus) {
  if (status === "executed") return "Completed through the governed Playwright connection.";
  if (status === "executing") return "Running in the isolated browser session.";
  if (status === "approval_required") return "Paused until you approve this browser interaction.";
  if (status === "dry_run") return "Previewed without changing the browser session.";
  if (status === "rejected") return "The browser interaction was rejected.";
  if (status === "blocked") return "The browser action was blocked by policy.";
  return "The browser action did not complete.";
}

function browserFailure(execution: ToolExecutionRecord) {
  if (!["failed", "blocked", "rejected"].includes(execution.status)) {
    return undefined;
  }
  const reason = execution.reason?.toLowerCase() || "";
  if (/chromium|browser.+(?:missing|unavailable)|executable/.test(reason)) {
    return "The isolated browser runtime was unavailable.";
  }
  if (/timed?\s*out|timeout/.test(reason)) {
    return "The browser action timed out.";
  }
  if (/network gateway|tunnel connection/.test(reason)) {
    return "The browser network gateway could not reach the destination.";
  }
  if (/policy|blocked|private|loopback|metadata/.test(reason)) {
    return "The destination or action was blocked by browser safety policy.";
  }
  return "The browser action failed. Protected technical details remain in monitoring.";
}
