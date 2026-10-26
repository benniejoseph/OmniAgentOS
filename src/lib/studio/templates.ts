import type {
  StudioGraph,
  StudioNode,
  StudioNodeType,
  StudioProjectProfileInput,
} from "./contracts";
import type { GraphCapability } from "./graph";

export const STUDIO_TEMPLATES = [
  {
    id: "image-to-video",
    name: "Image to video",
    description: "Create an image, then bring it into motion.",
  },
  {
    id: "product-scene",
    name: "Product scene",
    description: "Use your product image as a reference for a scene and video.",
  },
  {
    id: "two-directions",
    name: "Two creative directions",
    description:
      "Compare two separate image and video directions from one prompt.",
  },
] as const;
export type StudioTemplateId = (typeof STUDIO_TEMPLATES)[number]["id"];
export function createStudioNode(
  type: StudioNodeType,
  id: string,
  x: number,
  y: number,
  capabilities: readonly GraphCapability[] = [],
): StudioNode {
  const cap =
    capabilities.find(
      (c) =>
        c.mediaKind === type &&
        c.available !== false &&
        !c.inputRoles.some((r) => r.required),
    ) ?? capabilities.find((c) => c.mediaKind === type);
  return {
    id,
    type,
    title: {
      prompt: "Prompt",
      asset: "Reference",
      image: "Generate image",
      video: "Generate video",
      output: "Output",
      note: "Note",
    }[type],
    enabled: true,
    position: { x, y },
    config: {
      parameters: Object.fromEntries(
        (cap?.parameters ?? [])
          .filter((p) => p.default !== undefined)
          .map((p) => [p.key, p.default!]),
      ),
      ...((type === "image" || type === "video") && cap
        ? { capabilityId: cap.id }
        : {}),
      ...(type === "asset" ? { assetMediaType: "image/png" } : {}),
    },
  };
}
/** Chooses only published capabilities. Missing providers remain visibly unavailable in validation. */
export function createStudioTemplate(
  id: StudioTemplateId,
  capabilities: readonly GraphCapability[],
  profile?: StudioProjectProfileInput,
): StudioGraph {
  const graph: StudioGraph = { schemaVersion: 1, nodes: [], edges: [] };
  const add = (type: StudioNodeType, nodeId: string, x: number, y: number) => {
    const n = createStudioNode(type, nodeId, x, y, capabilities);
    graph.nodes.push(n);
    return n;
  };
  const connect = (
    source: string,
    sourcePort: string,
    target: string,
    targetPort: string,
  ) =>
    graph.edges.push({
      id: `edge-${graph.edges.length + 1}`,
      source,
      sourcePort,
      target,
      targetPort,
      order: graph.edges.length,
    });
  const prompt = add("prompt", "prompt", 40, 100);
  prompt.config.prompt =
    "A ceramic teapot on a sunlit kitchen table. Soft morning light, quiet natural colors, detailed product photography.";
  if (profile)
    prompt.config.prompt = {
      fashion:
        "An editorial outfit story: natural fabric movement, considered accessories and flattering daylight. Represent the supplied clothing accurately.",
      trading:
        "An educational visual about managing trading risk. A clean, symbolic candlestick chart and simple composition. No invented prices or return claims.",
      "ai-tech":
        "A practical AI workflow explained as a clear visual sequence: an idea, a helpful tool and a finished creative result. Modern, friendly and readable.",
      custom: `Create a distinctive visual story for ${profile.brandName}. One clear subject, thoughtful lighting and a simple composition.`,
    }[profile.category];
  let asset: StudioNode | undefined;
  if (id === "product-scene") {
    asset = add("asset", "product", 40, 380);
    asset.title = "Your product image";
  }
  const directions = id === "two-directions" ? 2 : 1;
  for (let i = 0; i < directions; i++) {
    const suffix = i ? "-b" : "";
    const image = add("image", `image${suffix}`, 410, 80 + i * 380);
    if (directions > 1) {
      image.title = i ? "Editorial direction" : "Natural direction";
      image.config.instruction = i
        ? "Use a deep, minimal studio setting with dramatic side light."
        : "Use a bright natural setting with soft window light.";
    }
    if (asset) {
      const editor =
        capabilities.find(
          (c) =>
            c.mediaKind === "image" &&
            c.inputRoles.some((r) => r.mediaKind === "image") &&
            c.available !== false,
        ) ??
        capabilities.find(
          (c) =>
            c.mediaKind === "image" &&
            c.inputRoles.some((r) => r.mediaKind === "image"),
        );
      if (editor) {
        image.config.capabilityId = editor.id;
        image.config.parameters = Object.fromEntries(
          editor.parameters
            .filter((p) => p.default !== undefined)
            .map((p) => [p.key, p.default!]),
        );
        connect(asset.id, "image", image.id, editor.inputRoles[0].portId);
      }
    }
    const video = add("video", `video${suffix}`, 800, 80 + i * 380);
    const imageVideo =
      capabilities.find(
        (c) =>
          c.mediaKind === "video" &&
          c.inputRoles.some((r) => r.mediaKind === "image" && r.required) &&
          c.inputRoles.filter((r) => r.required).length === 1 &&
          c.available !== false,
      ) ??
      capabilities.find(
        (c) =>
          c.mediaKind === "video" &&
          c.inputRoles.some((r) => r.mediaKind === "image") &&
          c.available !== false,
      ) ??
      capabilities.find(
        (c) =>
          c.mediaKind === "video" &&
          c.inputRoles.some((r) => r.mediaKind === "image"),
      );
    if (imageVideo) {
      video.config.capabilityId = imageVideo.id;
      video.config.parameters = Object.fromEntries(
        imageVideo.parameters
          .filter((p) => p.default !== undefined)
          .map((p) => [p.key, p.default!]),
      );
    }
    video.config.instruction =
      "Create a short, gentle camera move. Preserve the subject and composition.";
    const gallery = add("output", `output${suffix}`, 1190, 80 + i * 380);
    connect(prompt.id, "text", image.id, "prompt");
    connect(prompt.id, "text", video.id, "prompt");
    connect(
      image.id,
      "selected",
      video.id,
      imageVideo?.inputRoles.find((r) => r.mediaKind === "image")?.portId ??
        "start",
    );
    connect(image.id, "images", gallery.id, "media");
    connect(video.id, "videos", gallery.id, "media");
  }
  return graph;
}
export const buildStudioTemplate = createStudioTemplate;
