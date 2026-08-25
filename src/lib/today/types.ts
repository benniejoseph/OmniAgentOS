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

export type PersonalNotification = {
  id: string;
  tenantId: string;
  actorId: string;
  title: string;
  kind: "reminder";
  sourceType: "today_item";
  sourceId: string;
  occurrenceKey: string;
  urgency: PersonalNotificationUrgency;
  status: PersonalNotificationStatus;
  dueAt: string;
  snoozedUntil?: string;
  readAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PersonalNotificationLedger = {
  notifications: PersonalNotification[];
};
