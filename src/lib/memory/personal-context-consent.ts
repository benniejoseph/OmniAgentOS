import { createHash } from "node:crypto";
import { z } from "zod";

export const PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION = 1 as const;
export const PERSONAL_CONTEXT_CONSENT_CONTRACT_ID =
  "personal-context-consent:1" as const;
export const PERSONAL_CONTEXT_NOTICE_CONTRACT_ID =
  "notice:personal-context-automatic" as const;
export const PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION = 1 as const;
export const PERSONAL_CONTEXT_NOTICE_TEXT =
  "Allow Asael to automatically select relevant saved personal memory only for requests where you choose Personal automatic context. This does not share memory with other users or agents, authorize tools, or change memory. You can turn it off at any time." as const;
export const PERSONAL_CONTEXT_NOTICE_SHA256 =
  "443267b19d744dc16298e950b4c5c0f8543124a526488fa018668193e61f1e75" as const;

const canonicalActorIdSchema = z.string().regex(
  /^actor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);

const personalContextConsentAuthorityShapeSchema = z
  .object({
    schemaVersion: z.literal(PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION),
    contractId: z.literal(PERSONAL_CONTEXT_CONSENT_CONTRACT_ID),
    tenantId: opaqueIdSchema,
    actorId: canonicalActorIdSchema,
    consentGeneration: z.number().int().positive().safe(),
    lifecycleRevision: z.literal(1),
    noticeContractId: z.literal(PERSONAL_CONTEXT_NOTICE_CONTRACT_ID),
    noticeContractVersion: z.literal(PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION),
    noticeSha256: z.literal(PERSONAL_CONTEXT_NOTICE_SHA256),
    activatedAt: canonicalTimestampSchema,
  })
  .strict();

export const personalContextConsentAuthorityV1Schema =
  personalContextConsentAuthorityShapeSchema
    .extend({ authoritySha256: sha256Schema })
    .strict()
    .superRefine((value, context) => {
      const { authoritySha256, ...authority } = value;
      if (authoritySha256 !== personalContextConsentAuthoritySha256(authority)) {
        context.addIssue({
          code: "custom",
          path: ["authoritySha256"],
          message: "Personal-context consent authority digest is invalid.",
        });
      }
    });

export type PersonalContextConsentAuthorityV1 = z.infer<
  typeof personalContextConsentAuthorityV1Schema
>;

export type PersonalContextConsentNoticeV1 = Readonly<{
  contractId: typeof PERSONAL_CONTEXT_NOTICE_CONTRACT_ID;
  version: typeof PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION;
  text: typeof PERSONAL_CONTEXT_NOTICE_TEXT;
  sha256: typeof PERSONAL_CONTEXT_NOTICE_SHA256;
}>;

export type PersonalContextConsentStatusV1 = Readonly<{
  schemaVersion: typeof PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION;
  state: "inactive" | "active";
  notice: PersonalContextConsentNoticeV1;
  authority: PersonalContextConsentAuthorityV1 | null;
}>;

export function personalContextConsentNotice(): PersonalContextConsentNoticeV1 {
  return Object.freeze({
    contractId: PERSONAL_CONTEXT_NOTICE_CONTRACT_ID,
    version: PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION,
    text: PERSONAL_CONTEXT_NOTICE_TEXT,
    sha256: PERSONAL_CONTEXT_NOTICE_SHA256,
  });
}

export function buildPersonalContextConsentAuthorityV1(input: {
  tenantId: string;
  actorId: string;
  consentGeneration: number;
  activatedAt: string;
}): PersonalContextConsentAuthorityV1 {
  const authority = personalContextConsentAuthorityShapeSchema.parse({
    schemaVersion: PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION,
    contractId: PERSONAL_CONTEXT_CONSENT_CONTRACT_ID,
    tenantId: input.tenantId,
    actorId: input.actorId,
    consentGeneration: input.consentGeneration,
    lifecycleRevision: 1,
    noticeContractId: PERSONAL_CONTEXT_NOTICE_CONTRACT_ID,
    noticeContractVersion: PERSONAL_CONTEXT_NOTICE_CONTRACT_VERSION,
    noticeSha256: PERSONAL_CONTEXT_NOTICE_SHA256,
    activatedAt: input.activatedAt,
  });
  return Object.freeze({
    ...authority,
    authoritySha256: personalContextConsentAuthoritySha256(authority),
  });
}

export function personalContextConsentStatus(
  authority: PersonalContextConsentAuthorityV1 | null,
): PersonalContextConsentStatusV1 {
  return Object.freeze({
    schemaVersion: PERSONAL_CONTEXT_CONSENT_SCHEMA_VERSION,
    state: authority ? "active" : "inactive",
    notice: personalContextConsentNotice(),
    authority,
  });
}

export function personalContextConsentAuthoritySha256(
  authority: z.input<typeof personalContextConsentAuthorityShapeSchema>,
) {
  const parsed = personalContextConsentAuthorityShapeSchema.parse(authority);
  return createHash("sha256")
    .update(JSON.stringify(parsed))
    .digest("hex");
}
