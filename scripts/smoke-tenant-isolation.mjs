const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000");
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const checks = [];

if (!internalSecret) {
  console.log("PASS tenant isolation smoke skipped - set SMOKE_INTERNAL_AUTH_SECRET or OMNIAGENT_INTERNAL_AUTH_SECRET");
  process.exit(0);
}

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const tenantA = `smoke_tenant_a_${suffix}`;
const tenantB = `smoke_tenant_b_${suffix}`;
const connectorName = `Smoke MCP tenant isolation ${suffix}`;
const correlationId = `smoke-tenant-isolation-${suffix}`;

const createdConnector = await jsonRequest("/api/connectors", {
  method: "POST",
  tenantId: tenantA,
  body: {
    name: connectorName,
    endpoint: "https://example.com/mcp",
    authType: "none",
    approvalRequired: false,
    discover: false,
  },
});
checks.push(assert(createdConnector.status === 201, "tenant A can create connector", statusDetail(createdConnector)));
const connectorId = createdConnector.json?.connector?.id;
checks.push(assert(Boolean(connectorId), "connector id returned", "missing connector id"));

const tenantAConnectors = await jsonRequest("/api/connectors", { tenantId: tenantA });
checks.push(assert(tenantAConnectors.status === 200, "tenant A can list connectors", statusDetail(tenantAConnectors)));
checks.push(assert(
  tenantAConnectors.json?.connectors?.some((connector) => connector.id === connectorId),
  "tenant A sees its connector",
  "created connector missing from tenant A list",
));

const tenantBConnectors = await jsonRequest("/api/connectors", { tenantId: tenantB });
checks.push(assert(tenantBConnectors.status === 200, "tenant B can list connectors", statusDetail(tenantBConnectors)));
checks.push(assert(
  !tenantBConnectors.json?.connectors?.some((connector) => connector.id === connectorId),
  "tenant B cannot see tenant A connector",
  "tenant A connector leaked into tenant B list",
));

const tenantBPatch = await jsonRequest(`/api/connectors/${connectorId}`, {
  method: "PATCH",
  tenantId: tenantB,
  body: { status: "disabled" },
});
checks.push(assert(tenantBPatch.status === 404, "tenant B cannot patch tenant A connector", statusDetail(tenantBPatch)));

const tenantAPatch = await jsonRequest(`/api/connectors/${connectorId}`, {
  method: "PATCH",
  tenantId: tenantA,
  body: { status: "disabled", name: `${connectorName} disabled` },
});
checks.push(assert(tenantAPatch.status === 200, "tenant A can patch its connector", statusDetail(tenantAPatch)));
checks.push(assert(
  tenantAPatch.json?.connector?.status === "disabled",
  "tenant A connector status updated",
  `expected disabled, got ${tenantAPatch.json?.connector?.status}`,
));

const marker = await jsonRequest("/api/observability", {
  method: "POST",
  tenantId: tenantA,
  body: {
    action: "record_marker",
    category: "security",
    level: "info",
    message: `Tenant isolation smoke marker ${suffix}`,
    correlationId,
    metadata: { smoke: true, tenant: tenantA },
  },
});
checks.push(assert(marker.status === 201, "tenant A can record observability marker", statusDetail(marker)));

const tenantBMarkerRead = await jsonRequest(`/api/observability?correlationId=${encodeURIComponent(correlationId)}&limit=20`, {
  tenantId: tenantB,
});
checks.push(assert(tenantBMarkerRead.status === 200, "tenant B can query observability", statusDetail(tenantBMarkerRead)));
checks.push(assert(
  (tenantBMarkerRead.json?.events || []).length === 0,
  "tenant B cannot see tenant A observability marker",
  "tenant A marker leaked into tenant B observability query",
));

const workflow = await jsonRequest("/api/workflows", {
  method: "POST",
  tenantId: tenantA,
  body: {
    goal: `Tenant isolation smoke workflow ${suffix}`,
    mode: "research",
    requireApproval: true,
    maxAttempts: 1,
    metadata: { smoke: true, tenant: tenantA },
  },
});
checks.push(assert(workflow.status === 201, "tenant A can create workflow", statusDetail(workflow)));
const workflowId = workflow.json?.run?.id;
checks.push(assert(Boolean(workflowId), "workflow id returned", "missing workflow id"));

const tenantBWorkflows = await jsonRequest("/api/workflows?limit=100", { tenantId: tenantB });
checks.push(assert(tenantBWorkflows.status === 200, "tenant B can list workflows", statusDetail(tenantBWorkflows)));
checks.push(assert(
  !tenantBWorkflows.json?.runs?.some((run) => run.id === workflowId),
  "tenant B cannot list tenant A workflow",
  "tenant A workflow leaked into tenant B workflow list",
));

const tenantBDelete = await jsonRequest(`/api/connectors/${connectorId}`, { method: "DELETE", tenantId: tenantB });
checks.push(assert(tenantBDelete.status === 404, "tenant B cannot delete tenant A connector", statusDetail(tenantBDelete)));

const tenantADelete = await jsonRequest(`/api/connectors/${connectorId}`, { method: "DELETE", tenantId: tenantA });
checks.push(assert(tenantADelete.status === 200, "tenant A can delete its connector", statusDetail(tenantADelete)));

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  const prefix = check.ok ? "PASS" : "FAIL";
  console.log(`${prefix} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
}

if (failures.length) {
  process.exitCode = 1;
}

async function jsonRequest(path, { method = "GET", tenantId = tenantA, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "x-omni-internal-auth": internalSecret,
      "x-omni-tenant-id": tenantId,
      "x-omni-user-id": `${tenantId}:smoke`,
      "x-omni-user-role": "admin",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

function statusDetail(result) {
  return `status ${result.status}${result.json?.error ? `: ${result.json.error}` : ""}`;
}

function assert(ok, label, detail) {
  return { ok, label, detail: ok ? undefined : detail };
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
