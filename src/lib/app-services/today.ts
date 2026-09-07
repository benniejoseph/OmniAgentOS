import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import {
  generateDailyBrief,
  getTodayBriefBundle,
  updateTodayPreferences,
} from "@/lib/today/briefs";
import { invalidateTodaySnapshot } from "@/lib/today/snapshot-cache";
import { loadTodaySnapshot } from "@/lib/today/snapshot";
import { createTodayItem, updateTodayItem } from "@/lib/today/store";
import { TODAY_SECTION_KEYS } from "@/lib/today/sections";

const emptySchema = z.object({}).strict();
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const todayItemCreateServiceInputSchema = z.object({
  title: z.string().trim().min(1).max(280),
  kind: z.enum(["task", "reminder"]).default("task"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  dueAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const todayItemUpdateServiceInputSchema = z.object({
  itemId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(280).optional(),
  status: z.enum(["open", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine(({ itemId: _itemId, ...change }) => Object.keys(change).length > 0, {
  message: "A Today-item change is required.",
});

export const todayBriefGenerateServiceInputSchema = z.object({ force: z.boolean().default(false) }).strict();

export const todayPreferencesUpdateServiceInputSchema = z.object({
  briefEnabled: z.boolean().optional(), briefTime: timeSchema.optional(),
  timezone: z.string().trim().min(1).max(120).optional(),
  reminderLeadMinutes: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60), z.literal(120)]).optional(),
  notificationsEnabled: z.boolean().optional(), quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: timeSchema.optional(), quietHoursEnd: timeSchema.optional(),
  visibleSections: z.array(z.enum(TODAY_SECTION_KEYS)).min(1).max(TODAY_SECTION_KEYS.length).optional(),
}).strict().refine((change) => Object.keys(change).length > 0, { message: "A preference change is required." });

export async function showTodayService(caller: AppServiceCaller, input: z.input<typeof emptySchema>) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.today.show"));
  const snapshot = await loadTodaySnapshot(readOwner(caller));
  return completeAppServiceCall(authorized, snapshot);
}

export async function createTodayItemService(caller: AppServiceCaller, input: z.input<typeof todayItemCreateServiceInputSchema>) {
  const value = redactSensitive(todayItemCreateServiceInputSchema.parse(input)) as z.output<typeof todayItemCreateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.today.item.create"));
  const item = await createTodayItem({ ...exactOwner(caller), ...value });
  invalidateTodaySnapshot(caller.context);
  return completeAppServiceCall(authorized, { item });
}

export async function updateTodayItemService(caller: AppServiceCaller, input: z.input<typeof todayItemUpdateServiceInputSchema>) {
  const value = redactSensitive(todayItemUpdateServiceInputSchema.parse(input)) as z.output<typeof todayItemUpdateServiceInputSchema>;
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.today.item.update"));
  const { itemId, ...change } = value;
  const item = await updateTodayItem(itemId, change, readOwner(caller));
  if (item) invalidateTodaySnapshot(caller.context);
  return completeAppServiceCall(authorized, { item: item || null }, { resourceCount: item ? 1 : 0 });
}

export async function showTodayBriefService(caller: AppServiceCaller, input: z.input<typeof emptySchema>) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.today.brief.show"));
  const bundle = await getTodayBriefBundle(readOwner(caller));
  return completeAppServiceCall(authorized, bundle);
}

export async function generateTodayBriefService(caller: AppServiceCaller, input: z.input<typeof todayBriefGenerateServiceInputSchema>) {
  const value = todayBriefGenerateServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.today.brief.generate"));
  const brief = await generateDailyBrief({ ...readOwner(caller), force: value.force });
  invalidateTodaySnapshot(caller.context);
  return completeAppServiceCall(authorized, { brief });
}

export async function updateTodayPreferencesService(caller: AppServiceCaller, input: z.input<typeof todayPreferencesUpdateServiceInputSchema>) {
  const value = todayPreferencesUpdateServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.today.preferences.update"));
  const preferences = await updateTodayPreferences(value, readOwner(caller));
  invalidateTodaySnapshot(caller.context);
  return completeAppServiceCall(authorized, { preferences });
}

function exactOwner(caller: AppServiceCaller) {
  return { tenantId: caller.context.tenantId, actorId: caller.context.actorId };
}

function readOwner(caller: AppServiceCaller) {
  return { ...exactOwner(caller), requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context) };
}
