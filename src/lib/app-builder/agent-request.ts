export type AppBuilderAgentRequest = Readonly<{
  mode: "execute";
  projectId: string;
  message: string;
  requestId: string;
  strategy: "direct";
  agentId: "forge" | "sentinel";
  contextScope: "project";
}>;

export function buildAppBuilderAgentRequest(input: {
  projectId: string;
  message: string;
  requestId: string;
  agentId: "forge" | "sentinel";
}): AppBuilderAgentRequest {
  return {
    mode: "execute",
    projectId: input.projectId,
    message: input.message,
    requestId: input.requestId,
    strategy: "direct",
    agentId: input.agentId,
    contextScope: "project",
  };
}
