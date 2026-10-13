import type { SqlRow } from "./sql-types";

/** Read-only promotion gate for the privileged read fence. The helper's owner
 * can lock authority rows; the serving role gains only this exact EXECUTE. */
export async function verifyResponsibilityWorkspaceFence(query: (text: string, params?: unknown[]) => Promise<SqlRow[]>) {
  const rows = await query(`SELECT
    procedure.prosecdef AND procedure.provolatile = 'v'
      AND procedure.prorettype = 'boolean'::regtype
      AND procedure.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND procedure.proowner = workspace.relowner
      AND procedure.proowner = membership.relowner
      AND procedure.proowner <> runtime.oid
      AND has_function_privilege(runtime.oid, procedure.oid, 'EXECUTE')
      AND NOT has_any_column_privilege(runtime.oid, workspace.oid, 'UPDATE')
      AND NOT has_any_column_privilege(runtime.oid, membership.oid, 'UPDATE')
      AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) privilege
        WHERE privilege.grantee NOT IN (procedure.proowner, runtime.oid)) AS valid
    FROM pg_proc procedure
    JOIN pg_class workspace ON workspace.oid = 'public.omni_tenant_workspaces'::regclass
    JOIN pg_class membership ON membership.oid = 'public.omni_tenant_workspace_memberships'::regclass
    JOIN pg_roles runtime ON runtime.rolname = 'omni_runtime'
    WHERE procedure.oid = to_regprocedure('public.omni_lock_responsibility_workspace_v1(text,text,text)')`);
  if (rows.length !== 1 || rows[0].valid !== true) throw new Error("Responsibility workspace read fence does not match this release.");
}
