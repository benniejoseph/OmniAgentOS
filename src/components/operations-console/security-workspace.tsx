"use client";

import { useState } from "react";
import { ArrowRight, Check, Database, History, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { at, parseRbacRules, record, retentionKeys, rows, text } from "./operational-contracts";
import { ActionForm, DataRows, DataSection, Facts, OperationalFrame, RecordHeading, ReleaseEvidence, ScopedOperationalWorkspace, styles, useOperationalWorkspace, type Endpoint, type Resource } from "./operational-view";
import security from "./security-workspace.module.css";

const endpoints: readonly Endpoint[] = [
  { key: "context", label: "Your access", path: "/api/security/context", permission: "read", coverage: "The permissions reported for your signed-in account." },
  { key: "audits", label: "Recent decisions", path: "/api/security/audits?limit=24", permission: "read.security", coverage: "The latest 24 recorded access decisions in your workspace." },
  { key: "isolation", label: "Data protection", path: "/api/security/isolation-report", permission: "read.security", coverage: "Checks of known database protection policies, not every application path." },
  { key: "retention", label: "Data retention", path: "/api/security/retention", permission: "read.security", coverage: "Configured retention periods, not a record of completed cleanup." },
  { key: "release", label: "Technical release evidence", path: "/api/release/evidence", permission: "read.security", coverage: "The latest available release assessment, which may be cached." },
];
const permissions: Record<string, string> = {
  read: "View your workspace", "write.memory": "Save memories and documents", "execute.tool": "Use connected tools",
  "manage.connector": "Manage connections", "run.agent": "Ask your agents to work", "manage.workflow": "Manage repeatable work",
  "run.evaluation": "Run quality checks", "read.security": "Review security decisions", "read.identity": "View accounts and sessions",
  "manage.own_device": "Manage your devices", "manage.own_preferences": "Change your preferences", "manage.identity": "Manage workspace access",
  "manage.storage": "Manage data storage", "manage.security": "Maintain the platform",
};
const retentionLabels: Record<typeof retentionKeys[number], string> = {
  pendingApprovalDays: "Pending approvals", pendingAccessRequestDays: "Pending access requests", reviewedAccessRequestDays: "Reviewed access requests",
  episodeMemoryDays: "Conversation memories", consolidatedMemoryDays: "Consolidated memories", retrievalTraceDays: "Memory lookup history",
  workflowDays: "Workflow history", triggerEventDays: "Automation triggers", operationJobDays: "Background jobs", runContentDays: "Assistant conversations",
  toolPayloadDays: "Tool inputs and outputs", aiUsageDays: "AI usage records", domainEventDays: "Workspace history", observabilityDays: "Diagnostic logs",
  healthHistoryDays: "System health history", evaluationHistoryDays: "Quality check history", graphBuildHistoryDays: "Knowledge map updates", securityAuditDays: "Security decisions",
};
const sections = [
  { id: "access", label: "Your access", icon: KeyRound },
  { id: "data", label: "Your data", icon: Database },
  { id: "decisions", label: "Recent decisions", icon: History },
] as const;
type Section = typeof sections[number]["id"];
function readable(value: unknown) {
  const label = text(value, "Not reported").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function dateLabel(value: unknown) {
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Time unavailable";
}
function sourceLabel(source?: Resource) {
  return source?.restricted ? "Access restricted" : source?.error ? "Could not refresh" : source?.loading ? "Checking…" : source?.data ? "Available" : "Not available";
}
export function SecurityWorkspace() { return <ScopedOperationalWorkspace><SecurityView /></ScopedOperationalWorkspace>; }
function SecurityView() {
  const api = useOperationalWorkspace(endpoints);
  const [section, setSection] = useState<Section>("access");
  const [deniedOnly, setDeniedOnly] = useState(false);
  const context = api.resources.context, retention = api.resources.retention, isolationSource = api.resources.isolation;
  const isolation = record(isolationSource?.data?.report);
  const role = text(at(context?.data, "context.role"), "");
  const roleRules = context?.data ? parseRbacRules(at(context.data, "policy.rbacRules")) : [];
  const myRules = roleRules.filter((rule) => rule.roles.some((entry) => entry === role));
  const audits = rows(api.resources.audits?.data?.records), denied = audits.filter((item) => item.decision === "deny");
  const exportReason = api.blocked("read.security");
  const protection = isolationSource?.data && !isolationSource.error && !isolationSource.loading
    ? isolation.status === "passing" ? "Policy checks pass" : isolation.status === "not_configured" ? "Not configured" : "Needs review"
    : sourceLabel(isolationSource);
  return <OperationalFrame title="Security" description="Understand what Asael can do, how your data is kept, and which requests were allowed or blocked." api={api}>
    <div className={security.overview}>
      <div className={security.intro}><ShieldCheck size={30} strokeWidth={1.5} aria-hidden="true" /><div><h2>Your workspace, under your control</h2><p>Start with your access. Open a decision or a data policy when you need the detail.</p></div></div>
      <div className={security.glance}>
        <div><span>Your role</span><strong>{role ? role === "admin" ? "Administrator" : readable(role) : sourceLabel(context)}</strong></div>
        <div><span>Data protection</span><strong>{protection}</strong><small>Known storage policies</small></div>
        <div><span>Recent blocked requests</span><strong>{api.resources.audits?.data && !api.resources.audits.error ? denied.length : sourceLabel(api.resources.audits)}</strong><small>In the latest 24 decisions</small></div>
      </div>
    </div>
    <nav className={security.tabs} aria-label="Security sections">{sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)}><Icon size={17} aria-hidden="true" />{label}</button>)}</nav>
    <div key={section} className={security.sectionBody}>
      {section === "access" ? <DataSection title="What you can do" source={context} description="These permissions belong to your current role. Individual actions still follow their approval rules.">
        <ul className={security.permissions}>{myRules.map((rule) => <li key={rule.action}><Check size={17} aria-hidden="true" /><span>{permissions[rule.action] || readable(rule.action)}</span></li>)}</ul>
        {!myRules.length ? <p className={styles.empty}>No permissions were reported for this role.</p> : null}
        <Link className={security.nextLink} href="/app/automation">Review connected tools in Capabilities <ArrowRight size={16} /></Link>
        <details className={security.technical}><summary>Account and permission details</summary><Facts values={[["Workspace", at(context?.data, "context.tenantId")], ["Account reference", at(context?.data, "context.actorId")], ["Role", role]]} /><ul className={styles.rows}>{roleRules.map((rule) => <li key={rule.action}><RecordHeading title={permissions[rule.action] || readable(rule.action)} /><p>{rule.description}</p><Facts values={[["Permission", rule.action], ["Allowed roles", rule.roles]]} /></li>)}</ul></details>
      </DataSection> : null}
      {section === "data" ? <div className={security.dataGrid}>
        <DataSection title="How long data is kept" source={retention} description="These are the configured retention periods. They do not confirm that a cleanup has finished.">
          <p className={security.policyNote}>Automatic cleanup is {retention?.data?.automaticSweep === true ? "configured" : "not configured"}. Task records linked to protected execution evidence may be retained beyond these periods. You can delete individual memories from Memory.</p>
          <dl className={security.retention}>{retentionKeys.map((key) => <div key={key}><dt>{retentionLabels[key]}</dt><dd>{text(at(retention?.data, `policy.${key}`))} days</dd></div>)}</dl>
          <Link className={security.nextLink} href="/app/memory">Manage your memories <ArrowRight size={16} /></Link>
        </DataSection>
        <DataSection title="Workspace data protection" source={isolationSource} description="Asael checks whether known database tables enforce workspace boundaries.">
          <p className={security.assessment}>{protection}</p><p className={styles.support}>Last checked {dateLabel(isolation.checkedAt)}. This covers known storage policies, not every route through the app.</p>
          {Array.isArray(isolation.recommendations) && isolation.recommendations.length ? <ul className={security.recommendations}>{isolation.recommendations.map((item, index) => <li key={index}>{text(item)}</li>)}</ul> : null}
          <details className={security.technical}><summary>Technical protection details</summary><Facts values={[["Storage", isolation.storageBackend], ["Expected tables", at(isolation, "summary.expectedTables")], ["Protected tables", at(isolation, "summary.protectedTables")], ["Tables needing review", at(isolation, "summary.failingTables")]]} /><DataRows items={rows(isolation.tables)} empty="No table evidence was returned." render={(table) => <><RecordHeading title={table.tableName} status={table.status} /><Facts values={[["Category", table.category], ["Row security enabled", table.rlsEnabled], ["Row security enforced", table.forceRls], ["Policy present", table.policyPresent]]} /></>} /></details>
        </DataSection>
      </div> : null}
      {section === "decisions" ? <DataSection title="Recent access decisions" source={api.resources.audits} description="A blocked request means a rule prevented that action. It does not, by itself, mean someone broke into your account.">
        <label className={security.filter}><input type="checkbox" checked={deniedOnly} onChange={(event) => setDeniedOnly(event.target.checked)} />Only blocked requests</label>
        <ul className={security.decisions}>{(deniedOnly ? denied : audits).map((item, index) => <li key={text(item.id, String(index))}><details><summary><span className={security.decisionDot} data-blocked={item.decision === "deny"} /><span className={security.decisionTitle}><strong>{permissions[text(item.action)] || readable(item.action)}</strong><small>{dateLabel(item.createdAt)}</small></span><span className={security.decisionStatus}>{item.decision === "allow" ? "Allowed" : item.decision === "deny" ? "Blocked" : readable(item.decision)}</span></summary><div className={security.decisionDetail}>{item.reason ? <p>{text(item.reason)}</p> : null}<Facts values={[["Role", readable(item.actorRole)], ["Area", readable(item.resourceType)]]} /><details><summary>Technical reference</summary><Facts values={[["Decision reference", item.id], ["Account reference", item.actorId], ["Resource reference", item.resourceId], ["Action", item.action], ["Risk level", item.riskLevel]]} /></details></div></details></li>)}</ul>
        {!(deniedOnly ? denied : audits).length ? <p className={styles.empty}>{deniedOnly ? "No blocked requests in these recent decisions." : "No recent decisions to show."}</p> : null}
      </DataSection> : null}
    </div>
    <details className={security.advanced}><summary>Advanced security tools</summary><p className={styles.support}>Technical evidence and maintenance for investigating a problem.</p><div className={security.advancedGrid}>
      <section className={styles.actionPanel}><h2>Download security history</h2><p>Export signed records for an independent review. The download itself does not verify the signature.</p>{exportReason ? <><button type="button" className={styles.button} disabled>Download signed history</button><p>{exportReason}</p></> : <a className={styles.button} href="/api/security/audits/export" download>Download signed history</a>}</section>
      <ActionForm kind="retention" api={api} description="Delete expired data according to the current retention policy. This cannot be undone from this page." disabledReason={!retention?.data || retention.error || retention.loading ? "Refresh the data policy before reviewing cleanup." : undefined} target={() => retention?.data ? { ...retention.data, receivedAt: retention.receivedAt } : undefined} preview={<p>The server applies its policy when cleanup runs. This review does not provide a deletion count or lock the policy. Repeating an unconfirmed request may delete additional eligible records.</p>} />
      <div className={security.release}><ReleaseEvidence source={api.resources.release} /></div>
    </div></details>
  </OperationalFrame>;
}
