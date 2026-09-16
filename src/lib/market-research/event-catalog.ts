import { z } from "zod";

const highImpactEventDefinitionSchema = z.object({
  eventKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  name: z.string().min(1).max(160),
  category: z.enum(["inflation", "labor", "monetary_policy", "growth", "consumption", "housing", "trade"]),
  components: z.array(z.string().min(1).max(100)).min(1).max(8),
  aliases: z.array(z.string().min(1).max(100)).max(10),
  scheduleCoverage: z.enum(["official_exact", "date_only_until_verified"]),
  historyCoverage: z.enum(["fred_release_dates", "publisher_schedule_only"]),
  whyItMatters: z.string().min(1).max(360),
  fredReleaseId: z.number().int().positive().optional(),
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

export type HighImpactEventDefinition = z.infer<typeof highImpactEventDefinitionSchema>;

export const highImpactEventCatalog: readonly HighImpactEventDefinition[] = Object.freeze([
  event({
    eventKey: "us.cpi", name: "U.S. Consumer Price Index", category: "inflation",
    components: ["Headline CPI", "Core CPI"], aliases: ["CPI", "Core CPI", "Consumer inflation"],
    scheduleCoverage: "official_exact",
    whyItMatters: "Inflation surprise changes the expected policy path, real yields, the dollar, and rate-sensitive equity valuations.",
    fredReleaseId: 10,
    blsSchedule: { summary: "Consumer Price Index", sourceUrl: "https://www.bls.gov/schedule/news_release/cpi.htm" },
    fredSeries: [
      series("cpi_index", "CPIAUCSL", "Consumer Price Index", "index"),
      series("core_cpi_index", "CPILFESL", "Core Consumer Price Index", "index"),
    ],
  }),
  event({
    eventKey: "us.ppi", name: "U.S. Producer Price Index", category: "inflation",
    components: ["Headline PPI", "Core/final-demand detail"], aliases: ["PPI", "Producer inflation"],
    scheduleCoverage: "official_exact",
    whyItMatters: "Upstream price pressure can alter inflation and policy expectations before it reaches consumer prices.",
    fredReleaseId: 46,
    blsSchedule: { summary: "Producer Price Index", sourceUrl: "https://www.bls.gov/schedule/news_release/ppi.htm" },
    fredSeries: [series("ppi_final_demand", "PPIFIS", "Producer Price Index: final demand", "index")],
  }),
  event({
    eventKey: "us.employment_situation", name: "U.S. Employment Situation", category: "labor",
    components: ["Nonfarm payrolls", "Unemployment rate", "Average hourly earnings", "Participation"],
    aliases: ["NFP", "Nonfarm payrolls", "Non-farm employment", "Unemployment"],
    scheduleCoverage: "official_exact",
    whyItMatters: "Payroll growth, unemployment, participation, wages, and revisions jointly shape growth and Federal Reserve expectations.",
    fredReleaseId: 50,
    blsSchedule: { summary: "Employment Situation", sourceUrl: "https://www.bls.gov/schedule/news_release/empsit.htm" },
    fredSeries: [
      series("nonfarm_payrolls", "PAYEMS", "Total nonfarm payrolls", "thousands"),
      series("unemployment_rate", "UNRATE", "Unemployment rate", "percent"),
      series("average_hourly_earnings", "CES0500000003", "Average hourly earnings", "index"),
      series("labor_force_participation", "CIVPART", "Labor-force participation", "percent"),
    ],
  }),
  event({
    eventKey: "us.fomc", name: "Federal Open Market Committee Decision", category: "monetary_policy",
    components: ["Rate decision", "Statement", "Economic projections", "Press conference"],
    aliases: ["FOMC", "Fed decision", "Powell press conference", "Dot plot"],
    scheduleCoverage: "official_exact",
    whyItMatters: "The decision, statement, projections, and press conference can reprice the expected rate path in separate waves.",
    fredReleaseId: 101,
  }),
  event({
    eventKey: "us.personal_income_outlays", name: "U.S. Personal Income and Outlays", category: "inflation",
    components: ["Core PCE", "Headline PCE", "Personal income", "Consumer spending"],
    aliases: ["Core PCE", "PCE inflation", "Personal spending"], scheduleCoverage: "official_exact",
    whyItMatters: "Core PCE is a central inflation input while income and spending show demand resilience.",
    fredReleaseId: 54,
    fredSeries: [
      series("core_pce_index", "PCEPILFE", "Core PCE price index", "index"),
      series("pce_price_index", "PCEPI", "PCE price index", "index"),
      series("personal_income", "PI", "Personal income", "billions"),
      series("personal_consumption", "PCE", "Personal consumption expenditures", "billions"),
    ],
  }),
  event({
    eventKey: "us.retail_sales", name: "U.S. Retail Sales", category: "consumption",
    components: ["Headline retail sales", "Control group", "Ex-autos"], aliases: ["Retail sales", "Core retail sales"],
    scheduleCoverage: "official_exact",
    whyItMatters: "Consumption strength changes growth, earnings, inflation, and policy-path expectations.",
    fredReleaseId: 9,
    fredSeries: [series("retail_sales", "RSAFS", "Retail and food services sales", "millions")],
  }),
  event({
    eventKey: "us.gdp", name: "U.S. Gross Domestic Product", category: "growth",
    components: ["Real GDP", "Price index", "Consumption", "Revisions"], aliases: ["GDP", "Advance GDP"],
    scheduleCoverage: "official_exact", whyItMatters: "Growth and price composition can change recession, earnings, and policy expectations.",
    fredReleaseId: 53,
    fredSeries: [series("real_gdp_growth", "A191RL1Q225SBEA", "Real GDP annualized growth", "percent")],
  }),
  event({
    eventKey: "us.jolts", name: "U.S. Job Openings and Labor Turnover Survey", category: "labor",
    components: ["Job openings", "Quits", "Hires"], aliases: ["JOLTS", "Job openings"],
    scheduleCoverage: "official_exact",
    whyItMatters: "Labor demand and worker mobility help explain wage pressure beyond the monthly payroll report.",
    fredReleaseId: 192,
    blsSchedule: { summary: "Job Openings and Labor Turnover Survey", sourceUrl: "https://www.bls.gov/schedule/news_release/jolts.htm" },
    fredSeries: [series("job_openings", "JTSJOL", "Job openings", "thousands")],
  }),
  event({
    eventKey: "us.employment_cost_index", name: "U.S. Employment Cost Index", category: "labor",
    components: ["Total compensation", "Wages and salaries"], aliases: ["ECI", "Employment costs"],
    scheduleCoverage: "official_exact", whyItMatters: "Broad compensation growth is a slower-moving measure of domestic wage pressure.",
    fredReleaseId: 11,
    blsSchedule: { summary: "Employment Cost Index", sourceUrl: "https://www.bls.gov/schedule/news_release/eci.htm" },
    fredSeries: [series("employment_cost_index", "ECIALLCIV", "Employment Cost Index: total compensation", "index")],
  }),
  event({
    eventKey: "us.productivity_costs", name: "U.S. Productivity and Costs", category: "labor",
    components: ["Nonfarm productivity", "Unit labor costs"], aliases: ["Productivity", "Unit labor costs"],
    scheduleCoverage: "official_exact", whyItMatters: "Productivity and labor-cost growth influence margins and the inflationary meaning of wage gains.",
    fredReleaseId: 47,
    blsSchedule: { summary: "Productivity and Costs", sourceUrl: "https://www.bls.gov/schedule/news_release/prod2.htm" },
    fredSeries: [
      series("nonfarm_productivity", "OPHNFB", "Nonfarm business productivity", "index"),
      series("unit_labor_costs", "ULCNFB", "Nonfarm business unit labor costs", "index"),
    ],
  }),
  event({
    eventKey: "us.import_export_prices", name: "U.S. Import and Export Price Indexes", category: "inflation",
    components: ["Import prices", "Export prices", "Import prices ex-fuel"], aliases: ["Import prices", "Export prices"],
    scheduleCoverage: "official_exact", whyItMatters: "Traded-goods prices expose imported inflation and currency-sensitive price pressure.",
    fredReleaseId: 188,
    blsSchedule: { summary: "U.S. Import and Export Price Indexes", sourceUrl: "https://www.bls.gov/schedule/news_release/ximpim.htm" },
  }),
  event({
    eventKey: "us.trade_balance", name: "U.S. International Trade in Goods and Services", category: "trade",
    components: ["Goods and services balance", "Exports", "Imports"], aliases: ["Trade balance", "International trade"],
    scheduleCoverage: "official_exact", whyItMatters: "Trade flows affect GDP tracking and can alter growth and currency narratives.",
    fredReleaseId: 51,
    fredSeries: [series("trade_balance", "BOPGSTB", "Trade balance: goods and services", "millions")],
  }),
  event({
    eventKey: "us.durable_goods", name: "U.S. Durable Goods Orders", category: "growth",
    components: ["Durable goods orders", "Core capital goods", "Shipments", "Revisions"],
    aliases: ["Durable goods", "Core durable goods", "M3", "Factory orders"],
    scheduleCoverage: "official_exact",
    whyItMatters: "Orders and core capital-goods demand are forward-looking signals for manufacturing, investment, and growth.",
    fredReleaseId: 95,
    fredSeries: [series("durable_goods_orders", "DGORDER", "Manufacturers' new orders: durable goods", "millions")],
  }),
  event({
    eventKey: "us.housing_starts", name: "U.S. New Residential Construction", category: "housing",
    components: ["Housing starts", "Building permits"], aliases: ["Housing starts", "Building permits"],
    scheduleCoverage: "official_exact", whyItMatters: "Construction and permits are rate-sensitive leading indicators of domestic demand.",
    fredReleaseId: 27,
    fredSeries: [
      series("housing_starts", "HOUST", "Housing starts", "thousands"),
      series("building_permits", "PERMIT", "Building permits", "thousands"),
    ],
  }),
  event({
    eventKey: "us.new_home_sales", name: "U.S. New Residential Sales", category: "housing",
    components: ["New-home sales", "Inventory", "Revisions"], aliases: ["New home sales"],
    scheduleCoverage: "official_exact", whyItMatters: "New-home demand is highly rate-sensitive and often carries material revisions.",
    fredReleaseId: 97,
    fredSeries: [series("new_home_sales", "HSN1F", "New one-family houses sold", "thousands")],
  }),
  event({
    eventKey: "us.initial_jobless_claims", name: "U.S. Initial Jobless Claims", category: "labor",
    components: ["Initial claims", "Continuing claims", "Four-week average"],
    aliases: ["Jobless claims", "Initial claims", "Unemployment claims"], scheduleCoverage: "date_only_until_verified",
    whyItMatters: "Weekly claims can reveal labor turning points between monthly employment reports.", fredReleaseId: 180,
  }),
  event({
    eventKey: "us.industrial_production", name: "U.S. Industrial Production and Capacity Utilization", category: "growth",
    components: ["Industrial production", "Capacity utilization"], aliases: ["Industrial production", "Capacity utilization"],
    scheduleCoverage: "date_only_until_verified", whyItMatters: "Factory output and utilization inform cyclical growth, margins, and price pressure.",
    fredReleaseId: 13,
    fredSeries: [
      series("industrial_production", "INDPRO", "Industrial production", "index"),
      series("capacity_utilization", "TCU", "Capacity utilization", "percent"),
    ],
  }),
  event({
    eventKey: "us.ism_manufacturing", name: "U.S. Manufacturing ISM Report on Business", category: "growth",
    components: ["Manufacturing PMI", "New orders", "Prices", "Employment"], aliases: ["ISM manufacturing", "Manufacturing PMI"],
    scheduleCoverage: "date_only_until_verified",
    whyItMatters: "Survey breadth, new orders, prices, and employment can shift the near-term growth and inflation narrative.",
    sourceUrl: "https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/",
  }),
]);

export function selectedHighImpactEvents(eventKeys?: readonly string[]) {
  if (!eventKeys?.length) return highImpactEventCatalog;
  const selected = new Set(eventKeys);
  const events = highImpactEventCatalog.filter(({ eventKey }) => selected.has(eventKey));
  if (events.length !== selected.size) {
    throw new Error("One or more requested high-impact event definitions are unavailable.");
  }
  return events;
}

function event(
  definition: Omit<HighImpactEventDefinition, "sourceUrl" | "fredSeries" | "historyCoverage"> & {
    sourceUrl?: string;
    fredSeries?: HighImpactEventDefinition["fredSeries"];
  },
) {
  return highImpactEventDefinitionSchema.parse({
    ...definition,
    historyCoverage: definition.fredReleaseId
      ? "fred_release_dates"
      : "publisher_schedule_only",
    sourceUrl: definition.sourceUrl ||
      `https://fred.stlouisfed.org/release?rid=${definition.fredReleaseId}`,
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
