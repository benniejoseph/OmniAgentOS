import type { SecurityContext } from "@/lib/security/types";
export const searchContext: SecurityContext = { tenantId: "search-tenant", actorId: "owner@example.test", role: "operator", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "search-session", tenantName: "Search" } };
export const searchTimestamp = "2026-10-04T00:00:00.123456Z";
export const searchThreadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
