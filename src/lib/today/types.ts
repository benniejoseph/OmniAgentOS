import type { TodaySectionKey } from "@/lib/today/sections";

export type TodayItemKind = "task" | "reminder";
export type TodayItemPriority = "low" | "medium" | "high";
export type TodayItemStatus = "open" | "done";

export type TodayItem = {
  id: string;
  tenantId: string;
  actorId: string;
  title: string;
  kind: TodayItemKind;
  priority: TodayItemPriority;
  status: TodayItemStatus;
  dueAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TodayLedger = {
  items: TodayItem[];
};

export type TodayPreferences = {
  tenantId: string;
  actorId: string;
  briefEnabled: boolean;
  briefTime: string;
  timezone: string;
  reminderLeadMinutes: number;
  notificationsEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  visibleSections: TodaySectionKey[];
  createdAt: string;
  updatedAt: string;
};

export type DailyBriefFocus = {
  title: string;
  reason: string;
};

export type DailyBriefResurfaced = {
  title: string;
  context: string;
};

export type DailyBrief = {
  id: string;
  tenantId: string;
  actorId: string;
  localDate: string;
  summary: string;
  focus: DailyBriefFocus[];
  watchouts: string[];
  resurfaced: DailyBriefResurfaced[];
  memoryIds: string[];
  generatedBy: "ai" | "system";
  model?: string;
  sourceCounts: {
    items: number;
    memories: number;
    threads: number;
    activeWork: number;
    projects: number;
  };
  generatedAt: string;
};

export type TodayBriefLedger = {
  preferences: TodayPreferences[];
  briefs: DailyBrief[];
};

export type PersonalNotificationStatus = "unread" | "read" | "snoozed" | "dismissed" | "acted";
export type PersonalNotificationUrgency = "due_soon" | "overdue";

type PersonalNotificationBase = {
  id: string;
  tenantId: string;
  actorId: string;
  title: string;
  sourceId: string;
  occurrenceKey: string;
  status: PersonalNotificationStatus;
  dueAt: string;
  snoozedUntil?: string;
  readAt?: string;
  createdAt: string;
  updatedAt: string;
};
export type PersonalNotification = PersonalNotificationBase & (
  | { kind: "reminder"; sourceType: "today_item"; urgency: PersonalNotificationUrgency }
  | { kind: "responsibility_change"; sourceType: "responsibility_change"; urgency: "update" }
);

export type PersonalNotificationLedger = {
  notifications: PersonalNotification[];
};
