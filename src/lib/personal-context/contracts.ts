import { z } from "zod";

export const PERSONAL_PROFILE_CONTRACT = "asael-personal-profile:1" as const;
export const PERSONAL_PROFILE_FIELDS = ["name", "role", "workingContext", "preferences", "goals", "interests"] as const;
export type PersonalProfileField = (typeof PERSONAL_PROFILE_FIELDS)[number];
export const PERSONAL_PROFILE_FIELD_DETAILS = {
  name: { label: "What should ATLAS call you?", maxLength: 120 },
  role: { label: "Your role", maxLength: 600 },
  workingContext: { label: "How you work", maxLength: 2400 },
  preferences: { label: "Your preferences", maxLength: 2000 },
  goals: { label: "What you are working towards", maxLength: 1600 },
  interests: { label: "Your interests", maxLength: 1200 },
} as const;
const field = (key: PersonalProfileField) => z.string().trim().max(PERSONAL_PROFILE_FIELD_DETAILS[key].maxLength)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
export const personalProfileSchema = z.object({
  name: field("name"), role: field("role"), workingContext: field("workingContext"),
  preferences: field("preferences"), goals: field("goals"), interests: field("interests"),
}).strict();
export type PersonalProfile = z.infer<typeof personalProfileSchema>;
export const EMPTY_PERSONAL_PROFILE: Readonly<PersonalProfile> = Object.freeze({
  name: "", role: "", workingContext: "", preferences: "", goals: "", interests: "",
});
export const personalProfileSourceSchema = z.enum(["you", "conversation"]);
export type PersonalProfileSource = z.infer<typeof personalProfileSourceSchema>;
export const PERSONAL_PROFILE_SOURCE_LABELS = {
  you: "Provided by you", conversation: "Added from our conversation",
} as const;
const sourceSchema = z.object({
  source: personalProfileSourceSchema, label: z.enum(["Provided by you", "Added from our conversation"]),
  updatedAt: z.string().datetime(),
}).strict().refine(value => value.label === PERSONAL_PROFILE_SOURCE_LABELS[value.source]);
export const personalProfileFieldSourcesSchema = z.object({
  name: sourceSchema.optional(), role: sourceSchema.optional(), workingContext: sourceSchema.optional(),
  preferences: sourceSchema.optional(), goals: sourceSchema.optional(), interests: sourceSchema.optional(),
}).strict();
export type PersonalProfileFieldSources = z.infer<typeof personalProfileFieldSourcesSchema>;
export const personalProfileChangeSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  enabled: z.boolean(), profile: personalProfileSchema,
  source: personalProfileSourceSchema.default("you"),
}).strict();
export type PersonalProfileChange = z.infer<typeof personalProfileChangeSchema>;
export const personalProfileResponseSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(PERSONAL_PROFILE_CONTRACT),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), enabled: z.boolean(),
  profile: personalProfileSchema, fieldSources: personalProfileFieldSourcesSchema,
  updatedAt: z.string().datetime().nullable(),
}).strict();
export type PersonalProfileResponse = z.infer<typeof personalProfileResponseSchema>;
export const personalProfileRuntimeReceiptSchema = z.object({
  version: z.literal(1), state: z.enum(["included", "disabled", "empty", "excluded_by_scope", "unavailable"]),
  revision: z.number().int().nonnegative().nullable(),
  fields: z.array(z.enum(PERSONAL_PROFILE_FIELDS)), updatedAt: z.string().datetime().nullable(),
}).strict();
export type PersonalProfileRuntimeReceipt = z.infer<typeof personalProfileRuntimeReceiptSchema>;
