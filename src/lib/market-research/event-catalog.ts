import { z } from "zod";

const highImpactEventDefinitionSchema = z.object({
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  name: z.string().min(1).max(160),
  fredReleaseId: z.number().int().positive(),
  sourceUrl: z.string().url(),
}).strict();

export type HighImpactEventDefinition = z.infer<
  typeof highImpactEventDefinitionSchema
>;

export const highImpactEventCatalog: readonly HighImpactEventDefinition[] =
  Object.freeze([
    event("us.retail_sales", "U.S. Retail Sales", 9),
    event("us.cpi", "U.S. Consumer Price Index", 10),
    event("us.ppi", "U.S. Producer Price Index", 46),
    event("us.employment_situation", "U.S. Employment Situation", 50),
    event("us.gdp", "U.S. Gross Domestic Product", 53),
    event("us.personal_income_outlays", "U.S. Personal Income and Outlays", 54),
    event("us.fomc", "Federal Open Market Committee Press Release", 101),
    event("us.jolts", "U.S. Job Openings and Labor Turnover Survey", 192),
  ]);

export function selectedHighImpactEvents(eventKeys?: readonly string[]) {
  if (!eventKeys?.length) return highImpactEventCatalog;
  const selected = new Set(eventKeys);
  const events = highImpactEventCatalog.filter(({ eventKey }) =>
    selected.has(eventKey)
  );
  if (events.length !== selected.size) {
    throw new Error("One or more requested high-impact event definitions are unavailable.");
  }
  return events;
}

function event(eventKey: string, name: string, fredReleaseId: number) {
  return highImpactEventDefinitionSchema.parse({
    eventKey,
    name,
    fredReleaseId,
    sourceUrl: `https://fred.stlouisfed.org/release?rid=${fredReleaseId}`,
  });
}
