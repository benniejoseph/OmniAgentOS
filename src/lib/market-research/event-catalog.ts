import { z } from "zod";

const highImpactEventDefinitionSchema = z.object({
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  name: z.string().min(1).max(160),
  fredReleaseId: z.number().int().positive(),
  sourceUrl: z.string().url(),
  blsSchedule: z.object({
    summary: z.string().min(1).max(160),
    sourceUrl: z.string().url(),
  }).strict().optional(),
}).strict();

export type HighImpactEventDefinition = z.infer<
  typeof highImpactEventDefinitionSchema
>;

export const highImpactEventCatalog: readonly HighImpactEventDefinition[] =
  Object.freeze([
    event("us.retail_sales", "U.S. Retail Sales", 9),
    event("us.cpi", "U.S. Consumer Price Index", 10, {
      summary: "Consumer Price Index",
      sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm",
    }),
    event("us.ppi", "U.S. Producer Price Index", 46, {
      summary: "Producer Price Index",
      sourceUrl: "https://www.bls.gov/schedule/news_release/ppi.htm",
    }),
    event("us.employment_situation", "U.S. Employment Situation", 50, {
      summary: "Employment Situation",
      sourceUrl: "https://www.bls.gov/schedule/news_release/empsit.htm",
    }),
    event("us.gdp", "U.S. Gross Domestic Product", 53),
    event("us.personal_income_outlays", "U.S. Personal Income and Outlays", 54),
    event("us.fomc", "Federal Open Market Committee Press Release", 101),
    event("us.jolts", "U.S. Job Openings and Labor Turnover Survey", 192, {
      summary: "Job Openings and Labor Turnover Survey",
      sourceUrl: "https://www.bls.gov/schedule/news_release/jolts.htm",
    }),
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

function event(
  eventKey: string,
  name: string,
  fredReleaseId: number,
  blsSchedule?: { summary: string; sourceUrl: string },
) {
  return highImpactEventDefinitionSchema.parse({
    eventKey,
    name,
    fredReleaseId,
    sourceUrl: `https://fred.stlouisfed.org/release?rid=${fredReleaseId}`,
    ...(blsSchedule ? { blsSchedule } : {}),
  });
}
