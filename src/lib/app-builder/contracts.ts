import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const APP_BUILDER_CONTRACT_VERSION = "app-builder-session:1" as const;
export const APP_BUILDER_TEMPLATE_ID = "nextjs-starter-v1" as const;
export const APP_BUILDER_ROOT = "/vercel/sandbox/app" as const;
export const APP_BUILDER_PREVIEW_PORT = 3000 as const;
export const APP_BUILDER_APP_PORT = 3001 as const;

export const appBuilderSessionStatusSchema = z.enum([
  "provisioning",
  "ready",
  "running",
  "failed",
  "stopped",
]);
export type AppBuilderSessionStatus = z.infer<typeof appBuilderSessionStatusSchema>;

export const appBuilderCommandKindSchema = z.enum([
  "lint",
  "typecheck",
  "test",
  "build",
  "start_preview",
]);
export type AppBuilderCommandKind = z.infer<typeof appBuilderCommandKindSchema>;

export type AppBuilderSession = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId: string;
  projectId: string;
  contractVersion: typeof APP_BUILDER_CONTRACT_VERSION;
  templateId: typeof APP_BUILDER_TEMPLATE_ID;
  sandboxName: string;
  status: AppBuilderSessionStatus;
  revision: number;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
}>;

export type AppBuilderActivity = Readonly<{
  id: string;
  sessionId: string;
  eventType: string;
  detail: Record<string, unknown>;
  payloadSha256: string;
  occurredAt: string;
}>;

export type AppBuilderFile = Readonly<{
  path: string;
  content: string;
  sha256: string;
  size: number;
}>;

export type AppBuilderTreeEntry = Readonly<{
  path: string;
  kind: "file" | "directory";
  size?: number;
}>;

export const builderProjectInputSchema = z.object({
  projectId: z.string().trim().min(1).max(200),
}).strict();

export const builderSessionCreateInputSchema = builderProjectInputSchema;

export const builderTreeInputSchema = builderProjectInputSchema.extend({
  sessionId: z.string().regex(/^app_build_[a-f0-9]{48}$/),
}).strict();

export const builderFileReadInputSchema = builderTreeInputSchema.extend({
  path: z.string().trim().min(1).max(240),
}).strict();

export const builderFileUpdateInputSchema = builderFileReadInputSchema.extend({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  content: z.string().max(500_000),
}).strict();

export const builderCommandInputSchema = builderTreeInputSchema.extend({
  command: appBuilderCommandKindSchema,
}).strict();

export const builderSessionStopInputSchema = builderTreeInputSchema;

const deniedSegments = new Set([
  ".git",
  ".next",
  "node_modules",
  ".env",
  ".vercel",
  "coverage",
]);

export function safeBuilderRelativePath(input: string) {
  const normalizedInput = input.trim().replaceAll("\\", "/");
  if (!normalizedInput || normalizedInput.includes("\0") || normalizedInput.startsWith("/")) {
    throw new Error("Builder file path must be a non-empty relative path.");
  }
  const normalized = path.posix.normalize(normalizedInput);
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    segments.some((segment) => segment === ".." || deniedSegments.has(segment))
  ) {
    throw new Error("Builder file path is outside the editable application boundary.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@+ -]*(?:\/[A-Za-z0-9][A-Za-z0-9._/@+ -]*)*$/.test(normalized)) {
    throw new Error("Builder file path contains unsupported characters.");
  }
  return normalized.slice(0, 240);
}

export function builderFileSha256(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

export function boundedBuilderOutput(value: string, limit = 32_000) {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}\n… output truncated by Asael`;
}
