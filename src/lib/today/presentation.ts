const formatterCache = new Map<string, Intl.DateTimeFormat>();
const timezoneCache = new Map<string, string>();

export function formatTodayTime(value: string, timezone: string) {
  const parts = dateTimeParts(value, timezone);
  return parts
    ? `${parts.hour}:${parts.minute} ${parts.dayPeriod}`
    : "Recently";
}

export function formatTodayDue(value: string, timezone: string) {
  const parts = dateTimeParts(value, timezone);
  return parts
    ? `${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`
    : "Unscheduled";
}

export function formatTodayRelative(value: string, asOf: number) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(asOf)) return "Recently";

  const minutes = Math.max(0, Math.round((asOf - timestamp) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;

  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function dateTimeParts(value: string, timezone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  const parts = formatter(timezone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const month = part("month");
  const day = part("day");
  const hour = part("hour");
  const minute = part("minute");
  const dayPeriod = part("dayPeriod");

  return month && day && hour && minute && dayPeriod
    ? { month, day, hour, minute, dayPeriod }
    : undefined;
}

function formatter(timezone: string) {
  const resolvedTimezone = validTimezone(timezone);
  const cached = formatterCache.get(resolvedTimezone);
  if (cached) return cached;

  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: resolvedTimezone,
    calendar: "gregory",
    numberingSystem: "latn",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  });
  formatterCache.set(resolvedTimezone, created);
  return created;
}

function validTimezone(value: string) {
  const candidate = value.trim();
  if (!candidate || candidate.length > 120) return "UTC";
  const cached = timezoneCache.get(candidate);
  if (cached) return cached;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    timezoneCache.set(candidate, candidate);
    return candidate;
  } catch {
    timezoneCache.set(candidate, "UTC");
    return "UTC";
  }
}
