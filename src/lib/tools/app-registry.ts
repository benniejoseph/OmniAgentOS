import type { ToolDefinition } from "@/lib/tools/types";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";

export const FIRST_PARTY_APP_TOOLS = Object.freeze([
  readTool("app.workspaces.summary", "Workspace summary", "Read the current tenant workspace summary, including recent runs, workflows, and permitted approval items.", objectSchema({
    limit: integer(1, 50, 16),
    approvalLimit: integer(1, 25, 12),
  })),
  readTool("app.workspaces.readiness", "Workspace readiness", "Read the authenticated tenant workspace readiness checks.", objectSchema({})),
  readTool("app.sources.coverage.show", "Show source coverage", "Read connected knowledge domains, bounded backfill completeness, last verified freshness, and explicit source blind spots without inferring absence as a negative fact.", objectSchema({
    workspaceId: opaqueId("Optional exact workspace ID for Workspace-scoped integrations."),
  })),
  readTool("app.market_research.overview.show", "Show market research desk", "Read canonical instruments, provider readiness, Meridian's configurable model route, engine state, and research guardrails.", objectSchema({})),
  readTool("app.market_research.bars.list", "Load immutable market bars", "Load or reuse an actor-private, provider-labelled immutable bar snapshot for one canonical research instrument.", requiredObjectSchema({
    instrumentId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$", minLength: 3, maxLength: 120 },
    interval: { type: "string", enum: ["5min", "15min", "1h"] },
    outputSize: integer(100, 1_000, 480),
  }, ["instrumentId"])),
  readTool("app.market_research.features.show", "Show market technical features", "Run frozen ICT + Quarterly geometry and explicitly review-gated setup candidates against one exact caller-owned immutable market snapshot. The result is digest-bound and makes no transcript-authority claim.", requiredObjectSchema({
    snapshotId: { type: "string", pattern: "^market_snapshot_[a-f0-9]{48}$", maxLength: 64 },
  }, ["snapshotId"])),
  readTool("app.market_research.analysis.list", "List saved market analyses", "Read the caller's immutable saved chart-analysis versions and private manual-drawing state for one canonical instrument and interval.", requiredObjectSchema({
    instrumentId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$", minLength: 3, maxLength: 120 },
    interval: { type: "string", enum: ["5min", "15min", "1h"] },
    limit: integer(1, 40, 10),
  }, ["instrumentId", "interval"])),
  mutationTool("app.market_research.analysis.generate", "Generate and save market drawings", "Run the versioned deterministic ICT + Quarterly engine against one exact snapshot and save renderer-neutral drawing annotations. Candidate concepts remain explicitly review-gated and no trade is placed.", requiredObjectSchema({
    snapshotId: { type: "string", pattern: "^market_snapshot_[a-f0-9]{48}$", maxLength: 64 },
    visibleLayerIds: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", enum: ["liquidity", "imbalances", "blocks", "setups", "sessions", "quarterly", "structure", "gaps"] } },
  }, ["snapshotId"]), { reversible: false }),
  readTool("app.market_research.backtests.list", "List market backtests", "Read the caller's immutable, leakage-checked, hypothetical market backtest results for one exact canonical instrument.", requiredObjectSchema({
    instrumentId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$", minLength: 3, maxLength: 120 },
    limit: integer(1, 100, 20),
  }, ["instrumentId"])),
  mutationTool("app.market_research.backtests.run", "Run deterministic market backtest", "Queue a reproducible actor-private backtest against one exact immutable snapshot. The frozen foundation strategy enters only on the next bar, applies explicit costs, and never places a trade.", requiredObjectSchema({
    snapshotId: { type: "string", pattern: "^market_snapshot_[a-f0-9]{48}$", maxLength: 64 },
    strategy: objectSchema({
      strategyId: { type: "string", enum: ["foundation.liquidity_sweep_reversal.v1"] },
      direction: { type: "string", enum: ["both", "long_only", "short_only"], default: "both" },
      session: { type: "string", enum: ["all", "london", "new_york_am"], default: "all" },
      rewardRiskRatio: { type: "number", minimum: 0.5, maximum: 5, default: 2 },
      maxHoldingBars: integer(1, 96, 24),
      stopBufferRangeMultiplier: { type: "number", minimum: 0, maximum: 1, default: 0.1 },
    }),
    costs: objectSchema({
      spreadBps: { type: "number", minimum: 0, maximum: 100, default: 2 },
      slippageBps: { type: "number", minimum: 0, maximum: 100, default: 1 },
      commissionBps: { type: "number", minimum: 0, maximum: 100, default: 0 },
    }),
    initialEquity: { type: "number", minimum: 100, maximum: 100_000_000, default: 10_000 },
    riskPerTradeBps: integer(1, 500, 100),
  }, ["snapshotId"]), { reversible: false }),
  readTool("app.market_research.baselines.show", "Show market event baselines", "Read deterministic descriptive outcome distributions for the caller's immutable event-replay cohort. Historical frequencies are explicitly not predictive probabilities.", requiredObjectSchema({
    instrumentId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$", minLength: 3, maxLength: 120 },
    minimumSampleSize: integer(5, 100, 20),
  }, ["instrumentId"])),
  readTool("app.market_research.journal.list", "List forward market research", "Read the caller's immutable daily and weekly forward-shadow scenarios, separate outcome receipts, and abstention-aware scorecard.", requiredObjectSchema({
    instrumentId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$", minLength: 3, maxLength: 120 },
    limit: integer(1, 100, 40),
  }, ["instrumentId"])),
  mutationTool("app.market_research.journal.generate", "Generate forward market research", "Use the Settings-selected Meridian model to produce and permanently seal one research-only daily or weekly ordinal scenario before its market window. No calibrated probability or trade execution is produced.", requiredObjectSchema({
    instrumentId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$", minLength: 3, maxLength: 120 },
    horizon: { type: "string", enum: ["daily", "weekly"] },
  }, ["instrumentId", "horizon"])),
  mutationTool("app.market_research.journal.score", "Score due market research", "Resolve a bounded number of expired forward-shadow scenarios against immutable provider bars and append separate outcome receipts.", requiredObjectSchema({
    instrumentId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]+$", minLength: 3, maxLength: 120 },
    maxForecasts: integer(1, 4, 2),
  }, ["instrumentId"])),
  readTool("app.memory.intelligence.show", "Show memory intelligence", "Read the authorized memory and knowledge overview or a bounded categorized index without changing retrieval ranking or memory state.", objectSchema({
    view: { type: "string", enum: ["overview", "memory", "knowledge"], default: "overview" },
    query: text(0, 4_000),
    category: text(0, 80),
    tier: { type: "string", enum: ["working", "episodic", "semantic", "procedural", "preference", "decision", "commitment", "summary", "all"], default: "all" },
    state: { type: "string", enum: ["active", "candidate", "superseded", "contradicted", "archived", "all"], default: "all" },
    cursor: text(0, 1_000),
    limit: integer(1, 100, 40),
  })),
  readTool("app.memory.shared.list", "List shared knowledge", "List durable knowledge from one explicitly selected project or workspace membership scope.", requiredObjectSchema({
    scope: { type: "string", enum: ["project", "workspace"] },
    projectId: opaqueId("Required when scope is project."),
    workspaceId: opaqueId("Optional exact workspace ID."),
    limit: integer(1, 100, 50),
  }, ["scope"])),
  mutationTool("app.memory.shared.write", "Write shared knowledge", "Write durable knowledge to one explicitly selected project or workspace membership scope.", requiredObjectSchema({
    scope: { type: "string", enum: ["project", "workspace"] },
    projectId: opaqueId("Required when scope is project."),
    workspaceId: opaqueId("Optional exact workspace ID."),
    title: text(1, 240), content: text(1, 200_000),
    type: { type: "string", enum: ["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"] },
    tier: { type: "string", enum: ["working", "episodic", "semantic", "procedural", "preference", "decision", "commitment", "summary"] },
    tags: { type: "array", maxItems: 50, items: text(1, 80) },
    importance: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  }, ["scope", "title", "content"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.workspace_templates.list", "List workspace templates", "List active immutable workspace template versions, or their complete version history.", objectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    includeHistory: { type: "boolean", default: false },
    limit: integer(1, 200, 100),
  })),
  mutationTool("app.workspace_templates.publish", "Publish workspace template", "Publish a new immutable template version and make it the active version without changing projects created from earlier versions.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    templateId: { type: "string", pattern: "^workspace-template:[0-9a-f-]{36}$", maxLength: 55 },
    name: text(1, 120),
    description: text(0, 1_000),
    project: workspaceTemplateProjectSchema(),
    playbook: workspaceTemplatePlaybookSchema(),
  }, ["name", "project"]), { approvalRequired: true, reversible: true }),
  mutationTool("app.workspace_templates.instantiate", "Create project from template", "Create an independent project and exact work-item snapshot from one immutable template version.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    templateId: { type: "string", pattern: "^workspace-template:[0-9a-f-]{36}$", maxLength: 55 },
    templateVersionId: opaqueId("Optional exact immutable template-version ID."),
    title: text(1, 180),
    objective: text(1, 2_000),
    status: { type: "string", enum: ["draft", "active"] },
  }, ["templateId"]), { approvalRequired: true, reversible: true }),
  readTool("app.meetings.list", "List meetings", "List first-class meetings readable through the current workspace, project, and source-derived access boundary.", objectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    status: { type: "string", enum: ["scheduled", "in_progress", "completed", "cancelled"] },
    limit: integer(1, 200, 100),
  })),
  readTool("app.meetings.show", "Show meeting", "Read one exact meeting revision with its participants, consent, source links, assets, decisions, commitments, and follow-up.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    meetingId: { type: "string", pattern: "^meeting:[0-9a-f-]{36}$", maxLength: 44 },
  }, ["meetingId"])),
  mutationTool("app.meetings.create", "Create meeting", "Create a first-class meeting after resolving every calendar, recording, asset, and source link to an exact governed revision.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    ...meetingDraftProperties(),
  }, meetingDraftRequired()), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.meetings.update", "Revise meeting", "Publish a new immutable meeting revision using an exact expected revision and freshly resolved source authorities.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    meetingId: { type: "string", pattern: "^meeting:[0-9a-f-]{36}$", maxLength: 44 },
    expectedRevision: integer(1, Number.MAX_SAFE_INTEGER),
    ...meetingDraftProperties(),
  }, ["meetingId", "expectedRevision", ...meetingDraftRequired()]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.meetings.commitments.list", "List meeting commitments", "List immutable evidence-bound commitment proposals and their confirmed or dismissed resolutions for one meeting.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    meetingId: { type: "string", pattern: "^meeting:[0-9a-f-]{36}$", maxLength: 44 },
  }, ["meetingId"])),
  mutationTool("app.meetings.commitments.propose", "Propose meeting commitment", "Create a proposed WorkItem conversion from one exact timestamp-cited media action item. This creates no task or outbound draft.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    meetingId: { type: "string", pattern: "^meeting:[0-9a-f-]{36}$", maxLength: 44 },
    mediaRevisionId: opaqueId("Exact immutable processed-media revision ID."),
    actionItemId: { type: "string", pattern: "^media-action:[a-f0-9]{64}$", maxLength: 77 },
  }, ["meetingId", "mediaRevisionId", "actionItemId"]), { reversible: true }),
  mutationTool("app.meetings.commitments.resolve", "Resolve meeting commitment", "Confirm or dismiss one exact proposal. Confirmation idempotently creates canonical work, optionally creates a governed unsent email draft, and attaches both to a new meeting revision.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    meetingId: { type: "string", pattern: "^meeting:[0-9a-f-]{36}$", maxLength: 44 },
    proposalId: { type: "string", pattern: "^meeting-commitment-proposal:[a-f0-9]{64}$", maxLength: 92 },
    expectedProposalSha256: sha256("Exact immutable proposal digest."),
    decision: { type: "string", enum: ["confirmed", "dismissed"] },
    ownerParticipantId: opaqueId("Explicit participant owner confirmation when transcript evidence is absent or changed."),
    dueAt: { type: ["string", "null"], format: "date-time" },
    communication: {
      anyOf: [
        { type: "null" },
        requiredObjectSchema({
          policyId: { type: "string", pattern: "^contact_policy:[0-9a-f-]{36}$", maxLength: 51 },
          recipientParticipantId: opaqueId("Confirmed participant recipient whose email exactly matches the policy."),
          subject: text(1, 998),
          body: text(1, 50_000),
        }, ["policyId", "recipientParticipantId", "subject", "body"]),
      ],
    },
  }, ["meetingId", "proposalId", "expectedProposalSha256", "decision"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.customer_accounts.list", "List customer accounts", "List provider-neutral Account 360 records readable through the selected workspace membership and customer-data purpose boundary.", objectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    lifecycle: { type: "string", enum: customerAccountLifecycleValues() },
    limit: integer(1, 200, 100),
  })),
  readTool("app.customer_accounts.show", "Show customer Account 360", "Read one Account 360 projection with current organization, people, products, opportunities, cases, usage, projects, interactions, health, risks, renewal, conflicts, freshness, and history counts.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
  }, ["accountId"])),
  readTool("app.customer_accounts.portfolio.show", "Show customer-success portfolio", "Rank readable Account 360 records by deterministic attention state and show evidence-bound next-best actions, risk, commitments, approvals, uncertainty, confidence, and freshness.", objectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    limit: integer(1, 200, 100),
  })),
  readTool("app.customer_accounts.intelligence.show", "Show customer account intelligence", "Read one governed customer-success decision projection: what changed, current risks and commitments, exact related approvals, and a non-authoritative next-best action with evidence, freshness, confidence, and uncertainty.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    historyLimit: integer(1, 250, 100),
    timelineLimit: integer(1, 250, 100),
  }, ["accountId"])),
  mutationTool("app.customer_accounts.create", "Create customer account", "Create one provider-neutral Account 360 record with explicit owner and customer-data purposes. External CRM writes remain disabled.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    name: text(1, 240),
    lifecycle: { type: "string", enum: customerAccountLifecycleValues(), default: "prospect" },
    organizationEntityId: { type: ["string", "null"], maxLength: 240 },
    accountOwner: customerFactOwnerToolSchema(),
    customerDataPurposeIds: customerDataPurposesToolSchema(),
  }, ["name", "accountOwner"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.customer_accounts.revise", "Revise customer account", "Publish a new immutable Account 360 revision after exact optimistic-concurrency review. External CRM writes remain disabled.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    expectedRevision: integer(1, Number.MAX_SAFE_INTEGER),
    name: text(1, 240),
    lifecycle: { type: "string", enum: customerAccountLifecycleValues() },
    organizationEntityId: { type: ["string", "null"], maxLength: 240 },
    accountOwner: customerFactOwnerToolSchema(),
    customerDataPurposeIds: customerDataPurposesToolSchema(),
  }, ["accountId", "expectedRevision"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.customer_accounts.facts.record", "Record customer account fact", "Append one exact, sourced Account 360 fact revision. The source revision, customer-data purposes, owner, confidence, validity, and freshness deadline remain visible; conflicting current facts are preserved.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    factId: customerFactIdSchema(),
    expectedRevision: integer(1, Number.MAX_SAFE_INTEGER),
    factKey: { type: "string", minLength: 1, maxLength: 160, pattern: "^[a-z0-9][a-z0-9._:-]*$" },
    state: { type: "string", enum: ["active", "retracted"], default: "active" },
    value: customerFactValueToolSchema(),
    source: customerFactSourceToolSchema(),
    owner: customerFactOwnerToolSchema(),
    confidenceBasisPoints: integer(0, 10_000),
    validFrom: { type: "string", format: "date-time" },
    validTo: { type: ["string", "null"], format: "date-time" },
    staleAfter: { type: ["string", "null"], format: "date-time" },
  }, ["accountId", "factKey", "value", "source", "owner", "confidenceBasisPoints", "validFrom"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.customer_accounts.health.show", "Show customer health", "Read the current explainable customer health score, immutable history, exact factor evidence, freshness and confidence penalties, and active deterministic policy.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    historyLimit: integer(1, 100, 20),
  }, ["accountId"])),
  mutationTool("app.customer_accounts.health.evaluate", "Evaluate customer health", "Evaluate one exact Account 360 revision through the deterministic versioned factor policy. Optional model suggestions remain explicitly non-authoritative and cannot alter any factor or score.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    expectedAccountRevision: integer(1, Number.MAX_SAFE_INTEGER),
    expectedAccountSha256: sha256("Exact Account 360 revision digest."),
    modelSuggestions: {
      type: "array",
      maxItems: 20,
      items: requiredObjectSchema({
        suggestionKind: { type: "string", enum: ["next_action", "factor_review", "input_gap"] },
        statement: text(1, 1_000),
        citedEvidence: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: requiredObjectSchema({
            factRevisionId: opaqueId("Exact current fact revision ID."),
            factSha256: sha256("Exact current fact revision digest."),
          }, ["factRevisionId", "factSha256"]),
        },
        confidenceBasisPoints: integer(0, 10_000),
        origin: requiredObjectSchema({
          providerId: opaqueId("Model provider identity."),
          modelId: opaqueId("Exact model identity."),
          promptSha256: sha256("Digest of the suggestion prompt contract."),
        }, ["providerId", "modelId", "promptSha256"]),
      }, ["suggestionKind", "statement", "citedEvidence", "confidenceBasisPoints", "origin"]),
    },
  }, ["accountId", "expectedAccountRevision", "expectedAccountSha256"]), { reversible: true }),
  readTool("app.customer_accounts.workflows.list", "List customer-success workflows", "List the eight immutable CSM pack definitions and current governed workflow runs for one Account 360.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    limit: integer(1, 100, 50),
  }, ["accountId"])),
  mutationTool("app.customer_accounts.workflows.start", "Start customer-success workflow", "Create an exact Account 360-bound project and dependency-aware work items from one typed CSM pack definition. This creates no external communication or CRM effect.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    expectedAccountRevision: integer(1, Number.MAX_SAFE_INTEGER),
    expectedAccountSha256: sha256("Exact current Account 360 revision digest."),
    input: customerSuccessWorkflowInputToolSchema(),
  }, ["accountId", "expectedAccountRevision", "expectedAccountSha256", "input"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.customer_accounts.workflows.outcome.record", "Record customer-success workflow outcome", "Append an immutable completed, blocked, or cancelled outcome receipt. Completed outcomes must cite required artifacts and evidence actually produced by the workflow project.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    runId: { type: "string", pattern: "^customer-success-run:[a-f0-9]{64}$", maxLength: 85 },
    expectedRevision: integer(1, Number.MAX_SAFE_INTEGER),
    status: { type: "string", enum: ["completed", "blocked", "cancelled"] },
    summary: text(1, 4_000),
    artifactReceipts: {
      type: "array",
      maxItems: 20,
      items: requiredObjectSchema({
        artifactKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,79}$", maxLength: 80 },
        projectArtifactId: opaqueId("Exact artifact ID produced by this workflow project."),
        evidenceKeys: { type: "array", maxItems: 20, items: { type: "string", pattern: "^[a-z][a-z0-9_]{1,79}$", maxLength: 80 } },
        evidenceRefs: { type: "array", maxItems: 100, items: opaqueId("Exact evidence reference present on the project artifact.") },
      }, ["artifactKey", "projectArtifactId", "evidenceKeys", "evidenceRefs"]),
    },
    nextAction: text(1, 500),
  }, ["accountId", "runId", "expectedRevision", "status", "summary", "nextAction"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.customer_accounts.salesforce.writes.configure", "Configure Salesforce writes", "Activate or disable approval-bound Salesforce writes for one exact owner-controlled Account 360 revision. Activation requires a linked Salesforce Account and reviewed provider configuration.", requiredObjectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    expectedAccountRevision: integer(1, Number.MAX_SAFE_INTEGER),
    enabled: { type: "boolean" },
  }, ["accountId", "expectedAccountRevision", "enabled"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  salesforceCreateWriteTool(
    "app.customer_accounts.salesforce.contact.create",
    "Create Salesforce contact",
    "Create one Contact under the linked Salesforce Account through a deterministic unique External ID upsert, then verify the exact provider state.",
    salesforceContactFields(),
    ["LastName"],
  ),
  salesforceUpdateWriteTool(
    "app.customer_accounts.salesforce.contact.update",
    "Update Salesforce contact",
    "Update reviewed Contact fields only when the linked record and exact provider revision still match, then verify the resulting state.",
    salesforceContactFields(),
  ),
  salesforceCreateWriteTool(
    "app.customer_accounts.salesforce.task.create",
    "Create Salesforce task",
    "Create one Task under the linked Salesforce Account through a deterministic unique External ID upsert, then verify the exact provider state.",
    salesforceTaskFields(),
    ["Subject", "Status", "Priority"],
  ),
  salesforceUpdateWriteTool(
    "app.customer_accounts.salesforce.task.update",
    "Update Salesforce task",
    "Update reviewed Task fields only when the linked record and exact provider revision still match, then verify the resulting state.",
    salesforceTaskFields(),
  ),
  salesforceUpdateWriteTool(
    "app.customer_accounts.salesforce.note.update",
    "Update Salesforce note",
    "Update reviewed Note fields only when the linked record and exact provider revision still match, then verify the resulting state.",
    { Title: text(1, 80), Body: nullableTextTool(32_000) },
  ),
  salesforceCreateWriteTool(
    "app.customer_accounts.salesforce.case.create",
    "Create Salesforce case",
    "Create one Case under the linked Salesforce Account through a deterministic unique External ID upsert, then verify the exact provider state.",
    salesforceCaseFields(),
    ["Subject", "Status", "Priority", "Origin"],
  ),
  salesforceUpdateWriteTool(
    "app.customer_accounts.salesforce.case.update",
    "Update Salesforce case",
    "Update reviewed Case fields only when the linked record and exact provider revision still match, then verify the resulting state.",
    salesforceCaseFields(),
  ),
  salesforceCreateWriteTool(
    "app.customer_accounts.salesforce.opportunity.create",
    "Create Salesforce opportunity",
    "Create one Opportunity under the linked Salesforce Account through a deterministic unique External ID upsert, then verify the exact provider state.",
    salesforceOpportunityFields(),
    ["Name", "StageName", "CloseDate"],
  ),
  salesforceUpdateWriteTool(
    "app.customer_accounts.salesforce.opportunity.update",
    "Update Salesforce opportunity",
    "Update reviewed Opportunity fields only when the linked record and exact provider revision still match, then verify the resulting state.",
    salesforceOpportunityFields(),
  ),
  salesforceUpdateWriteTool(
    "app.customer_accounts.salesforce.account.update",
    "Update Salesforce account",
    "Update reviewed fields on the exact linked Salesforce Account only when its provider revision still matches, then verify the resulting state.",
    salesforceAccountFields(),
  ),
  readTool("app.projects.list", "List projects", "List the current actor's projects with their work items and artifacts.", objectSchema({
    limit: integer(1, 100, 50),
    status: { type: "string", enum: ["draft", "active", "completed", "archived"] },
  })),
  readTool("app.projects.show", "Show project", "Read one exact actor-owned project with its work items and artifacts.", requiredObjectSchema({
    projectId: opaqueId("Exact project ID."),
    taskLimit: integer(1, 200, 100),
    artifactLimit: integer(1, 200, 100),
  }, ["projectId"])),
  mutationTool("app.projects.create", "Create project", "Create one actor-owned project with an explicit objective.", requiredObjectSchema({
    title: text(1, 180),
    objective: text(1, 2_000),
    status: { type: "string", enum: ["draft", "active"], default: "active" },
    targetDate: { type: "string", format: "date-time" },
  }, ["title", "objective"]), { reversible: true }),
  mutationTool("app.projects.update", "Update project", "Update one exact actor-owned project, including its lifecycle status.", requiredObjectSchema({
    projectId: opaqueId("Exact project ID."),
    title: text(1, 180),
    objective: text(1, 2_000),
    status: { type: "string", enum: ["draft", "active", "completed", "archived"] },
    targetDate: { type: ["string", "null"], format: "date-time" },
  }, ["projectId"]), { reversible: true }),
  mutationTool("app.projects.plan", "Plan project", "Generate and persist a bounded dependency-aware work plan for one exact active project.", requiredObjectSchema({
    projectId: opaqueId("Exact project ID."), context: text(0, 4_000),
  }, ["projectId"]), { reversible: true }),
  mutationTool("app.projects.execution.control", "Control project execution", "Configure, start, pause, resume, synchronize, approve, or retry one exact project execution.", requiredObjectSchema({
    projectId: opaqueId("Exact project ID."), action: { type: "string", enum: ["configure", "start", "pause", "resume", "sync", "approve", "retry"] },
    autonomyMode: { type: "string", enum: ["manual", "supervised", "autonomous"] }, taskBudget: integer(1, 50),
    maxParallelTasks: integer(1, 3), requireApproval: { type: "boolean" }, workItemId: opaqueId("Exact work-item ID for approve or retry."),
  }, ["projectId", "action"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.projects.artifacts.feedback", "Rate project artifact", "Record an explicit verdict and lesson for one exact project artifact and its reflection memory.", requiredObjectSchema({
    projectId: opaqueId("Exact project ID."), artifactId: opaqueId("Exact project-artifact ID."), verdict: { type: "string", enum: ["useful", "needs_work"] }, lesson: text(3, 1_200),
  }, ["projectId", "artifactId", "verdict", "lesson"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.projects.builder.show", "Show app builder", "Read the exact project-scoped app-building session, authenticated preview readiness, and typed activity history.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."),
  }, ["projectId"])),
  mutationTool("app.projects.builder.create", "Create app workspace", "Provision one reviewed Next.js starter in a persistent, network-restricted Vercel Sandbox for the exact project.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."),
  }, ["projectId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.projects.builder.tree", "List app files", "List bounded editable files in the exact project build workspace; dependencies, generated output, credentials, and VCS metadata stay excluded.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" },
  }, ["projectId", "sessionId"])),
  readTool("app.projects.builder.search", "Search app source", "Search bounded editable source filenames and UTF-8 content inside the exact project build workspace.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, query: text(2, 120),
  }, ["projectId", "sessionId", "query"])),
  readTool("app.projects.builder.file.read", "Read app file", "Read one 1-based, line- and character-bounded UTF-8 slice and the full file's exact SHA-256 from the project build workspace. Continue with another range only when the relevant evidence is not in the returned slice.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, path: text(1, 240),
    startLine: integer(1, 1_000_000), lineCount: integer(1, 400),
  }, ["projectId", "sessionId", "path", "startLine", "lineCount"])),
  mutationTool("app.projects.builder.file.update", "Update app file", "Replace one inspected application file only when its current SHA-256 still matches; null is accepted only for a new file.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, path: text(1, 240), expectedSha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" }, content: text(0, 500_000),
  }, ["projectId", "sessionId", "path", "expectedSha256", "content"]), { riskLevel: 1, approvalRequired: false, reversible: true }),
  mutationTool("app.projects.builder.file.delete", "Delete app file", "Delete one inspected application file only when its current SHA-256 still matches; the repository diff retains the deletion for reviewed delivery.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, path: text(1, 240), expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  }, ["projectId", "sessionId", "path", "expectedSha256"]), { riskLevel: 1, approvalRequired: false, reversible: true }),
  mutationTool("app.projects.builder.command.run", "Run app check", "Run one fixed package-script check or restart the private preview; arbitrary shell commands are not accepted.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, command: { type: "string", enum: ["lint", "typecheck", "test", "build", "start_preview"] },
  }, ["projectId", "sessionId", "command"]), { riskLevel: 1, approvalRequired: false, reversible: true }),
  mutationTool("app.projects.builder.checkpoint.create", "Seal app checkpoint", "Seal an immutable provider snapshot and workspace digest for the exact session revision. Provider identifiers remain server-only.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, expectedSessionRevision: integer(1, Number.MAX_SAFE_INTEGER), reason: { type: "string", enum: ["manual", "before_forge", "after_forge", "before_sentinel"] }, label: text(1, 120), sourceRunId: opaqueId("Optional exact project-bound Agent run ID."),
  }, ["projectId", "sessionId", "expectedSessionRevision", "reason", "label"]), { riskLevel: 1, approvalRequired: false, reversible: true }),
  mutationTool("app.projects.builder.checkpoint.restore", "Restore app checkpoint", "Restore one exact sealed workspace revision after automatically preserving the current workspace as a recovery checkpoint.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, checkpointId: { type: "string", pattern: "^app_build_checkpoint_[a-f0-9]{48}$" }, expectedSessionRevision: integer(1, Number.MAX_SAFE_INTEGER),
  }, ["projectId", "sessionId", "checkpointId", "expectedSessionRevision"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.projects.builder.verification.show", "Show app verification", "Read one exact checkpoint-bound verification receipt with output digests and private-preview capture metadata; screenshot bytes and preview credentials remain excluded.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, verificationId: { type: "string", pattern: "^app_build_verification_[a-f0-9]{48}$" },
  }, ["projectId", "sessionId", "verificationId"])),
  mutationTool("app.projects.builder.verification.run", "Verify app checkpoint", "Run fixed lint and type checks and capture digest-only desktop/mobile evidence through Asael's trusted private browser against the exact current checkpoint.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, checkpointId: { type: "string", pattern: "^app_build_checkpoint_[a-f0-9]{48}$" }, expectedSessionRevision: integer(1, Number.MAX_SAFE_INTEGER),
  }, ["projectId", "sessionId", "checkpointId", "expectedSessionRevision"]), { riskLevel: 1, approvalRequired: false, reversible: false }),
  mutationTool("app.projects.builder.sentinel.record", "Record Sentinel review", "Bind one completed project-scoped Sentinel run to the exact verification and checkpoint it independently reviewed.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, verificationId: { type: "string", pattern: "^app_build_verification_[a-f0-9]{48}$" }, sourceRunId: opaqueId("Exact completed Sentinel Agent run ID."),
  }, ["projectId", "sessionId", "verificationId", "sourceRunId"]), { riskLevel: 1, approvalRequired: false, reversible: false }),
  readTool("app.projects.builder.repositories.list", "List build repositories", "List only the repositories selected for the private GitHub App installation. Installation tokens remain server-only and short-lived.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."),
  }, ["projectId"])),
  mutationTool("app.projects.builder.repository.bind", "Bind build repository", "Bind one GitHub-App-selected repository and its exact default-branch revision to the project build session.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, repositoryId: { type: "string", pattern: "^[0-9]{1,24}$" },
  }, ["projectId", "sessionId", "repositoryId"]), { riskLevel: 1, approvalRequired: false, reversible: true }),
  mutationTool("app.projects.builder.repository.checkout", "Open repository workspace", "Replace the starter with an exact GitHub revision after sealing a recovery checkpoint. The installation token never enters the sandbox, model context, files, or logs.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, repositoryBindingId: { type: "string", pattern: "^app_build_repository_[a-f0-9]{48}$" }, expectedBindingRevision: integer(1, Number.MAX_SAFE_INTEGER), expectedSessionRevision: integer(1, Number.MAX_SAFE_INTEGER),
  }, ["projectId", "sessionId", "repositoryBindingId", "expectedBindingRevision", "expectedSessionRevision"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.projects.builder.delivery.create", "Create build pull request", "Secret-scan and deliver one passing checkpoint to a new non-default GitHub branch, then open a draft pull request against the exact bound base revision.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, repositoryBindingId: { type: "string", pattern: "^app_build_repository_[a-f0-9]{48}$" }, expectedBindingRevision: integer(1, Number.MAX_SAFE_INTEGER), checkpointId: { type: "string", pattern: "^app_build_checkpoint_[a-f0-9]{48}$" }, verificationId: { type: "string", pattern: "^app_build_verification_[a-f0-9]{48}$" }, branchName: text(1, 120), title: text(3, 180), body: text(0, 8_000), draft: { type: "boolean", default: true },
  }, ["projectId", "sessionId", "repositoryBindingId", "expectedBindingRevision", "checkpointId", "verificationId", "branchName", "title"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.projects.builder.deployment.preview", "Deploy app preview", "Secret-scan and create an asynchronous Vercel preview from one exact passing checkpoint. The deployment is revision-bound and does not target production.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, checkpointId: { type: "string", pattern: "^app_build_checkpoint_[a-f0-9]{48}$" }, verificationId: { type: "string", pattern: "^app_build_verification_[a-f0-9]{48}$" }, repositoryDeliveryId: { type: "string", pattern: "^app_build_delivery_[a-f0-9]{48}$" },
  }, ["projectId", "sessionId", "checkpointId", "verificationId"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.projects.builder.deployment.refresh", "Verify app preview", "Refresh one exact Vercel preview and record bounded build-log, route-smoke, and desktop/mobile visual evidence without changing production.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, deploymentId: { type: "string", pattern: "^app_build_deployment_[a-f0-9]{48}$" },
  }, ["projectId", "sessionId", "deploymentId"]), { riskLevel: 1, approvalRequired: false, reversible: false }),
  mutationTool("app.projects.builder.release.preview", "Prepare production review", "Create a short-lived digest-bound production review from one fully verified preview. The receipt declares migration posture and the exact rollback deployment without changing production.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, deploymentId: { type: "string", pattern: "^app_build_deployment_[a-f0-9]{48}$" },
  }, ["projectId", "sessionId", "deploymentId"]), { riskLevel: 1, approvalRequired: false, reversible: false }),
  mutationTool("app.projects.builder.release.production", "Release app to production", "Promote one exact reviewed preview to production. Requires an unexpired release digest, explicit RELEASE confirmation, and human approval; declared database migrations remain blocked.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, releaseId: { type: "string", pattern: "^app_build_release_[a-f0-9]{48}$" }, releaseDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, confirmation: { type: "string", enum: ["RELEASE"] },
  }, ["projectId", "sessionId", "releaseId", "releaseDigest", "confirmation"]), { riskLevel: 3, approvalRequired: true, reversible: false }),
  mutationTool("app.projects.builder.release.refresh", "Verify production release", "Refresh the exact production deployment and append bounded build-log, route-smoke, and desktop/mobile health evidence.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" }, releaseId: { type: "string", pattern: "^app_build_release_[a-f0-9]{48}$" },
  }, ["projectId", "sessionId", "releaseId"]), { riskLevel: 1, approvalRequired: false, reversible: false }),
  mutationTool("app.projects.builder.stop", "Stop app workspace", "Stop the exact project's build sandbox while retaining its immutable activity receipts.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."), sessionId: { type: "string", pattern: "^app_build_[a-f0-9]{48}$" },
  }, ["projectId", "sessionId"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.work_items.create", "Create project work item", "Create one work item in an exact active project.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."),
    title: text(1, 240),
    detail: text(0, 1_000),
    priority: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
    agentId: { type: "string", enum: ["atlas", "scout", "forge", "sentinel", "mnemosyne"], default: "atlas" },
    dueAt: { type: "string", format: "date-time" },
  }, ["projectId", "title"]), { reversible: true }),
  mutationTool("app.work_items.update", "Update project work item", "Update one exact work item inside its exact active project.", requiredObjectSchema({
    projectId: opaqueId("Exact owning project ID."),
    workItemId: opaqueId("Exact work-item ID."),
    title: text(1, 240),
    detail: text(0, 1_000),
    status: { type: "string", enum: ["open", "doing", "done"] },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    agentId: { type: "string", enum: ["atlas", "scout", "forge", "sentinel", "mnemosyne"] },
    dueAt: { type: ["string", "null"], format: "date-time" },
  }, ["projectId", "workItemId"]), { reversible: true }),
  readTool("app.memory.list", "List memory", "List durable memories visible to the current actor, optionally for one owned thread.", objectSchema({
    limit: integer(1, 100, 20),
    threadId: text(1, 200),
  })),
  readTool("app.memory.readable.show", "Show readable memory", "Show the actor's metadata-only claim overview, timeline, scopes, use history, conflicts, entity counts, and deletion state. Claim content remains behind exact inspection.", objectSchema({
    limit: integer(1, 200, 100),
  })),
  readTool("app.memory.search", "Search memory", "Search durable memory visible to the current actor.", requiredObjectSchema({
    query: text(1, 4_000),
    limit: integer(1, 100, 20),
  }, ["query"])),
  readTool("app.memory.inspect", "Inspect memory", "Inspect one exact memory and its provenance without exposing its embedding.", requiredObjectSchema({
    id: text(1, 200),
  }, ["id"])),
  mutationTool("app.memory.write", "Write memory", "Write one actor-scoped durable memory through the governed memory service.", requiredObjectSchema({
    title: text(1, 240), content: text(1, 200_000),
    type: { type: "string", enum: ["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"] },
    tier: { type: "string", enum: ["working", "episodic", "semantic", "procedural", "preference", "decision", "commitment", "summary"] },
    tags: { type: "array", maxItems: 50, items: text(1, 80) },
    importance: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidenceRefs: { type: "array", maxItems: 50, items: text(1, 500) },
    validFrom: { type: "string", format: "date-time" }, validTo: { type: "string", format: "date-time" },
  }, ["title", "content"]), { reversible: true }),
  mutationTool("app.memory.correct", "Correct memory", "Create a corrected successor for one exact memory while preserving history.", requiredObjectSchema({
    id: text(1, 200), title: text(1, 240), content: text(1, 200_000),
    confidence: { type: "number", minimum: 0, maximum: 1 },
    validTo: { type: "string", format: "date-time" }, contradiction: { type: "boolean" },
  }, ["id"]), { reversible: true }),
  mutationTool("app.memory.lifecycle", "Change memory lifecycle", "Pin, unpin, archive, or restore one exact memory.", requiredObjectSchema({
    id: text(1, 200), action: { type: "string", enum: ["pin", "unpin", "archive", "restore"] },
  }, ["id", "action"]), { reversible: true }),
  readTool("app.memory.forget.preview", "Preview memory deletion", "Preview the exact records and projections affected by permanently forgetting one memory.", requiredObjectSchema({
    id: text(1, 200),
  }, ["id"])),
  mutationTool("app.memory.forget", "Forget memory", "Permanently scrub one exact memory only when its deletion-preview digest still matches.", requiredObjectSchema({
    id: text(1, 200),
    expectedReceiptManifestSha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
  }, ["id", "expectedReceiptManifestSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.memory.export", "Export memory", "Return the authenticated owner-only portable memory archive route without copying archive contents into the transcript.", objectSchema({})),
  readTool("app.knowledge.list", "List knowledge", "List tenant-scoped knowledge sources without chunk bodies.", objectSchema({ limit: integer(1, 100, 20) })),
  readTool("app.knowledge.search", "Search knowledge", "Search tenant-scoped knowledge chunks.", requiredObjectSchema({ query: text(1, 4_000), limit: integer(1, 100, 20) }, ["query"])),
  mutationTool("app.knowledge.ingest", "Ingest knowledge", "Chunk, embed, and store one bounded knowledge source.", requiredObjectSchema({
    title: text(1, 240), content: text(1, 20_000), source: text(0, 2_000),
    tags: { type: "array", maxItems: 50, items: text(1, 80) },
  }, ["title", "content"]), { reversible: true }),
  readTool("app.knowledge.delete.preview", "Preview knowledge-source deletion", "List the exact knowledge documents currently matched by a supported connected-source prefix and return their digest.", requiredObjectSchema({
    source: { type: "string", enum: ["google:", "google:mail:", "google:calendar:", "google:drive:"] },
  }, ["source"])),
  mutationTool("app.knowledge.delete", "Delete knowledge source", "Delete the exact knowledge-source target set only when its current digest matches the prior preview.", requiredObjectSchema({
    source: { type: "string", enum: ["google:", "google:mail:", "google:calendar:", "google:drive:"] },
    expectedTargetsSha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" },
  }, ["source", "expectedTargetsSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.today.show", "Show Today", "Read the current actor's Today snapshot.", objectSchema({})),
  readTool("app.today.agenda.show", "Show cohesive Today", "Read the actor-selected cohesive Today projection across personal reminders, meetings, commitments, customer risks, approvals, active agents, canonical work, source freshness, and complete AI consumption.", objectSchema({
    workspaceId: opaqueId("Optional exact workspace ID."),
    workLimit: integer(1, 50, 16), approvalLimit: integer(1, 25, 12),
    meetingLimit: integer(1, 200, 50), accountLimit: integer(1, 200, 50),
  })),
  mutationTool("app.today.item.create", "Create Today item", "Create one task or reminder in Today.", requiredObjectSchema({
    title: text(1, 280), kind: { type: "string", enum: ["task", "reminder"], default: "task" },
    priority: { type: "string", enum: ["low", "medium", "high"], default: "medium" }, dueAt: { type: "string", format: "date-time" },
  }, ["title"]), { reversible: true }),
  mutationTool("app.today.item.update", "Update Today item", "Update one exact Today task or reminder.", requiredObjectSchema({
    itemId: opaqueId("Exact Today-item ID."), title: text(1, 280), status: { type: "string", enum: ["open", "done"] },
    priority: { type: "string", enum: ["low", "medium", "high"] }, dueAt: { type: ["string", "null"], format: "date-time" },
  }, ["itemId"]), { reversible: true }),
  readTool("app.today.brief.show", "Show daily brief", "Read the current actor's daily brief and preferences.", objectSchema({})),
  mutationTool("app.today.brief.generate", "Generate daily brief", "Generate or refresh the current actor's daily brief.", objectSchema({ force: { type: "boolean", default: false } }), { reversible: true }),
  mutationTool("app.today.preferences.update", "Update Today preferences", "Update daily brief, reminder, notification, timezone, quiet-hours, or visible-section preferences.", objectSchema({
    briefEnabled: { type: "boolean" }, briefTime: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    timezone: text(1, 120), reminderLeadMinutes: { type: "integer", enum: [5, 15, 30, 60, 120] },
    notificationsEnabled: { type: "boolean" }, quietHoursEnabled: { type: "boolean" },
    quietHoursStart: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }, quietHoursEnd: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    visibleSections: { type: "array", minItems: 1, maxItems: 9, uniqueItems: true, items: { type: "string", enum: ["focus", "agenda", "approvals", "customers", "active_agents", "work", "memory", "conversations", "consumption"] } },
  }), { reversible: true }),
  readTool("app.notifications.list", "List notifications", "Read the current actor's notification center without generating new reminders.", objectSchema({})),
  mutationTool("app.notifications.update", "Update notification", "Read, dismiss, snooze, or complete one exact personal notification.", requiredObjectSchema({
    notificationId: opaqueId("Exact personal-notification ID."), action: { type: "string", enum: ["read", "dismiss", "snooze", "complete"] },
    minutes: { type: "integer", enum: [5, 15, 30, 60, 120, 1440] },
  }, ["notificationId", "action"]), { reversible: false }),
  mutationTool("app.notifications.read_all", "Read all notifications", "Mark all of the current actor's unread notifications as read.", objectSchema({}), { reversible: false }),
  readTool("app.runs.list", "List agent runs", "List recent tenant-scoped agent runs and optional aggregate statistics.", objectSchema({
    limit: integer(1, 100, 20), includeStats: { type: "boolean", default: false },
  })),
  readTool("app.runs.show", "Show agent run", "Read one exact tenant-scoped agent run and its context-use receipt.", requiredObjectSchema({
    runId: opaqueId("Exact agent-run ID."),
  }, ["runId"])),
  readTool("app.runs.trajectory", "Show run trajectory", "Build and verify the event trajectory, trace hierarchy, fork lineage, and outcome evaluation for one exact actor-readable run.", requiredObjectSchema({
    runId: opaqueId("Exact agent-run ID."),
  }, ["runId"])),
  mutationTool("app.runs.feedback", "Rate agent run", "Record explicit useful or needs-work feedback for one completed run and apply its governed trust and memory consequences.", requiredObjectSchema({
    runId: opaqueId("Exact completed agent-run ID."), verdict: { type: "string", enum: ["useful", "needs_work"] }, correction: text(0, 2_000),
  }, ["runId", "verdict"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.runs.cancel", "Cancel agent run", "Cancel one exact active run and its queued execution or resume deliveries.", requiredObjectSchema({
    runId: opaqueId("Exact agent-run ID."), reason: text(1, 500),
  }, ["runId"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.agents.list", "List agents", "List built-in agents and custom agents readable by the current actor.", objectSchema({
    ownerScope: { type: "string", enum: ["exact", "readable"], default: "readable" },
  })),
  readTool("app.agents.show", "Show agent", "Read one exact built-in or custom agent.", requiredObjectSchema({
    id: opaqueId("Exact agent ID."), includeBuiltIns: { type: "boolean", default: true },
  }, ["id"])),
  readTool("app.agents.cards", "Discover agent cards", "List versioned internal Agent Cards and optionally rank compatible agents for a bounded task query.", objectSchema({
    query: text(1, 4_000), taskKind: { type: "string", enum: ["general", "coordinate", "research", "build", "verify", "memory"] },
  })),
  readTool("app.agents.performance", "Show agent performance", "Read tenant-scoped performance projections for available agents.", objectSchema({})),
  readTool("app.agents.council.show", "Show Agent Council", "Read the current actor's grant-derived delegation map, messages, outputs, cost, confidence, and verifier state.", objectSchema({
    limit: integer(1, 100, 60),
  })),
  mutationTool("app.agents.delegate", "Delegate bounded agent task", "Create one durable, one-level child task for a Settings-configured specialist. The child receives only explicitly granted read tools and its result remains proposed until verifier review.", requiredObjectSchema({
    objective: text(3, 4_000),
    taskKind: { type: "string", enum: ["research", "build", "verify", "memory"] },
    acceptanceCriteria: {
      type: "array", minItems: 1, maxItems: 8, uniqueItems: true,
      items: text(3, 500),
    },
    mode: { type: "string", enum: ["isolated", "fork", "team"], default: "isolated" },
    preferredAgentId: { type: "string", enum: ["scout", "meridian", "forge", "sentinel", "mnemosyne"] },
  }, ["objective", "taskKind", "acceptanceCriteria"]), { reversible: false }),
  readTool("app.agents.tasks.list", "List delegated agent tasks", "List bounded status projections for the current actor's durable delegated tasks without exposing authority contracts, capability grants, or context capsules.", objectSchema({
    parentExecutionId: opaqueId("Optional exact parent execution ID."),
    limit: integer(1, 100, 60),
  })),
  readTool("app.agents.tasks.show", "Show delegated agent task", "Read one bounded delegated-task result and verifier projection owned by the current actor without exposing authority contracts, capability grants, or context capsules.", requiredObjectSchema({
    executionId: opaqueId("Exact delegation execution ID."),
  }, ["executionId"])),
  mutationTool("app.agents.create", "Create custom agent", "Create one custom agent with bounded skills, tools, memory, model, and approval policy.", requiredObjectSchema(agentProperties(), ["name", "role", "description", "instructions"]), { reversible: true }),
  mutationTool("app.agents.update", "Update custom agent", "Update one exact custom agent.", requiredObjectSchema({
    id: opaqueId("Exact custom-agent ID."), change: objectSchema(agentProperties()),
  }, ["id", "change"]), { reversible: true }),
  readTool("app.agents.delete.preview", "Preview custom-agent trash", "Preview moving one exact custom Agent to reversible trash, including the immutable-identity compensation limitation.", requiredObjectSchema({ id: opaqueId("Exact custom-agent ID.") }, ["id"])),
  mutationTool("app.agents.delete", "Move custom agent to trash", "Move one exact custom Agent to retained trash only while its complete expiring preview still matches.", requiredObjectSchema({
    id: opaqueId("Exact custom-agent ID."), preview: trashPreviewContract("custom_agent"),
  }, ["id", "preview"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.agents.release.show", "Show agent release", "Read the active release channel, available definition versions, and evaluations for one custom agent.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."),
  }, ["agentId"])),
  mutationTool("app.agents.release.evaluate", "Evaluate agent release", "Evaluate one exact custom-agent definition version against its active release baseline.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."), definitionVersion: integer(1, Number.MAX_SAFE_INTEGER),
  }, ["agentId", "definitionVersion"]), { reversible: true }),
  mutationTool("app.agents.release.transition", "Transition agent release", "Promote or roll back an agent release using one exact persisted evaluation.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."), action: { type: "string", enum: ["promote", "rollback"] },
    evaluationId: { type: "string", pattern: "^agent-release-evaluation:[a-f0-9]{64}$", maxLength: 240 },
  }, ["agentId", "action", "evaluationId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.agents.release.retire.preview", "Preview agent retirement", "Preview the exact active release and definition identities that retirement will revoke.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."),
  }, ["agentId"])),
  mutationTool("app.agents.release.retire", "Retire agent release", "Retire one custom agent and revoke its execution identity only when the preview digest still matches.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."), expectedTargetSha256: sha256("Digest returned by app.agents.release.retire.preview."),
  }, ["agentId", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.agents.grants.list", "List agent memory grants", "List the exact context and capability memory grants held by one custom agent.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."),
  }, ["agentId"])),
  mutationTool("app.agents.grants.create", "Create agent memory grant", "Create one bounded memory grant and rotate the custom agent's grant authority.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."), grant: agentGrantSchema(),
  }, ["agentId", "grant"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.agents.grants.revoke.preview", "Preview agent grant revocation", "Preview the exact memory grant that will be revoked from one custom agent.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."), grantId: grantId(),
  }, ["agentId", "grantId"])),
  mutationTool("app.agents.grants.revoke", "Revoke agent memory grant", "Revoke one exact agent memory grant only when its preview digest still matches.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."), grantId: grantId(), expectedTargetSha256: sha256("Digest returned by app.agents.grants.revoke.preview."),
  }, ["agentId", "grantId", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.agents.adaptations.list", "List agent adaptations", "List observed and active adaptations for one custom agent and its current definition version.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."),
  }, ["agentId"])),
  mutationTool("app.agents.adaptations.refresh", "Refresh agent adaptations", "Observe correction-backed evidence and refresh proposed adaptations for one custom agent.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."),
  }, ["agentId"]), { reversible: true }),
  mutationTool("app.agents.adaptations.manage", "Manage agent adaptation", "Evaluate, activate, or roll back one exact correction-backed agent adaptation.", requiredObjectSchema({
    agentId: opaqueId("Exact custom-agent ID."), adaptationId: { type: "string", pattern: "^agent-adaptation:[a-f0-9]{64}$" },
    action: { type: "string", enum: ["evaluate", "activate", "rollback"] },
  }, ["agentId", "adaptationId", "action"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.skills.list", "List skills", "List built-in and custom skills readable by the current actor.", objectSchema({})),
  readTool("app.skills.show", "Show skill", "Read one exact built-in or custom skill.", requiredObjectSchema({ id: opaqueId("Exact skill ID.") }, ["id"])),
  mutationTool("app.skills.create", "Create skill", "Create one custom skill with bounded instructions and tool assignments.", requiredObjectSchema(skillProperties(), ["name", "description", "instructions", "category"]), { reversible: true }),
  mutationTool("app.skills.update", "Update skill", "Update one exact custom skill.", requiredObjectSchema({
    id: opaqueId("Exact custom-skill ID."), change: objectSchema(skillProperties()),
  }, ["id", "change"]), { reversible: true }),
  readTool("app.skills.delete.preview", "Preview skill trash", "Preview moving one exact custom Skill and its current Agent assignments to reversible trash.", requiredObjectSchema({ id: opaqueId("Exact custom-skill ID.") }, ["id"])),
  mutationTool("app.skills.delete", "Move skill to trash", "Move one exact custom Skill to retained trash only while its complete expiring preview still matches.", requiredObjectSchema({
    id: opaqueId("Exact custom-skill ID."), preview: trashPreviewContract("agent_skill"),
  }, ["id", "preview"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.workflows.list", "List workflows", "List tenant-scoped workflow runs with optional queue and aggregate status.", objectSchema({
    limit: integer(1, 100, 20), includeStats: { type: "boolean", default: true }, includeQueue: { type: "boolean", default: true },
  })),
  readTool("app.workflows.show", "Show workflow", "Read one exact tenant-scoped workflow with its step detail.", requiredObjectSchema({ workflowId: opaqueId("Exact workflow-run ID.") }, ["workflowId"])),
  readTool("app.workflows.trajectory", "Show workflow trajectory", "Build the actor-readable event and causation trace hierarchy for one exact workflow run.", requiredObjectSchema({ workflowId: opaqueId("Exact workflow-run ID.") }, ["workflowId"])),
  readTool("app.workflows.plans.list", "List workflow plans", "List recent tenant-scoped workflow plans and planning statistics.", objectSchema({ limit: integer(1, 100, 20) })),
  mutationTool("app.workflows.plan", "Plan workflow", "Create a bounded workflow plan for an explicit goal without starting execution.", requiredObjectSchema({
    goal: text(1, 4_000), mode: workflowMode(), requireApproval: { type: "boolean", default: false }, reuseExisting: { type: "boolean", default: true },
  }, ["goal"]), { reversible: true }),
  readTool("app.workflows.executions.list", "List workflow executions", "List tenant-scoped workflow plan-node executions and statistics.", objectSchema({ limit: integer(1, 200, 50) })),
  mutationTool("app.workflows.start", "Start workflow", "Create and enqueue one idempotent workflow for an explicit goal and bounded budget.", requiredObjectSchema({
    goal: text(1, 4_000), mode: workflowMode(), requireApproval: { type: "boolean", default: false },
    maxAttempts: integer(1, 5, 3), budgets: workflowBudgetsSchema(),
  }, ["goal"]), { reversible: true }),
  mutationTool("app.workflows.signal", "Signal workflow", "Pause, resume, cancel, approve, or retry one exact workflow.", requiredObjectSchema({
    workflowId: opaqueId("Exact workflow-run ID."), signal: { type: "string", enum: ["pause", "resume", "cancel", "approve", "retry"] },
  }, ["workflowId", "signal"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  mutationTool("app.workflows.tick", "Tick workflow", "Process at most one queued step for one exact workflow; consequential tools retain their own approval gates.", requiredObjectSchema({
    workflowId: opaqueId("Exact workflow-run ID."),
  }, ["workflowId"]), { reversible: false }),
  readTool("app.connectors.list", "List connectors", "List tenant-scoped MCP and OpenAPI connectors with reviewed contract summaries.", objectSchema({
    kind: connectorKind(), limit: integer(1, 100, 20),
  })),
  readTool("app.integrations.overview.show", "Show integration access", "Show what the current actor can access and do through installed OAuth, MCP, OpenAPI, and Salesforce integrations, including permission, sync, cursor, freshness, failure, and attributable cost states. Catalog suggestions remain separate.", objectSchema({
    workspaceId: opaqueId("Optional canonical Workspace ID for Salesforce health."),
  })),
  readTool("app.connectors.show", "Show connector", "Read one exact connector and its discovered tools or imported operations.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."),
  }, ["kind", "connectorId"])),
  mutationTool("app.connectors.register", "Register connector", "Register one MCP or OpenAPI connector using no auth or a deployer-managed environment binding; raw credentials are never accepted.", requiredObjectSchema({
    kind: connectorKind(), name: text(1, 120), endpoint: { type: "string", format: "uri", maxLength: 2_048 },
    specUrl: { type: "string", format: "uri", maxLength: 2_048 }, baseUrl: { type: "string", format: "uri", maxLength: 2_048 },
    authType: { type: "string", enum: ["none", "bearer_env", "api_key_header_env"], default: "none" },
    authTokenEnv: { type: "string", pattern: "^[A-Z0-9_]+$", maxLength: 120 }, authHeaderName: text(1, 80),
    defaultRiskLevel: { type: "integer", enum: [0, 1, 2, 3], default: 2 }, approvalRequired: { type: "boolean", default: true },
  }, ["kind", "name"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.connectors.update", "Update connector", "Update one exact connector; contract-changing updates disable it until refresh and review.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), name: text(1, 120),
    endpoint: { type: "string", format: "uri", maxLength: 2_048 }, specUrl: { type: ["string", "null"], format: "uri", maxLength: 2_048 },
    baseUrl: { type: "string", format: "uri", maxLength: 2_048 }, status: { type: "string", enum: ["active", "error", "disabled"] },
    defaultRiskLevel: { type: "integer", enum: [0, 1, 2, 3] }, approvalRequired: { type: "boolean" },
  }, ["kind", "connectorId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.connectors.refresh", "Refresh connector contracts", "Discover MCP tools or import an OpenAPI spec from a public URL, leaving changed contracts pending review.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), specUrl: { type: "string", format: "uri", maxLength: 2_048 },
    baseUrl: { type: "string", format: "uri", maxLength: 2_048 },
  }, ["kind", "connectorId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.connectors.review", "Approve connector contracts", "Promote the exact discovered contract set only when its review fingerprint still matches.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), expectedFingerprint: text(20, 200),
  }, ["kind", "connectorId", "expectedFingerprint"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.connectors.delete.preview", "Preview connector trash", "Preview moving the exact connector and operation contracts to reversible trash, including any credential reconnection limitation.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."),
  }, ["kind", "connectorId"])),
  mutationTool("app.connectors.delete", "Move connector to trash", "Move one connector and its exact contract set to retained trash only while its complete expiring preview still matches.", requiredObjectSchema({
    kind: connectorKind(), connectorId: opaqueId("Exact connector ID."), preview: trashPreviewContract(),
  }, ["kind", "connectorId", "preview"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.trash.list", "List trash", "List actor-private trash item metadata without returning internal restore snapshots.", objectSchema({
    state: { type: "string", enum: ["retained", "restored", "purged", "expired"] },
    limit: integer(1, 200, 50),
  })),
  readTool("app.trash.show", "Show trash item", "Inspect one exact actor-private trash item and its compensation limitation without returning its internal snapshot.", requiredObjectSchema({
    trashId: trashId(),
  }, ["trashId"])),
  readTool("app.trash.receipts.list", "List trash receipts", "List immutable effect and final-deletion receipts for one exact actor-private trash item.", requiredObjectSchema({
    trashId: trashId(), limit: integer(1, 200, 50),
  }, ["trashId"])),
  readTool("app.trash.restore.preview", "Preview trash restore", "Create a complete expiring revision-fenced preview for restoring or compensating one retained trash item.", requiredObjectSchema({
    trashId: trashId(),
  }, ["trashId"])),
  mutationTool("app.trash.restore", "Restore trash item", "Restore or compensate one retained item only while its complete expiring preview and lifecycle revision still match.", requiredObjectSchema({
    preview: trashLifecyclePreviewContract("restore"),
  }, ["preview"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.trash.purge.preview", "Preview permanent trash purge", "Create a complete expiring revision-fenced preview that clearly marks permanent snapshot deletion as irreversible.", requiredObjectSchema({
    trashId: trashId(),
  }, ["trashId"])),
  mutationTool("app.trash.purge", "Permanently purge trash item", "Permanently destroy one retained restore snapshot only while its complete expiring preview and lifecycle revision still match; retain the immutable final deletion receipt.", requiredObjectSchema({
    preview: trashLifecyclePreviewContract("purge"),
  }, ["preview"]), { riskLevel: 3, approvalRequired: true, reversible: false }),
  readTool("app.settings.show", "Show settings", "Read the current actor's redacted provider, model, assignment, API-key metadata, MCP exposure, vault readiness, and platform settings.", objectSchema({})),
  readTool("app.settings.models.list", "List models", "List the current actor's selectable model catalog without credentials.", objectSchema({})),
  mutationTool("app.settings.assignments.update", "Update model assignment", "Update one model routing assignment; cross-provider fallback requires explicit disclosure consent.", requiredObjectSchema({
    scope: { type: "string", enum: ["main_agent", "orchestrator", "planner", "verifier", "council", "market_research", "code_builder", "memory", "embeddings", "vision", "audio", "audio_diarization", "web_search", "image_generation", "video_generation", "computer_use", "speech_synthesis", "realtime_transcription"] },
    provider: modelProvider(), modelId: text(1, 240), fallbackProvider: modelProvider(), fallbackModelId: text(1, 240),
    crossProviderFallbackConsent: { type: "boolean", enum: [true] },
  }, ["scope", "provider", "modelId"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.settings.mcp.update", "Update MCP exposure", "Update the current actor's first-party MCP export configuration and allowed scopes.", requiredObjectSchema({
    enabled: { type: "boolean" }, serverName: text(1, 120), allowedScopes: serviceApiScopes(), exposeResources: { type: "boolean", default: false },
  }, ["enabled", "serverName", "allowedScopes"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.settings.providers.update", "Update provider metadata", "Rename or enable/disable one exact tenant-vault provider connection without handling credentials.", requiredObjectSchema({
    id: opaqueId("Exact provider-connection ID."), label: text(1, 120), enabled: { type: "boolean" },
  }, ["id"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  mutationTool("app.settings.providers.validate", "Validate provider", "Validate one exact provider connection and refresh its model catalog.", requiredObjectSchema({
    id: opaqueId("Exact provider-connection ID."),
  }, ["id"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.settings.providers.revoke.preview", "Preview provider revocation", "Preview the exact redacted provider credential record that revocation will scrub.", requiredObjectSchema({ id: opaqueId("Exact provider-connection ID.") }, ["id"])),
  mutationTool("app.settings.providers.revoke", "Revoke provider", "Revoke and scrub one exact tenant-vault provider credential only when the preview digest still matches.", requiredObjectSchema({
    id: opaqueId("Exact provider-connection ID."), expectedTargetSha256: sha256("Digest returned by the provider revocation preview."),
  }, ["id", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.settings.api_keys.list", "List service API keys", "List only redacted service API-key metadata for the current actor.", objectSchema({})),
  readTool("app.settings.api_keys.revoke.preview", "Preview API-key revocation", "Preview one exact redacted service API key before revocation.", requiredObjectSchema({ id: opaqueId("Exact service API-key ID.") }, ["id"])),
  mutationTool("app.settings.api_keys.revoke", "Revoke service API key", "Revoke one exact service API key only when its redacted target digest still matches.", requiredObjectSchema({
    id: opaqueId("Exact service API-key ID."), expectedTargetSha256: sha256("Digest returned by the API-key revocation preview."),
  }, ["id", "expectedTargetSha256"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.communications.policies.list", "List Gmail and email contact policies", "List the current actor's governed person, Gmail, and email channel communication policies required before sending.", objectSchema({})),
  mutationTool("app.communications.policies.upsert", "Set Gmail or email contact policy", "Create or update one actor-private Gmail or email contact policy with explicit relationship, consent, disclosure, quiet-hours, frequency, and opt-out controls before sending.", requiredObjectSchema({
    personRef: opaqueId("Stable person reference."), displayName: text(1, 240),
    channel: { type: "string", enum: ["email", "message", "voice"] }, address: text(3, 500),
    relationship: { type: "string", enum: ["personal", "colleague", "customer", "vendor", "other"] },
    allowedPurposes: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["informational", "coordination", "follow_up", "support", "commercial"] } },
    allowedDisclosure: { type: "string", enum: ["public_only", "relationship_context", "confidential"] },
    consent: { type: "string", enum: ["explicit", "relationship_basis", "unknown"] },
    maxDeliveriesPerDay: integer(1, 50),
    quietHours: requiredObjectSchema({
      enabled: { type: "boolean" }, timeZone: text(1, 120),
      start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
      end: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    }, ["enabled", "timeZone", "start", "end"]),
    status: { type: "string", enum: ["active", "paused", "opted_out"] }, optOutReason: text(1, 500),
  }, ["personRef", "displayName", "channel", "address", "relationship", "allowedPurposes", "allowedDisclosure", "consent", "maxDeliveriesPerDay", "quietHours", "status"]), { riskLevel: 2, approvalRequired: true, reversible: true }),
  readTool("app.communications.drafts.list", "List Gmail and email drafts", "List actor-private governed Gmail and email drafts, including their exact lifecycle state.", objectSchema({})),
  mutationTool("app.communications.drafts.create", "Create Gmail or email draft", "Create an immutable actor-private Gmail or email draft under one exact contact policy; this does not contact or send to the recipient.", requiredObjectSchema({
    policyId: { type: "string", pattern: "^contact_policy:[0-9a-f-]{36}$", maxLength: 51 },
    purpose: { type: "string", enum: ["informational", "coordination", "follow_up", "support", "commercial"] },
    disclosure: { type: "string", enum: ["public_only", "relationship_context", "confidential"] },
    subject: text(1, 998), body: text(1, 50_000), canonicalThreadId: opaqueId("Optional owned conversation ID."),
  }, ["policyId", "purpose", "disclosure", "subject", "body"]), { reversible: true }),
  mutationTool("app.communications.deliver", "Send approved Gmail or email message", "Send and deliver only the exact persisted Gmail or email draft shown for approval. Recipient, subject, body, and immutable digest must all still match; spoken or free-form confirmation is insufficient.", requiredObjectSchema({
    draftId: { type: "string", pattern: "^message_draft:[0-9a-f-]{36}$", maxLength: 50 },
    expectedDraftSha256: sha256("Immutable digest returned with the draft."),
    reviewedRecipient: text(3, 500), reviewedSubject: text(1, 998), reviewedBody: text(1, 50_000),
  }, ["draftId", "expectedDraftSha256", "reviewedRecipient", "reviewedSubject", "reviewedBody"]), { riskLevel: 2, approvalRequired: true, reversible: false }),
  readTool("app.payments.ap2.readiness", "Show AP2 readiness", "Inspect the pinned AP2 protocol, all five role and verification boundaries, accepted adapters and key authorities, credential isolation, signed receipt reconciliation, and disabled payment-capability gates. This cannot initiate a purchase or payment.", objectSchema({})),
  readTool("app.payments.ap2.transactions.list", "List AP2 payment evidence", "List the current actor's evidence-derived AP2 payment projections, including recoverable discrepancies. This returns no raw receipt, credential, or provider authorization and cannot initiate payment.", objectSchema({})),
  readTool("app.payments.ap2.transactions.show", "Show AP2 payment evidence", "Inspect one actor-private AP2 payment projection derived from signed receipts and provider reconciliation. This returns no raw receipt, credential, or provider authorization and cannot initiate payment.", requiredObjectSchema({
    transactionId: { type: "string", pattern: "^ap2_payment:[0-9a-f-]{36}$", maxLength: 48 },
  }, ["transactionId"])),
  readTool("app.payments.ap2.mandates.list", "List AP2 mandate reviews", "List metadata and digests for the current actor's human-present AP2 reviews without returning shipping details, credential material, or signing assertions.", objectSchema({})),
  mutationTool("app.payments.ap2.mandates.prepare", "Prepare AP2 mandate review", "Create an exact human-present Checkout and Payment Mandate review only after the configured deterministic merchant adapter verifies the signed checkout. This cannot sign, approve, request a payment credential, or initiate payment.", requiredObjectSchema({
    shoppingAgentPrincipalId: opaqueId("Exact governed Shopping Agent principal ID."),
    intentSha256: sha256("Digest of the exact purchase intent."),
    merchantCheckoutJwt: text(1, 200_000),
    terms: requiredObjectSchema({
      merchant: requiredObjectSchema({ id: opaqueId("Merchant ID."), name: text(1, 240), website: { type: "string", format: "uri", pattern: "^https://" } }, ["id", "name", "website"]),
      merchantOrderId: opaqueId("Merchant order ID."),
      items: { type: "array", minItems: 1, maxItems: 500, items: requiredObjectSchema({ id: opaqueId("Merchant item ID."), title: text(1, 500), quantity: integer(1, 10_000), unitAmountMinor: integer(0, Number.MAX_SAFE_INTEGER), totalAmountMinor: integer(0, Number.MAX_SAFE_INTEGER) }, ["id", "title", "quantity", "unitAmountMinor", "totalAmountMinor"]) },
      totals: requiredObjectSchema({ currency: { type: "string", pattern: "^[A-Z]{3}$" }, subtotalAmountMinor: integer(0, Number.MAX_SAFE_INTEGER), taxAmountMinor: integer(0, Number.MAX_SAFE_INTEGER), shippingAmountMinor: integer(0, Number.MAX_SAFE_INTEGER), discountAmountMinor: integer(0, Number.MAX_SAFE_INTEGER), totalAmountMinor: integer(0, Number.MAX_SAFE_INTEGER) }, ["currency", "subtotalAmountMinor", "taxAmountMinor", "shippingAmountMinor", "discountAmountMinor", "totalAmountMinor"]),
      shipping: requiredObjectSchema({ recipientName: text(1, 240), addressLines: { type: "array", minItems: 1, maxItems: 4, items: text(1, 240) }, city: text(1, 160), region: text(1, 160), postalCode: text(1, 40), country: { type: "string", pattern: "^[A-Z]{2}$" }, serviceLevel: text(1, 160) }, ["recipientName", "addressLines", "city", "region", "postalCode", "country", "serviceLevel"]),
      paymentInstrument: requiredObjectSchema({ id: opaqueId("Opaque payment-instrument reference."), type: text(1, 80), description: text(1, 240) }, ["id", "type", "description"]),
      paymentConstraints: requiredObjectSchema({ credentialProviderId: opaqueId("Credential Provider participant ID."), merchantPaymentProcessorId: opaqueId("Merchant Payment Processor participant ID."), allowedInstrumentTypes: { type: "array", minItems: 1, maxItems: 20, items: text(1, 80) }, maximumAmountMinor: integer(0, Number.MAX_SAFE_INTEGER), currency: { type: "string", pattern: "^[A-Z]{3}$" }, immediateExecutionOnly: { type: "boolean", enum: [true] } }, ["credentialProviderId", "merchantPaymentProcessorId", "allowedInstrumentTypes", "maximumAmountMinor", "currency", "immediateExecutionOnly"]),
      expiresAt: { type: "string", format: "date-time" },
    }, ["merchant", "merchantOrderId", "items", "totals", "shipping", "paymentInstrument", "paymentConstraints", "expiresAt"]),
  }, ["shoppingAgentPrincipalId", "intentSha256", "merchantCheckoutJwt", "terms"]), { reversible: true }),
  mutationTool(
    "app.artifacts.presentations.create",
    "Create editable presentation",
    "Create a polished, editable PowerPoint presentation inside Asael from a bounded high-level slide blueprint. Use this for presentations, pitch decks, slide decks, PowerPoint files, and client proposals; it returns a private artifact link rather than binary content.",
    presentationArtifactToolSchema(),
    { riskLevel: 1, approvalRequired: false, reversible: false },
  ),
  readTool("app.assets.list", "List captured files and imported Google Photos", "List actor-readable uploaded files, recordings, and photos explicitly imported through Google Photos Picker without copying stored binary content into the transcript.", objectSchema({
    kind: assetKind(), limit: integer(1, 100, 50),
  })),
  readTool("app.assets.show", "Show captured file or imported Google Photo", "Read metadata for one exact uploaded file, recording, or photo explicitly imported through Google Photos Picker without returning stored binary content.", requiredObjectSchema({
    kind: assetKind(), id: opaqueId("Exact capture asset or recording ID."),
  }, ["kind", "id"])),
  mutationTool("app.assets.index", "Index captured asset", "Extract or accept a supplied note for one already stored asset, then enqueue it for governed knowledge ingestion without returning binary content.", requiredObjectSchema({
    id: opaqueId("Exact capture-asset ID."), title: text(1, 240), note: text(0, 20_000),
    tags: { type: "array", maxItems: 50, uniqueItems: true, items: text(1, 80) },
  }, ["id"]), { reversible: true }),
  mutationTool("app.assets.recordings.start", "Start recording record", "Create a governed recording record that direct user-to-storage audio segments can attach to.", objectSchema(recordingProperties()), { reversible: true }),
  mutationTool("app.assets.recordings.update", "Update recording", "Update the title, language, or tags for one exact recording.", requiredObjectSchema({
    id: opaqueId("Exact recording ID."), ...recordingProperties(),
  }, ["id"]), { reversible: true }),
  mutationTool("app.assets.recordings.complete", "Complete recording", "Finalize and enqueue indexing for one exact recording whose audio segments were uploaded directly by the user.", requiredObjectSchema({
    id: opaqueId("Exact recording ID."),
  }, ["id"]), { reversible: false }),
  readTool("app.assets.delete.preview", "Preview captured-content deletion", "Preview the exact asset, derived knowledge reference, ingest job, and recording segment IDs affected by deletion.", requiredObjectSchema({
    kind: assetKind(), id: opaqueId("Exact capture asset or recording ID."),
  }, ["kind", "id"])),
  mutationTool("app.assets.delete", "Delete captured content", "Permanently delete one exact capture asset or recording and its derived knowledge only when its preview digest still matches.", requiredObjectSchema({
    kind: assetKind(), id: opaqueId("Exact capture asset or recording ID."), expectedTargetSha256: sha256("Digest returned by app.assets.delete.preview."),
  }, ["kind", "id", "expectedTargetSha256"]), { riskLevel: 3, approvalRequired: true, reversible: false }),
] satisfies readonly ToolDefinition[]);

function readTool(id: string, name: string, description: string, inputSchema: Record<string, unknown>): ToolDefinition {
  return { id, name, description, category: "app", status: "active", riskLevel: 0, dryRunSupported: true, approvalRequired: false, operationClass: "read_only", reversible: true, inputSchema };
}

function mutationTool(
  id: string,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  options: { riskLevel?: 1 | 2 | 3; approvalRequired?: boolean; reversible?: boolean } = {},
): ToolDefinition {
  return {
    id, name, description, inputSchema, category: "app", status: "active",
    riskLevel: options.riskLevel || 1,
    dryRunSupported: true,
    approvalRequired: options.approvalRequired || false,
    operationClass: "mutation",
    reversible: options.reversible ?? false,
  };
}

function objectSchema(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, properties };
}

function requiredObjectSchema(properties: Record<string, unknown>, required: string[]) {
  return { ...objectSchema(properties), required };
}

function text(minLength: number, maxLength: number) {
  return { type: "string", minLength, maxLength };
}

function integer(minimum: number, maximum: number, defaultValue?: number) {
  return { type: "integer", minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) };
}

function salesforceCreateWriteTool(
  id: string,
  name: string,
  description: string,
  fields: Record<string, unknown>,
  requiredFields: string[],
) {
  return mutationTool(id, name, description, requiredObjectSchema({
    ...salesforceWriteBaseProperties(),
    fields: requiredObjectSchema(fields, requiredFields),
  }, ["accountId", "expectedAccountRevision", "fields"]), {
    riskLevel: 2,
    approvalRequired: true,
    reversible: false,
  });
}

function salesforceUpdateWriteTool(
  id: string,
  name: string,
  description: string,
  fields: Record<string, unknown>,
) {
  return mutationTool(id, name, description, requiredObjectSchema({
    ...salesforceWriteBaseProperties(),
    recordId: salesforceRecordIdToolSchema(),
    expectedProviderModifiedAt: { type: "string", format: "date-time" },
    fields: { ...objectSchema(fields), minProperties: 1 },
  }, [
    "accountId", "expectedAccountRevision", "recordId",
    "expectedProviderModifiedAt", "fields",
  ]), { riskLevel: 2, approvalRequired: true, reversible: false });
}

function salesforceWriteBaseProperties() {
  return {
    workspaceId: opaqueId("Optional exact workspace ID."),
    accountId: customerAccountIdSchema(),
    expectedAccountRevision: integer(1, Number.MAX_SAFE_INTEGER),
  };
}

function salesforceRecordIdToolSchema() {
  return { type: "string", pattern: "^[A-Za-z0-9]{15,18}$" };
}

function nullableTextTool(maxLength: number) {
  return { anyOf: [text(1, maxLength), { type: "null" }] };
}

function salesforceDateTool() {
  return { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
}

function salesforceAccountFields() {
  return {
    Name: text(1, 255), Phone: nullableTextTool(40),
    Website: nullableTextTool(255), Industry: nullableTextTool(80),
    Type: nullableTextTool(80), Description: nullableTextTool(32_000),
    BillingStreet: nullableTextTool(255), BillingCity: nullableTextTool(40),
    BillingState: nullableTextTool(80), BillingPostalCode: nullableTextTool(20),
    BillingCountry: nullableTextTool(80),
  };
}

function salesforceContactFields() {
  return {
    FirstName: nullableTextTool(40), LastName: text(1, 80),
    Email: { anyOf: [{ type: "string", format: "email", maxLength: 254 }, { type: "null" }] },
    Phone: nullableTextTool(40), MobilePhone: nullableTextTool(40),
    Title: nullableTextTool(128), Department: nullableTextTool(80),
    Description: nullableTextTool(32_000),
  };
}

function salesforceTaskFields() {
  return {
    Subject: text(1, 255), Description: nullableTextTool(32_000),
    ActivityDate: { anyOf: [salesforceDateTool(), { type: "null" }] },
    Status: text(1, 80), Priority: text(1, 80),
  };
}

function salesforceCaseFields() {
  return {
    Subject: text(1, 255), Description: nullableTextTool(32_000),
    Status: text(1, 80), Priority: text(1, 80), Origin: text(1, 80),
    Type: nullableTextTool(80), Reason: nullableTextTool(80),
  };
}

function salesforceOpportunityFields() {
  return {
    Name: text(1, 120), StageName: text(1, 120), CloseDate: salesforceDateTool(),
    Amount: { anyOf: [{ type: "number", minimum: 0, maximum: 1_000_000_000_000 }, { type: "null" }] },
    Probability: { anyOf: [{ type: "number", minimum: 0, maximum: 100 }, { type: "null" }] },
    Type: nullableTextTool(80), NextStep: nullableTextTool(255),
    Description: nullableTextTool(32_000),
  };
}

function opaqueId(description: string) {
  return { type: "string", minLength: 1, maxLength: 200, description };
}

function workspaceTemplateProjectSchema() {
  return requiredObjectSchema({
    title: text(1, 180),
    objective: text(1, 2_000),
    status: { type: "string", enum: ["draft", "active"], default: "draft" },
    tasks: {
      type: "array",
      maxItems: 20,
      items: requiredObjectSchema({
        key: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$" },
        title: text(1, 240),
        detail: text(0, 1_000),
        priority: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
        agentId: { type: "string", enum: ["atlas", "scout", "forge", "sentinel", "mnemosyne"], default: "atlas" },
        dependsOnKeys: { type: "array", maxItems: 20, uniqueItems: true, items: text(1, 80) },
      }, ["key", "title"]),
    },
  }, ["title", "objective"]);
}

function workspaceTemplatePlaybookSchema() {
  return {
    anyOf: [
      { type: "null" },
      requiredObjectSchema({
        aliases: { type: "array", minItems: 1, maxItems: 24, uniqueItems: true, items: text(1, 240) },
        mode: { type: "string", enum: ["orchestrate", "research", "execute", "learn"], default: "orchestrate" },
        toolBindings: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: requiredObjectSchema({
            toolId: opaqueId("Exact governed tool ID."),
            input: { type: "object", maxProperties: 100 },
          }, ["toolId", "input"]),
        },
        acceptanceCriteria: { type: "array", minItems: 1, maxItems: 20, items: text(1, 500) },
      }, ["aliases", "toolBindings", "acceptanceCriteria"]),
    ],
  };
}

function meetingDraftRequired() {
  return [
    "title", "status", "scheduledStartAt", "scheduledEndAt", "timezone",
    "declaredAccessClass",
  ];
}

function meetingDraftProperties() {
  const participantId = opaqueId("Exact participant identity inside the meeting.");
  const sourceLinkId = opaqueId("Exact link identity inside the meeting.");
  return {
    title: text(1, 240),
    summary: text(0, 8_000),
    status: { type: "string", enum: ["scheduled", "in_progress", "completed", "cancelled"] },
    scheduledStartAt: { type: "string", format: "date-time" },
    scheduledEndAt: { type: "string", format: "date-time" },
    actualStartAt: { type: ["string", "null"], format: "date-time" },
    actualEndAt: { type: ["string", "null"], format: "date-time" },
    timezone: text(1, 100),
    location: text(0, 500),
    projectId: { type: ["string", "null"], maxLength: 240 },
    declaredAccessClass: { type: "string", enum: ["owner_private", "project_members", "workspace_members"] },
    participants: {
      type: "array", maxItems: 250, items: requiredObjectSchema({
        participantId,
        displayName: text(1, 160),
        email: { type: ["string", "null"], format: "email", maxLength: 320 },
        entityId: { type: ["string", "null"], maxLength: 240 },
        role: { type: "string", enum: ["organizer", "required", "optional", "guest"] },
        response: { type: "string", enum: ["accepted", "declined", "tentative", "needs_action", "unknown"] },
        attendeeConsent: { type: "string", enum: ["granted", "declined", "pending", "unknown"] },
        recordingConsent: { type: "string", enum: ["granted", "declined", "pending", "not_required", "unknown"] },
        consentCapturedAt: { type: ["string", "null"], format: "date-time" },
        source: { type: "string", enum: ["calendar", "manual"] },
      }, ["participantId", "displayName", "role", "response", "attendeeConsent", "recordingConsent", "source"]),
    },
    sourceLinks: {
      type: "array", maxItems: 100, items: requiredObjectSchema({
        linkId: sourceLinkId,
        kind: { type: "string", enum: ["calendar_event", "capture_recording", "capture_asset", "source_revision"] },
        sourceId: opaqueId("Exact calendar/source/capture identity."),
        sourceRevisionId: opaqueId("Exact immutable revision when already known."),
        mediaRole: { type: "string", enum: ["calendar", "recording", "transcript", "attachment", "reference"] },
        label: text(1, 240),
      }, ["linkId", "kind", "sourceId", "mediaRole", "label"]),
    },
    entityLinks: {
      type: "array", maxItems: 100, items: requiredObjectSchema({
        entityId: opaqueId("Exact Entity Registry identity."),
        entityType: { type: "string", enum: ["person", "organization", "account", "project"] },
        label: text(1, 240),
        relationship: { type: "string", enum: ["customer", "account", "participant", "subject", "related"] },
      }, ["entityId", "entityType", "label", "relationship"]),
    },
    decisions: {
      type: "array", maxItems: 250, items: requiredObjectSchema({
        decisionId: opaqueId("Meeting-local decision identity."),
        summary: text(1, 2_000),
        ownerParticipantId: { anyOf: [participantId, { type: "null" }] },
        sourceLinkId: { anyOf: [sourceLinkId, { type: "null" }] },
      }, ["decisionId", "summary"]),
    },
    commitments: {
      type: "array", maxItems: 250, items: requiredObjectSchema({
        commitmentId: opaqueId("Meeting-local commitment identity."),
        summary: text(1, 2_000),
        ownerParticipantId: { anyOf: [participantId, { type: "null" }] },
        dueAt: { type: ["string", "null"], format: "date-time" },
        sourceLinkId: { anyOf: [sourceLinkId, { type: "null" }] },
      }, ["commitmentId", "summary"]),
    },
    followUps: {
      type: "array", maxItems: 250, items: requiredObjectSchema({
        followUpId: opaqueId("Meeting-local follow-up identity."),
        label: text(1, 500),
        status: { type: "string", enum: ["proposed", "accepted", "completed", "dismissed"] },
        workItemId: { type: ["string", "null"], maxLength: 240 },
        draftId: { type: ["string", "null"], maxLength: 240 },
        commitmentId: { type: ["string", "null"], maxLength: 240 },
      }, ["followUpId", "label", "status"]),
    },
  };
}

function customerAccountLifecycleValues() {
  return ["prospect", "onboarding", "active", "at_risk", "churned", "archived"];
}

function customerSuccessWorkflowInputToolSchema() {
  const workflowId = (value: string) => ({ type: "string", enum: [value] });
  const objective = text(1, 2_000);
  const targetDate = { type: ["string", "null"], format: "date-time" };
  const textList = (maxItems = 20) => ({
    type: "array", minItems: 1, maxItems, items: text(1, 500),
  });
  const optionalTextList = (maxItems = 20, maxLength = 240) => ({
    type: "array", maxItems, items: text(1, maxLength),
  });
  const requiredIds = (maxItems = 50) => ({
    type: "array", minItems: 1, maxItems, uniqueItems: true,
    items: opaqueId("Exact Account 360, meeting, case, or stakeholder identity."),
  });
  const optionalIds = (maxItems = 50) => ({
    ...requiredIds(maxItems), minItems: 0,
  });
  const base = { objective, targetDate };
  return {
    anyOf: [
      requiredObjectSchema({
        workflowId: workflowId("onboarding"), ...base,
        successCriteria: textList(),
        productNames: optionalTextList(),
        stakeholderIds: optionalIds(),
      }, ["workflowId", "objective", "successCriteria"]),
      requiredObjectSchema({
        workflowId: workflowId("adoption_review"), ...base,
        periodStartAt: { type: "string", format: "date-time" },
        periodEndAt: { type: "string", format: "date-time" },
        adoptionGoals: textList(),
        productIds: optionalIds(20),
      }, ["workflowId", "objective", "periodStartAt", "periodEndAt", "adoptionGoals"]),
      requiredObjectSchema({
        workflowId: workflowId("risk_escalation"), ...base,
        riskTitle: text(1, 500),
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        signals: textList(),
        executiveSponsorId: { anyOf: [opaqueId("Optional executive sponsor identity."), { type: "null" }] },
      }, ["workflowId", "objective", "riskTitle", "severity", "signals"]),
      requiredObjectSchema({
        workflowId: workflowId("renewal_planning"), ...base,
        renewalAt: { type: "string", format: "date-time" },
        renewalGoals: textList(),
        amountMinor: { type: ["integer", "null"], minimum: 0 },
        currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
      }, ["workflowId", "objective", "renewalAt", "renewalGoals"]),
      requiredObjectSchema({
        workflowId: workflowId("qbr_ebr"), ...base,
        reviewKind: { type: "string", enum: ["qbr", "ebr"] },
        meetingAt: { type: "string", format: "date-time" },
        periodStartAt: { type: "string", format: "date-time" },
        periodEndAt: { type: "string", format: "date-time" },
        audience: textList(),
        agendaObjectives: textList(),
      }, ["workflowId", "objective", "reviewKind", "meetingAt", "periodStartAt", "periodEndAt", "audience", "agendaObjectives"]),
      requiredObjectSchema({
        workflowId: workflowId("meeting_prep_follow_up"), ...base,
        meetingId: opaqueId("Exact governed meeting identity."),
        phase: { type: "string", enum: ["prep", "follow_up"] },
        participantIds: requiredIds(),
        meetingObjectives: textList(),
      }, ["workflowId", "objective", "meetingId", "phase", "participantIds", "meetingObjectives"]),
      requiredObjectSchema({
        workflowId: workflowId("support_escalation"), ...base,
        caseIds: requiredIds(),
        severity: { type: "string", enum: ["medium", "high", "critical"] },
        customerImpact: text(1, 2_000),
        requestedOutcome: text(1, 1_000),
      }, ["workflowId", "objective", "caseIds", "severity", "customerImpact", "requestedOutcome"]),
      requiredObjectSchema({
        workflowId: workflowId("expansion_discovery"), ...base,
        hypotheses: textList(),
        stakeholderIds: requiredIds(),
        discoveryWindowEndAt: { type: "string", format: "date-time" },
      }, ["workflowId", "objective", "hypotheses", "stakeholderIds", "discoveryWindowEndAt"]),
    ],
  };
}

function customerAccountIdSchema() {
  return { type: "string", pattern: "^customer-account:[a-f0-9]{64}$", maxLength: 81 };
}

function customerFactIdSchema() {
  return { type: "string", pattern: "^customer-fact:[a-f0-9]{64}$", maxLength: 78 };
}

function customerDataPurposesToolSchema() {
  return {
    type: "array",
    minItems: 2,
    maxItems: 5,
    uniqueItems: true,
    items: {
      type: "string",
      enum: [
        "customer_success.account.read",
        "customer_success.account.manage",
        "customer_success.meeting_follow_up",
        "customer_success.analytics",
        "customer_success.crm_sync",
      ],
    },
  };
}

function customerFactOwnerToolSchema() {
  return requiredObjectSchema({
    ownerKind: { type: "string", enum: ["actor", "person", "organization", "team", "system"] },
    ownerId: opaqueId("Exact semantic owner identity."),
    displayName: text(1, 180),
  }, ["ownerKind", "ownerId", "displayName"]);
}

function customerFactSourceToolSchema() {
  return requiredObjectSchema({
    sourceKind: { type: "string", enum: ["manual", "meeting", "project", "work_item", "connected_source", "crm", "computed"] },
    sourceId: opaqueId("Exact source identity."),
    sourceRevisionId: opaqueId("Exact immutable source revision identity."),
    sourceRevisionSha256: sha256("Exact immutable source revision digest."),
    sourceLabel: text(1, 240),
    providerId: { type: ["string", "null"], maxLength: 240 },
    providerObjectType: { type: ["string", "null"], maxLength: 120 },
    providerObjectIdSha256: { anyOf: [sha256("Hashed external provider object identity."), { type: "null" }] },
    permissionBasis: { type: "string", enum: ["operator_assertion", "workspace_membership", "project_membership", "connector_grant", "derived_from_cited_evidence"] },
    allowedPurposeIds: {
      ...customerDataPurposesToolSchema(),
      minItems: 1,
    },
    observedAt: { type: "string", format: "date-time" },
    ingestedAt: { type: "string", format: "date-time" },
  }, [
    "sourceKind", "sourceId", "sourceRevisionId", "sourceRevisionSha256",
    "sourceLabel", "providerId", "providerObjectType", "providerObjectIdSha256",
    "permissionBasis", "allowedPurposeIds", "observedAt", "ingestedAt",
  ]);
}

function customerFactValueToolSchema() {
  const entity = {
    entityId: opaqueId("Exact ontology entity identity."),
    name: text(1, 240),
  };
  const money = {
    amountMinor: { type: ["integer", "null"], minimum: 0 },
    currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
  };
  return {
    anyOf: [
      requiredObjectSchema({ kind: { type: "string", enum: ["organization"] }, ...entity, industry: { type: ["string", "null"], maxLength: 160 }, website: { type: ["string", "null"], format: "uri", maxLength: 2_000 } }, ["kind", "entityId", "name", "industry", "website"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["contact"] }, ...entity, email: { type: ["string", "null"], format: "email", maxLength: 320 }, title: { type: ["string", "null"], maxLength: 180 } }, ["kind", "entityId", "name", "email", "title"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["stakeholder"] }, ...entity, role: text(1, 180), influence: { type: "string", enum: ["low", "medium", "high", "unknown"] }, stance: { type: "string", enum: ["champion", "supportive", "neutral", "detractor", "unknown"] } }, ["kind", "entityId", "name", "role", "influence", "stance"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["product"] }, ...entity, status: { type: "string", enum: ["trial", "active", "paused", "ended", "unknown"] }, quantity: { type: ["number", "null"], minimum: 0 } }, ["kind", "entityId", "name", "status", "quantity"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["opportunity"] }, ...entity, stage: text(1, 120), ...money, expectedCloseAt: { type: ["string", "null"], format: "date-time" } }, ["kind", "entityId", "name", "stage", "amountMinor", "currency", "expectedCloseAt"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["case"] }, entityId: entity.entityId, title: text(1, 500), status: text(1, 120), severity: { type: "string", enum: ["low", "medium", "high", "critical", "unknown"] } }, ["kind", "entityId", "title", "status", "severity"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["usage"] }, metricId: opaqueId("Stable usage metric identity."), label: text(1, 240), value: { type: "number" }, unit: text(1, 80), periodStartAt: { type: "string", format: "date-time" }, periodEndAt: { type: "string", format: "date-time" } }, ["kind", "metricId", "label", "value", "unit", "periodStartAt", "periodEndAt"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["project"] }, projectId: opaqueId("Canonical or compatible project identity."), name: text(1, 240), status: text(1, 120) }, ["kind", "projectId", "name", "status"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["interaction"] }, interactionId: opaqueId("Stable interaction identity."), channel: { type: "string", enum: ["meeting", "email", "call", "message", "support", "other"] }, summary: text(1, 4_000), occurredAt: { type: "string", format: "date-time" } }, ["kind", "interactionId", "channel", "summary", "occurredAt"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["health"] }, dimension: text(1, 120), status: { type: "string", enum: ["healthy", "watch", "at_risk", "unknown"] }, scoreBasisPoints: { type: ["integer", "null"], minimum: 0, maximum: 10_000 }, summary: text(1, 2_000) }, ["kind", "dimension", "status", "scoreBasisPoints", "summary"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["risk"] }, entityId: entity.entityId, title: text(1, 500), severity: { type: "string", enum: ["low", "medium", "high", "critical"] }, status: { type: "string", enum: ["open", "mitigating", "resolved"] } }, ["kind", "entityId", "title", "severity", "status"]),
      requiredObjectSchema({ kind: { type: "string", enum: ["renewal"] }, renewalId: opaqueId("Stable renewal identity."), status: { type: "string", enum: ["unplanned", "planning", "proposed", "committed", "renewed", "lost"] }, renewalAt: { type: "string", format: "date-time" }, ...money }, ["kind", "renewalId", "status", "renewalAt", "amountMinor", "currency"]),
    ],
  };
}

