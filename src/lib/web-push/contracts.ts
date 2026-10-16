import { z } from "zod";

// Only established browser push transports; no arbitrary URL is a send target.
export function isBrowserPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
      (url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com" ||
        url.hostname === "web.push.apple.com" || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname));
  } catch { return false; }
}
export const browserSubscriptionSchema = z.object({
  endpoint: z.string().min(1).max(4096).refine(isBrowserPushEndpoint),
  expirationTime: z.number().nonnegative().nullable().optional(),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,2}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/) }).strict(),
}).strict();
export const browserRegistrationSchema = z.object({ subscription: browserSubscriptionSchema }).strict();
export const browserReceiptSchema = z.object({ id: z.string().regex(/^web_delivery_[a-f0-9]{48}$/), kind: z.enum(["received", "opened"]) }).strict();
export const browserRegistrationIdSchema = z.string().regex(/^web_registration_[a-f0-9]{48}$/);
