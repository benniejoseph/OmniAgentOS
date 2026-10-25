import { createHash } from "node:crypto";
import {
  estimateStudioProviderCost,
  getStudioCapability,
  renderStudioProviderPrompt,
} from "./capabilities";
import { studioCanonicalJson, type StudioParameterValue } from "./contracts";
import { StudioError } from "./server-types";
export type StudioCapabilityPin = {
  hash: string;
  model: string;
  schemaVersion: number;
};
/** Capability and request rendering semantics, excluding mutable availability/display metadata. */
export function studioCapabilityPin(
  id: string,
  parameters: Record<string, StudioParameterValue>,
): StudioCapabilityPin {
  const cap = getStudioCapability(id);
  if (!cap)
    throw new StudioError(
      "The accepted model capability is unavailable. Choose a model and quote again.",
      409,
      "studio_capability_changed",
    );
  const semantic = {
    requestContractVersion: 1,
    id: cap.id,
    provider: cap.provider,
    model: cap.model,
    schemaVersion: cap.schemaVersion,
    operation: cap.operation,
    mediaKind: cap.mediaKind,
    parameters: cap.parameters,
    inputRoles: cap.inputRoles,
    maxOutputs: cap.maxOutputs,
    cancellation: cap.cancellation,
    requestPrompt: renderStudioProviderPrompt(id, "__STUDIO_PROMPT__"),
    estimate: estimateStudioProviderCost(id, parameters),
  };
  return {
    hash: createHash("sha256")
      .update(studioCanonicalJson(semantic))
      .digest("hex"),
    model: cap.model,
    schemaVersion: cap.schemaVersion,
  };
}