function sha256(description: string) {
  return { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$", description };
}

function trashPreviewContract(resourceType?: string) {
  return requiredObjectSchema({
    version: { type: "string", enum: ["p9.3-trash-preview:1"] },
    action: { type: "string", enum: ["trash"] },
    trashId: { type: "null" },
    resourceType: {
      type: "string",
      enum: resourceType
        ? [resourceType]
        : ["mcp_connector", "openapi_connector"],
    },
    resourceId: opaqueId("Exact resource ID."),
    lifecycleRevision: { type: "integer", enum: [0] },
    targetSha256: sha256("Digest of the exact previewed target."),
    effectSummary: text(1, 500),
    reversible: { type: "boolean", enum: [true] },
    issuedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    previewSha256: sha256("Self-verifying digest returned by the preview operation."),
  }, [
    "version", "action", "trashId", "resourceType", "resourceId",
    "lifecycleRevision", "targetSha256", "effectSummary", "reversible",
    "issuedAt", "expiresAt", "previewSha256",
  ]);
}

function trashLifecyclePreviewContract(action: "restore" | "purge") {
  return requiredObjectSchema({
    version: { type: "string", enum: ["p9.3-trash-preview:1"] },
    action: { type: "string", enum: [action] },
    trashId: trashId(),
    resourceType: {
      type: "string",
      enum: [
        "custom_agent", "agent_skill", "mcp_connector", "openapi_connector",
      ],
    },
    resourceId: opaqueId("Exact resource ID."),
    lifecycleRevision: integer(1, Number.MAX_SAFE_INTEGER),
    targetSha256: sha256("Digest of the exact trashed target."),
    effectSummary: text(1, 500),
    reversible: { type: "boolean", enum: [action === "restore"] },
    issuedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    previewSha256: sha256("Self-verifying digest returned by the lifecycle preview operation."),
  }, [
    "version", "action", "trashId", "resourceType", "resourceId",
    "lifecycleRevision", "targetSha256", "effectSummary", "reversible",
    "issuedAt", "expiresAt", "previewSha256",
  ]);
}

function trashId() {
  return {
    type: "string",
    pattern: "^trash:[0-9a-f-]{36}$",
    maxLength: 42,
    description: "Exact trash item ID.",
  };
}

function idList(maxItems = 50) {
  return { type: "array", maxItems, uniqueItems: true, items: text(1, 120) };
}

function skillProperties(): Record<string, unknown> {
  return {
    name: text(2, 120), description: text(2, 500), instructions: text(10, 12_000),
    category: { type: "string", enum: ["research", "creation", "analysis", "memory", "automation", "personal"] },
    status: { type: "string", enum: ["active", "disabled"], default: "active" },
    toolIds: idList(), tags: { type: "array", maxItems: 30, uniqueItems: true, items: text(1, 100) },
    knowledgeTags: { type: "array", maxItems: 30, uniqueItems: true, items: text(1, 100) },
  };
}

function agentProperties(): Record<string, unknown> {
  return {
    name: text(2, 120), role: text(2, 120), description: text(2, 700), instructions: text(10, 12_000),
    status: { type: "string", enum: ["ready", "learning", "paused"], default: "ready" },
    accent: { type: "string", enum: ["emerald", "blue", "amber", "violet", "rose"], default: "emerald" },
    modelPolicy: { type: "string", enum: ["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"], default: "auto" },
    autonomy: { type: "string", enum: ["assist", "governed", "execute"], default: "governed" },
    approvalPolicy: { type: "string", enum: ["always", "risk_based", "read_only"], default: "risk_based" },
    memoryScope: { type: "string", enum: ["session", "project", "all"], default: "all" },
    skillIds: idList(MAX_ASSIGNED_SKILLS), toolIds: idList(),
  };
}

function workflowMode() {
  return { type: "string", enum: ["orchestrate", "research", "execute", "learn"], default: "orchestrate" };
}

function workflowBudgetsSchema() {
  return objectSchema({
    toolCalls: integer(0, 1_000), modelCalls: integer(0, 1_000),
    costUnits: integer(0, 1_000_000), elapsedMs: integer(0, 86_400_000),
  });
}

function connectorKind() {
  return { type: "string", enum: ["mcp", "openapi"] };
}

function modelProvider() {
  return { type: "string", enum: ["openai", "google", "anthropic", "aws_bedrock"] };
}

function serviceApiScopes() {
  return {
    type: "array", uniqueItems: true, maxItems: 12,
    items: { type: "string", enum: ["mcp:discover", "mcp:tools:list", "mcp:tools:execute", "a2a:discover", "a2a:tasks:read", "a2a:tasks:write", "missions:read", "missions:write", "memory:read", "memory:write", "runs:read", "settings:read"] },
  };
}

function assetKind() {
  return { type: "string", enum: ["asset", "recording"] };
}

function recordingProperties(): Record<string, unknown> {
  return {
    title: text(0, 240), language: text(0, 35),
    tags: { type: "array", maxItems: 50, uniqueItems: true, items: text(1, 80) },
  };
}

function presentationArtifactToolSchema() {
  const speakerNotes = presentationMultiline(1, 2_000);
  const bullet = presentationMultiline(1, 120);
  const columnBullet = presentationMultiline(1, 110);
  const column = {
    ...requiredObjectSchema({
      heading: presentationSingleLine(64),
      body: presentationMultiline(1, 260),
      bullets: { type: "array", minItems: 1, maxItems: 4, items: columnBullet },
    }, ["heading"]),
    anyOf: [{ required: ["body"] }, { required: ["bullets"] }],
  };
  const slides = {
    type: "array",
    minItems: 2,
    maxItems: 24,
    items: {
      anyOf: [
        requiredObjectSchema({
          kind: { type: "string", enum: ["title"] },
          title: presentationSingleLine(100),
          subtitle: presentationMultiline(1, 240),
          eyebrow: presentationSingleLine(64),
          speakerNotes,
        }, ["kind", "title"]),
        requiredObjectSchema({
          kind: { type: "string", enum: ["section"] },
          title: presentationSingleLine(90),
          subtitle: presentationMultiline(1, 260),
          speakerNotes,
        }, ["kind", "title"]),
        {
          ...requiredObjectSchema({
            kind: { type: "string", enum: ["content"] },
            title: presentationSingleLine(90),
            kicker: presentationSingleLine(64),
            body: presentationMultiline(1, 420),
            bullets: { type: "array", minItems: 1, maxItems: 5, items: bullet },
            speakerNotes,
          }, ["kind", "title"]),
          anyOf: [{ required: ["body"] }, { required: ["bullets"] }],
        },
        requiredObjectSchema({
          kind: { type: "string", enum: ["two_column"] },
          title: presentationSingleLine(90),
          subtitle: presentationMultiline(1, 260),
          left: column,
          right: column,
          speakerNotes,
        }, ["kind", "title", "left", "right"]),
        requiredObjectSchema({
          kind: { type: "string", enum: ["quote"] },
          title: presentationSingleLine(90),
          quote: presentationMultiline(1, 360),
          attribution: presentationSingleLine(100),
          role: presentationSingleLine(100),
          speakerNotes,
        }, ["kind", "title", "quote", "attribution"]),
        requiredObjectSchema({
          kind: { type: "string", enum: ["metrics"] },
          title: presentationSingleLine(90),
          subtitle: presentationMultiline(1, 260),
          metrics: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: requiredObjectSchema({
              value: presentationSingleLine(24),
              label: presentationSingleLine(56),
              detail: presentationMultiline(1, 120),
            }, ["value", "label"]),
          },
          speakerNotes,
        }, ["kind", "title", "metrics"]),
        requiredObjectSchema({
          kind: { type: "string", enum: ["closing"] },
          title: presentationSingleLine(90),
          subtitle: presentationMultiline(1, 260),
          callToAction: presentationSingleLine(120),
          contact: presentationSingleLine(120),
          speakerNotes,
        }, ["kind", "title"]),
      ],
    },
  };
  return requiredObjectSchema({
    title: presentationSingleLine(120),
    subtitle: presentationMultiline(1, 280),
    theme: { type: "string", enum: ["light", "dark", "aurora"] },
    slides,
  }, ["title", "theme", "slides"]);
}

