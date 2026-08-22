import { withDatabaseRequestScope } from "@/lib/db/client";
import { getToolExecutionStats } from "@/lib/tools/audit-store";
import { getGovernedTools } from "@/lib/tools/registry";
import { listMcpGovernedTools, listOpenApiGovernedTools } from "@/lib/connectors/governed-tools";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "tool",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const mcpTools = await listMcpGovernedTools({ tenantId: context.tenantId });
  const openApiTools = await listOpenApiGovernedTools({ tenantId: context.tenantId });

  return Response.json({
    tools: [...getGovernedTools(), ...mcpTools, ...openApiTools],
    audits: await getToolExecutionStats({ tenantId: context.tenantId }),
    policy: {
      riskLevels: [
        { level: 0, label: "Read-only", approvalRequired: false },
        { level: 1, label: "Low-risk reversible write", approvalRequired: false },
        { level: 2, label: "External side effect or sensitive action", approvalRequired: true },
        { level: 3, label: "High-impact or destructive action", approvalRequired: true },
      ],
      defaultBehavior: "Unknown tools are blocked. Planned tools cannot execute.",
    },
  });
}
