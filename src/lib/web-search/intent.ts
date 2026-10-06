// Pure query policy shared by prompts and the live search runtime.
// Keep provider, configuration and storage imports out of this module.
const freshnessPattern = /\b(today|tonight|yesterday|tomorrow|now|current|currently|latest|newest|recent|recently|breaking|live|real[-\s]?time|up[-\s]?to[-\s]?date|as of|this week|this month|this year|released|launch(?:ed)?|announc(?:ed|ement)|available|availability|support(?:s|ed|ing)?|compatible|price|pricing|stock|market|weather|score|schedule|deadline|version|changelog|news|president|prime minister|ceo|law|laws|regulation|policy|recommend(?:ation|ed)?|best|model|api|library|package|travel|flight|restaurant|web search|search (?:the )?web|browse|look up|verify|multiple sources|sources|citations?)\b/i;
const noWebPattern = /\b(do not|don['’]?t|without|no)\s+(?:use\s+)?(?:the\s+)?(?:web|internet|browser|search|live search|(?:any\s+)?external tools?|any tools?)\b|\b(?:do not|don['’]?t)\s+(?:browse|search)\s+(?:the\s+)?(?:web|internet)\b|\bwithout\s+(?:browsing|searching)\s+(?:the\s+)?(?:web|internet)\b|\bfrom memory only\b|\boffline\b/i;

export function isLiveWebSearchExplicitlyDisabled(query: string) {
  return noWebPattern.test(query.trim());
}

export function shouldUseLiveWebSearch(query: string) {
  const normalized = query.trim();
  if (!normalized || isLiveWebSearchExplicitlyDisabled(normalized)) {
    return false;
  }

  return freshnessPattern.test(normalized);
}

