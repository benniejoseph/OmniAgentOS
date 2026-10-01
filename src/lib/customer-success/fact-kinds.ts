// The account view in the browser needs only these names. They live apart
// from the account contracts, which hash with Node's crypto, so the page
// does not ship a polyfill for it.
export const CUSTOMER_FACT_KINDS = Object.freeze([
  "organization",
  "contact",
  "stakeholder",
  "product",
  "opportunity",
  "case",
  "usage",
  "project",
  "interaction",
  "health",
  "risk",
  "renewal",
] as const);

export type CustomerFactKind = (typeof CUSTOMER_FACT_KINDS)[number];
