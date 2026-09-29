export type SqlRow = Record<string, unknown>;

// Internal client shape — mirrors the methods used across the database client
// and by the functions that receive a `sql` argument
// (ensureTenantIsolationPolicies, ensureVectorSchema, etc.).
export type SqlClient = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
  readonly transactionScoped: boolean;
};

export type SchemaMigrationUp = (sql: SqlClient) => Promise<void>;