function presentationSingleLine(maxLength: number) {
  return {
    type: "string",
    minLength: 1,
    maxLength,
    pattern: "^[^\\r\\n\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]+$",
  };
}

function presentationMultiline(minLength: number, maxLength: number) {
  return {
    type: "string",
    minLength,
    maxLength,
    pattern: "^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]+$",
  };
}

function grantId() {
  return { type: "string", pattern: "^(context|capability):[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$", maxLength: 240 };
}

function agentGrantSchema() {
  const target = requiredObjectSchema({
    visibility: { type: "string", enum: ["agent_private", "user_private", "mission_shared", "project_shared", "workspace_shared"] },
    resourceIds: { type: "array", minItems: 1, maxItems: 128, uniqueItems: true, items: opaqueId("Exact resource ID.") },
    workspaceId: { type: ["string", "null"] }, projectId: { type: ["string", "null"] }, missionId: { type: ["string", "null"] },
  }, ["visibility", "resourceIds", "workspaceId", "projectId", "missionId"]);
  return requiredObjectSchema({
    schemaVersion: { type: "integer", enum: [1] }, grantKind: { type: "string", enum: ["context", "capability"] },
    purposeId: { type: "string", enum: ["memory.read.v1", "memory.retrieve.v1", "memory.write.v1", "memory.correct.v1", "memory.forget.v1", "memory.formation.v1", "memory.maintenance.v1", "memory.export.v1"] },
    target, expiresAt: { type: "string", format: "date-time" }, maxItems: integer(1, 1_000), maxBytes: integer(1, 10_000_000),
    operationIds: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" } },
    maxInvocations: integer(1, 10_000), maxCostMicrousd: integer(1, 100_000_000), maxDurationMs: integer(1, 3_600_000),
  }, ["schemaVersion", "grantKind", "purposeId", "target", "expiresAt"]);
}
