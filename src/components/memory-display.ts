export function retiredMemoryPlaceholder(title: string) { return /^\s*\[retired\]/i.test(title); }
export function displayMemoryTitle(title: string, updatedAt?: string) {
  const generated = /^Assistant inference from run\s+[a-f0-9]{8}(?:-[a-f0-9]{1,12}){0,4}(?:…|\.{3})?$/i.test(title.trim());
  if (!generated && !retiredMemoryPlaceholder(title)) return title;
  const date = updatedAt ? new Date(updatedAt) : undefined;
  const suffix = date && !Number.isNaN(date.getTime()) ? ` · ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}` : "";
  return `${generated ? "Assistant note" : "Retired memory"}${suffix}`;
}
export function memoryLabel(value: string) { const labels: Record<string, string> = { all: "All kinds", semantic: "Facts", episodic: "Experiences", procedural: "How-to", preference: "Preferences", commitment: "Commitments", decision: "Decisions", summary: "Summaries", working: "Recent context", user: "Personal", candidate: "Needs review", contradicted: "Conflicting", superseded: "Replaced" }; return labels[value] || startCase(value); }
export function startCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
export function relativeDate(value: string) { const milliseconds = Date.now() - new Date(value).getTime(); const days = Math.floor(milliseconds / 86_400_000); if (days < 1) return "Today"; if (days === 1) return "Yesterday"; if (days < 30) return `${days}d ago`; return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)); }
