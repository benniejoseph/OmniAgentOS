import { z } from "zod";

export const COMMAND_CONTEXT_KINDS = [
  "agent",
  "skill",
  "plugin",
  "project",
  "integration",
  "file",
] as const;

export type CommandContextKind = (typeof COMMAND_CONTEXT_KINDS)[number];

export const commandContextReferenceSchema = z.object({
  kind: z.enum(COMMAND_CONTEXT_KINDS),
  id: z.string().trim().min(1).max(320).regex(/^[A-Za-z0-9_.:@/+~=-]+$/),
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  versionId: z.string().trim().min(1).max(320).optional(),
  bindingSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((reference, context) => {
  if (
    reference.kind === "file" &&
    (!reference.versionId || !reference.bindingSha256)
  ) {
    context.addIssue({
      code: "custom",
      message: "File context must pin an exact version and content digest.",
    });
  }
});

export const commandContextReferencesSchema = z.array(commandContextReferenceSchema)
  .max(20)
  .superRefine((references, context) => {
    const seen = new Set<string>();
    for (const [index, reference] of references.entries()) {
      const key = `${reference.kind}:${reference.id}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Command context references must be unique.",
        });
      }
      seen.add(key);
    }
  });

export type CommandContextReference = z.infer<typeof commandContextReferenceSchema>;

export type CommandContextCatalogItem = Readonly<{
  kind: CommandContextKind;
  id: string;
  label: string;
  description: string;
  state?: string;
  selectable: boolean;
  sourceId?: string;
  expectedVersion?: number;
  versionId?: string;
  bindingSha256?: string;
}>;

export type CommandContextCatalog = Readonly<{
  version: 1;
  generatedAt: string;
  items: readonly CommandContextCatalogItem[];
  sources: Readonly<Record<CommandContextKind, "ready" | "unavailable">>;
}>;

export function commandContextReferenceKey(reference: CommandContextReference) {
  return `${reference.kind}:${reference.id}`;
}
