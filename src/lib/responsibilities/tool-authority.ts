import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ToolDefinition } from "@/lib/tools/types";

/** Responsibility authority excludes only the tool's top-level display copy.
 * Keep schemas (including their descriptions), operational metadata and future
 * contract fields pinned. Historical whole-definition pins require fresh review;
 * they are never accepted as an alternative to this versioned contract. */
export function responsibilityToolAuthoritySha256(tool: ToolDefinition): string {
  const authority = Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "name" && key !== "description"));
  return canonicalJsonSha256({ kind: "responsibility_tool_authority", schemaVersion: 1, authority });
}
