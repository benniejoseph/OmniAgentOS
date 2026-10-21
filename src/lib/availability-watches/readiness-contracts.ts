import { array, boolean, enum as enumSchema, literal, number, object, string, type infer as Infer } from "zod";
const count = number().int().nonnegative();
export const WatchReadinessSchema = object({
  schemaVersion:literal(1),sourceUrl:string().url(),method:string(),schedule:string(),
  checking:enumSchema(["scheduled","queued","stopped"]),notificationsEnabled:boolean(),
  alertPolicy:literal("Booking openings are time-sensitive: one alert bypasses Asael quiet hours, while notifications-off and device permissions still apply."),
  inbox:enumSchema(["ready","disabled"]),android:object({ eligible:count,needsUpdate:count,configured:boolean() }).strict(),
  browser:object({ eligible:count,configured:boolean(),queued:count,accepted:count,received:count,opened:count,failed:count }).strict(),
  limitations:array(string()).max(8),
}).strict();
export type WatchReadiness = Infer<typeof WatchReadinessSchema>;
