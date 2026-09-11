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
  fredSeries: z.array(z.object({
    metricKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
    seriesId: z.string().regex(/^[A-Z0-9]+$/),
    label: z.string().min(1).max(160),
    unit: z.enum(["index", "percent", "thousands", "millions", "billions"]),
  }).strict()).max(4).default([]),
}).strict();

export type HighImpactEventDefinition = z.infer<
  typeof highImpactEventDefinitionSchema
>;

export const highImpactEventCatalog: readonly HighImpactEventDefinition[] =
  Object.freeze([
    event("us.retail_sales", "U.S. Retail Sales", 9, undefined, [
      series("retail_sales", "RSAFS", "Retail and food services sales", "millions"),
    ]),
    event("us.cpi", "U.S. Consumer Price Index", 10, {
      summary: "Consumer Price Index",
      sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm",
    }, [series("cpi_index", "CPIAUCSL", "Consumer Price Index", "index")]),
    event("us.ppi", "U.S. Producer Price Index", 46, {
      summary: "Producer Price Index",
      sourceUrl: "https://www.bls.gov/schedule/news_release/ppi.htm",
    }, [series("ppi_final_demand", "PPIFIS", "Producer Price Index: final demand", "index")]),
    event("us.employment_situation", "U.S. Employment Situation", 50, {
      summary: "Employment Situation",
      sourceUrl: "https://www.bls.gov/schedule/news_release/empsit.htm",
    }, [
      series("nonfarm_payrolls", "PAYEMS", "Total nonfarm payrolls", "thousands"),
      series("unemployment_rate", "UNRATE", "Unemployment rate", "percent"),
    ]),
    event("us.gdp", "U.S. Gross Domestic Product", 53, undefined, [
      series("real_gdp_growth", "A191RL1Q225SBEA", "Real GDP annualized growth", "percent"),
    ]),
    event("us.personal_income_outlays", "U.S. Personal Income and Outlays", 54, undefined, [
      series("personal_income", "PI", "Personal income", "billions"),
      series("personal_consumption", "PCE", "Personal consumption expenditures", "billions"),
    ]),
    event("us.fomc", "Federal Open Market Committee Press Release", 101),
    event("us.jolts", "U.S. Job Openings and Labor Turnover Survey", 192, {
      summary: "Job Openings and Labor Turnover Survey",
      sourceUrl: "https://www.bls.gov/schedule/news_release/jolts.htm",
    }, [series("job_openings", "JTSJOL", "Job openings", "thousands")]),
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
  fredSeries: HighImpactEventDefinition["fredSeries"] = [],
) {
  return highImpactEventDefinitionSchema.parse({
    eventKey,
    name,
    fredReleaseId,
    sourceUrl: `https://fred.stlouisfed.org/release?rid=${fredReleaseId}`,
    ...(blsSchedule ? { blsSchedule } : {}),
    fredSeries,
  });
}

function series(
  metricKey: string,
  seriesId: string,
  label: string,
  unit: HighImpactEventDefinition["fredSeries"][number]["unit"],
) {
  return { metricKey, seriesId, label, unit };
}
