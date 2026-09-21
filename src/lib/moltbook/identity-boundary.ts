import {
  buildAgentRunIdentityPinV1,
  parseAgentRunIdentityPinV1,
  type AgentRunIdentityPinV1,
  type ResolvedAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import {
  isExactMoltbookAgentCapabilityBoundary,
  MOLTBOOK_TOOL_IDS,
} from "@/lib/moltbook/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type MoltbookConnectionIdentityPin = Readonly<{
  logicalAgentId: string;
  principalId: string;
  principalGeneration: number;
  principalSha256: string;
  definitionVersion: number;
  definitionSha256: string;
  policyBoundarySha256: string;
}>;

/**
 * Binds a connection to one immutable Agent release and authority generation.
 * The digest is run-independent so a later run pin can be compared exactly.
 */
export function moltbookConnectionIdentityPinFromIdentity(
  identity: ResolvedAgentIdentityV1,
): MoltbookConnectionIdentityPin {
  const pin = buildAgentRunIdentityPinV1({
    runId: "moltbook:connection:identity",
    identity,
  });
  if (!isExactMoltbookAgentCapabilityBoundary({
    skillIds: pin.skillPins.map((skill) => skill.skillId),
    toolIds: identity.principal.toolGrantIds,
    memoryScope: identity.principal.memoryScope,
    autonomy: identity.principal.autonomy,
    approvalPolicy: identity.principal.approvalPolicy,
  }) ||
    identity.principal.contextGrantIds.length !== 0 ||
    identity.principal.capabilityGrantIds.length !== 0) {
    throw new Error("The Agent does not have the exact Moltbook capability boundary.");
  }
  return moltbookConnectionIdentityPinFromRunPin(pin);
}

export function moltbookConnectionIdentityPinFromRunPin(
  value: AgentRunIdentityPinV1,
): MoltbookConnectionIdentityPin {
  const pin = parseAgentRunIdentityPinV1(value);
  const material = {
    version: "moltbook.connection-policy-boundary.v1" as const,
    logicalAgentId: pin.logicalAgentId,
    definitionVersion: pin.definitionVersion,
    definitionSha256: pin.definitionSha256,
    principalId: pin.principalId,
    principalGeneration: pin.principalGeneration,
    principalSha256: pin.principalSha256,
    policyPins: pin.policyPins,
    skillPins: pin.skillPins,
    toolIds: [...MOLTBOOK_TOOL_IDS],
  };
  return Object.freeze({
    logicalAgentId: pin.logicalAgentId,
    principalId: pin.principalId,
    principalGeneration: pin.principalGeneration,
    principalSha256: pin.principalSha256,
    definitionVersion: pin.definitionVersion,
    definitionSha256: pin.definitionSha256,
    policyBoundarySha256: canonicalJsonSha256(material),
  });
}

export function moltbookConnectionIdentityPinsEqual(
  left: MoltbookConnectionIdentityPin,
  right: MoltbookConnectionIdentityPin,
) {
  return left.logicalAgentId === right.logicalAgentId &&
    left.principalId === right.principalId &&
    left.principalGeneration === right.principalGeneration &&
    left.principalSha256 === right.principalSha256 &&
    left.definitionVersion === right.definitionVersion &&
    left.definitionSha256 === right.definitionSha256 &&
    left.policyBoundarySha256 === right.policyBoundarySha256;
}
