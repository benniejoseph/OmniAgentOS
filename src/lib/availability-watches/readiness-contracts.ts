import { z } from "zod";
const count = z.number().int().nonnegative();
export const WatchReadinessSchema = z.object({
  schemaVersion:z.literal(1),sourceUrl:z.string().url(),method:z.string(),schedule:z.string(),
  checking:z.enum(["scheduled","queued","stopped"]),notificationsEnabled:z.boolean(),
  alertPolicy:z.literal("Booking openings are time-sensitive: one alert bypasses Asael quiet hours, while notifications-off and device permissions still apply."),
  inbox:z.enum(["ready","disabled"]),android:z.object({ eligible:count,needsUpdate:count,configured:z.boolean() }).strict(),
  browser:z.object({ eligible:count,configured:z.boolean(),queued:count,accepted:count,received:count,opened:count,failed:count }).strict(),
  limitations:z.array(z.string()).max(8),
}).strict();
export type WatchReadiness = z.infer<typeof WatchReadinessSchema>;
