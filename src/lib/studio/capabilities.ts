import type {
  StudioEstimate,
  StudioIssue,
  StudioMediaKind,
  StudioParameterValue,
} from "./contracts";

export type StudioOperation =
  | "image.generate"
  | "image.edit"
  | "video.text"
  | "video.image"
  | "video.frames";
export type StudioParameter = {
  key: string;
  label: string;
  type: "select" | "number" | "boolean" | "text";
  default: StudioParameterValue;
  options?: readonly StudioParameterValue[];
  min?: number;
  max?: number;
};
export type StudioCapability = {
  id: string;
  provider: "google" | "demo";
  model: string;
  operation: StudioOperation;
  mediaKind: "image" | "video";
  label: string;
  schemaVersion: 1;
  parameters: readonly StudioParameter[];
  inputRoles: readonly {
    portId: string;
    role: string;
    mediaKind: StudioMediaKind;
    required: boolean;
    maxConnections: number;
  }[];
  maxOutputs: number;
  available: boolean;
  unavailableReason?: string;
  demo: boolean;
  cancellation: "local" | "best-effort";
  pricing: { source: string; checkedAt: string; note: string };
};
const PRICE_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
const aspectRatio: StudioParameter = {
  key: "aspectRatio",
  label: "Aspect ratio",
  type: "select",
  default: "16:9",
  options: ["16:9", "9:16"],
};
const imageParameters: readonly StudioParameter[] = [
  {
    ...aspectRatio,
    default: "1:1",
    options: ["1:1", "16:9", "9:16", "4:3", "3:4"],
  },
  {
    key: "imageSize",
    label: "Image size",
    type: "select",
    default: "1K",
    options: ["1K", "2K", "4K"],
  },
];
const videoParameters: readonly StudioParameter[] = [
  aspectRatio,
  {
    key: "resolution",
    label: "Resolution",
    type: "select",
    default: "720p",
    options: ["720p"],
  },
];
const reference = {
  portId: "reference",
  role: "reference",
  mediaKind: "image" as const,
  required: true,
  maxConnections: 4,
};
const start = {
  portId: "start",
  role: "start_frame",
  mediaKind: "image" as const,
  required: true,
  maxConnections: 1,
};
const end = {
  portId: "end",
  role: "end_frame",
  mediaKind: "image" as const,
  required: true,
  maxConnections: 1,
};
const operations: {
  operation: StudioOperation;
  suffix: string;
  label: string;
  inputRoles: StudioCapability["inputRoles"];
}[] = [
  {
    operation: "image.generate",
    suffix: "image-generate",
    label: "Generate image",
    inputRoles: [],
  },
  {
    operation: "image.edit",
    suffix: "image-edit",
    label: "Edit with references",
    inputRoles: [reference],
  },
  {
    operation: "video.text",
    suffix: "video-text",
    label: "Text to video",
    inputRoles: [],
  },
  {
    operation: "video.image",
    suffix: "video-image",
    label: "Image to video",
    inputRoles: [start],
  },
  {
    operation: "video.frames",
    suffix: "video-frames",
    label: "Start and end frames",
    inputRoles: [start, end],
  },
];

/** Browser-safe definitions. Only the server can attest current credential availability. */
export const STUDIO_CAPABILITIES: readonly StudioCapability[] = (
  ["demo", "google"] as const
).flatMap((provider) =>
  operations.map((operation): StudioCapability => {
    const demo = provider === "demo";
    const image = operation.operation.startsWith("image.");
    const maxOutputs = demo && image ? 3 : 1;
    return {
      id: `${provider}-${operation.suffix}`,
      provider,
      model: demo
        ? "studio-fixture-v1"
        : image
          ? "gemini-3.1-flash-image"
          : "gemini-omni-1.1-flash",
      operation: operation.operation,
      mediaKind: image ? "image" : "video",
      label: `${demo ? "Demo · " : ""}${operation.label}`,
      schemaVersion: 1,
      parameters: [
        ...(image ? imageParameters : videoParameters),
        {
          key: "outputCount",
          label: "Outputs",
          type: "number",
          default: 1,
          min: 1,
          max: maxOutputs,
        },
      ],
      inputRoles: operation.inputRoles,
      maxOutputs,
      available: demo,
      ...(!demo
        ? {
            unavailableReason:
              "Checking the image/video model connection in Settings.",
          }
        : {}),
      demo,
      cancellation: demo ? "local" : "best-effort",
      pricing: {
        source: demo ? "Included demonstration fixtures" : PRICE_SOURCE,
        checkedAt: "2026-10-25",
        note: demo
          ? "Free fixed fixtures; prompts and controls do not generate new media."
          : image
            ? "Input and output tokens are billed. The displayed maximum uses the published model token limits."
            : "One 3–10 second video, billed by tokens. Duration is selected by the model; no hard duration control is exposed.",
      },
    };
  }),
);

export function getStudioCapability(id: string): StudioCapability | undefined {
  return STUDIO_CAPABILITIES.find((capability) => capability.id === id);
}
export const studioCapability = getStudioCapability;

