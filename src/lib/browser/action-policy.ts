import { fingerprintApprovalContract, toolApprovalFingerprint } from "@/lib/tools/fingerprint";
import type { ToolDefinition, ToolRiskLevel } from "@/lib/tools/types";

export const BROWSER_ACTION_POLICY_VERSION = "p9.8-browser-action-policy:1";

export type BrowserActionDisposition =
  | "observation"
  | "exploration"
  | "consequential"
  | "privileged";

export type BrowserActionPolicyDecision = Readonly<{
  version: typeof BROWSER_ACTION_POLICY_VERSION;
  disposition: BrowserActionDisposition;
  operationClass: "read_only" | "mutation";
  riskLevel: ToolRiskLevel;
  approvalRequired: boolean;
  reversible: boolean;
}>;

const OBSERVATION_TOOLS = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_wait_for",
  "browser_find",
]);

const EXPLORATION_TOOLS = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_hover",
  "browser_resize",
  "browser_close",
]);

const PRIVILEGED_TOOLS = new Set([
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
  "browser_file_upload",
  "browser_drop",
  "browser_network_request",
]);

/**
 * This classifier trusts only the locally pinned operation name and structured
 * arguments. Page labels, accessibility text, model prose, and remote MCP
 * annotations cannot downgrade an action. A generic click therefore remains
 * consequential even when an untrusted page describes it as a link.
 */
export function classifyBrowserAction(
  toolName: string,
  input: Record<string, unknown>,
): BrowserActionDisposition {
  const name = toolName.trim().toLowerCase();
  if (PRIVILEGED_TOOLS.has(name)) return "privileged";
  if (OBSERVATION_TOOLS.has(name)) return "observation";
  if (EXPLORATION_TOOLS.has(name)) return "exploration";
  if (name === "browser_tabs") {
    if (input.action === "list") return "observation";
    if (
      input.action === "new" ||
      input.action === "select" ||
      input.action === "close"
    ) {
      return "exploration";
    }
    return "consequential";
  }

  // Clicks, typing, forms, key presses, selections, dialogs, drags, and any
  // newly introduced operation stay on the consequential path by default.
  return "consequential";
}

export function specializeBrowserActionTool(input: {
  tool: ToolDefinition;
  toolName: string;
  toolInput: Record<string, unknown>;
  forceApproval?: boolean;
}): Readonly<{
  tool: ToolDefinition;
  decision: BrowserActionPolicyDecision;
}> {
  const disposition = classifyBrowserAction(input.toolName, input.toolInput);
  const baseApprovalFingerprint = toolApprovalFingerprint(input.tool);
  const forceApproval = Boolean(input.forceApproval);
  const decision = policyDecision(
    disposition,
    input.tool.riskLevel,
    forceApproval,
  );
  const approvalFingerprint = fingerprintApprovalContract({
    version: BROWSER_ACTION_POLICY_VERSION,
    baseApprovalFingerprint,
    toolName: input.toolName.trim().toLowerCase(),
    disposition: decision.disposition,
    riskLevel: decision.riskLevel,
    approvalRequired: decision.approvalRequired,
    operationClass: decision.operationClass,
    reversible: decision.reversible,
  });
  return Object.freeze({
    decision,
    tool: Object.freeze({
      ...input.tool,
      riskLevel: decision.riskLevel,
      approvalRequired: decision.approvalRequired,
      operationClass: decision.operationClass,
      reversible: decision.reversible,
      approvalFingerprint,
    }),
  });
}

function policyDecision(
  disposition: BrowserActionDisposition,
  configuredRisk: ToolRiskLevel,
  configuredApproval: boolean,
): BrowserActionPolicyDecision {
  if (disposition === "privileged") {
    return Object.freeze({
      version: BROWSER_ACTION_POLICY_VERSION,
      disposition,
      operationClass: "mutation",
      riskLevel: 3,
      approvalRequired: true,
      reversible: false,
    });
  }
  if (disposition === "consequential") {
    return Object.freeze({
      version: BROWSER_ACTION_POLICY_VERSION,
      disposition,
      operationClass: "mutation",
      riskLevel: Math.max(configuredRisk, 2) as ToolRiskLevel,
      approvalRequired: true,
      reversible: false,
    });
  }
  if (disposition === "exploration") {
    return Object.freeze({
      version: BROWSER_ACTION_POLICY_VERSION,
      disposition,
      operationClass: "read_only",
      // The stored Playwright record groups all tab/close variants at risk 2.
      // This exact-input policy may narrow a known variant, but it never lowers
      // an administrator-configured risk-3 floor.
      riskLevel: configuredRisk === 3 ? 3 : 1,
      approvalRequired: configuredApproval,
      reversible: true,
    });
  }
  return Object.freeze({
    version: BROWSER_ACTION_POLICY_VERSION,
    disposition,
    operationClass: "read_only",
    riskLevel: configuredRisk === 3 ? 3 : 0,
    approvalRequired: configuredApproval,
    reversible: true,
  });
}