/** Visible, deterministic reference bindings used in the provider request. */
export function renderStudioProviderPrompt(
  capabilityId: string,
  prompt: string,
): string {
  const operation = getStudioCapability(capabilityId)?.operation;
  if (operation === "video.image")
    return `[# Sources <FIRST_FRAME>@Image1]\n${prompt}`;
  if (operation === "video.frames")
    return `[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]\n${prompt}`;
  return prompt;
}

export function validateStudioProviderInputs(input: {
  capabilityId: string;
  prompt: string;
  parameters?: Record<string, unknown>;
  references?: readonly { role: string; mediaType: string }[];
}): {
  issues: StudioIssue[];
  parameters: Record<string, StudioParameterValue>;
} {
  const cap = getStudioCapability(input.capabilityId);
  const issues: StudioIssue[] = [];
  const add = (code: string, message: string) =>
    issues.push({ code, message, severity: "error" });
  if (!cap) {
    add("unsupported_capability", "Choose a supported model and operation.");
    return { issues, parameters: {} };
  }
  if (!input.prompt.trim() || input.prompt.length > 12002)
    add("invalid_prompt", "Use a prompt between 1 and 12,002 characters.");
  const parameters: Record<string, StudioParameterValue> = Object.fromEntries(
    cap.parameters.map((field) => [field.key, field.default]),
  );
  for (const [key, value] of Object.entries(input.parameters ?? {})) {
    const field = cap.parameters.find((p) => p.key === key);
    if (!field) {
      add(
        "unsupported_parameter",
        `${key} is not supported by this operation.`,
      );
      continue;
    }
    if (
      (field.options &&
        !field.options.includes(value as StudioParameterValue)) ||
      (field.type === "number" &&
        (typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < (field.min ?? -Infinity) ||
          value > (field.max ?? Infinity))) ||
      (field.type === "boolean" && typeof value !== "boolean") ||
      ((field.type === "select" || field.type === "text") &&
        typeof value !== "string")
    ) {
      add("invalid_parameter", `Choose a supported value for ${field.label}.`);
      continue;
    }
    parameters[key] = value as StudioParameterValue;
  }
  const refs = input.references ?? [];
  for (const ref of refs) {
    const role = cap.inputRoles.find((r) => r.role === ref.role);
    if (!role)
      add(
        "unsupported_reference",
        `This operation does not accept a ${ref.role} reference.`,
      );
    else if (!["image/png", "image/jpeg", "image/webp"].includes(ref.mediaType))
      add("reference_type", "References must be PNG, JPEG or WebP images.");
  }
  for (const role of cap.inputRoles) {
    const count = refs.filter((r) => r.role === role.role).length;
    if (role.required && !count)
      add(
        "missing_reference",
        `Connect the ${role.role.replaceAll("_", " ")} input.`,
      );
    if (count > role.maxConnections)
      add(
        "reference_limit",
        `Use at most ${role.maxConnections} ${role.role} references.`,
      );
  }
  return { issues, parameters };
}

/** Conservative, per-request token-limit bound; this is not a provider account spending limit. */
export function estimateStudioProviderCost(
  capabilityId: string,
  parameters: Record<string, unknown> = {},
): StudioEstimate {
  const cap = getStudioCapability(capabilityId);
  if (!cap)
    return {
      currency: "USD",
      status: "unknown",
      estimatedUsd: null,
      explanation: "Unsupported provider or model.",
    };
  if (cap.demo)
    return {
      currency: "USD",
      status: "known",
      estimatedUsd: 0,
      minimumUsd: 0,
      maximumUsd: 0,
      explanation: "Included demonstration fixtures. No paid request.",
    };
  if (Number(parameters.outputCount ?? 1) !== 1)
    return {
      currency: "USD",
      status: "unknown",
      estimatedUsd: null,
      explanation: "This provider supports one output per request.",
    };
  if (cap.mediaKind === "image")
    return {
      currency: "USD",
      status: "range",
      estimatedUsd:
        parameters.imageSize === "4K"
          ? 0.1512
          : parameters.imageSize === "2K"
            ? 0.1008
            : 0.0672,
      minimumUsd: 0,
      maximumUsd: 0.557056,
      explanation:
        "Estimated image output plus input/thinking usage. Maximum: 131,072 input tokens at $0.50/M and a server-enforced 8,192 output-token cap at the higher $60/M image rate, including thinking; no tools or extra requests.",
    };
  if (parameters.resolution && parameters.resolution !== "720p")
    return {
      currency: "USD",
      status: "unknown",
      estimatedUsd: null,
      explanation: "No verified cost bound for this resolution.",
    };
  return {
    currency: "USD",
    status: "range",
    estimatedUsd: 1.0136,
    minimumUsd: 0,
    maximumUsd: 2.719744,
    explanation:
      "One 720p video. Maximum: the full 1,048,576 input-token limit at $1.50/M plus a server-enforced 65,536 output-token cap at the higher $17.50/M video rate, including thinking. No tools, retries or extra requests. Model chooses duration.",
  };
}
