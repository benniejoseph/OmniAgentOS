# Salesforce CSM work: research and workspace recommendations

Research checked on **7 October 2026** against public Salesforce sources. This
document supports a workspace for a Salesforce Secondary CSM who sometimes acts
as Lead CSM, advocates for customers, and coordinates their Salesforce experience.
The workspace receives user-supplied recordings, screenshots, transcripts, decks,
and documents; it has **no Salesforce org connection**.

Sections describing Salesforce offerings summarize public documentation.
Workspace fields, workflows, and templates below are **product design
recommendations**, not Salesforce internal procedures. Public product pages and
career descriptions do not establish a particular customer's contracted coverage,
service availability, staffing, approval chain, or response commitment.

## What the public guidance establishes

### Success Plan, Success Path, and Success Review are different concepts

**Success Plans** are Salesforce's service offerings: Standard, Premier, and
Signature. Broadly, they progress from self-service resources to expert guidance
and a proactive personalized partnership. Store the customer's stated plan
separately from the workspace's work plan, and allow “Unknown” until evidence is
available. [Salesforce Success Plans](https://www.salesforce.com/services/success-plans/)

For **Signature**, Salesforce describes the designated CSM as the customer's
advocate and coordination point across Success Architects, Success Guides,
product teams, Support Engineers, and the Critical Incident team. After onboarding,
the customer and CSM build a **Success Path** connecting business objectives to
product capabilities, recommendations, and KPIs. **Success Reviews** revisit that
roadmap, Customer Success Score, monitoring recommendations, and support metrics.
Salesforce recommends four reviews annually in this public guidance; the app
should store the actual agreed cadence instead of manufacturing calendar
commitments. [Signature Success Plan resources](https://help.salesforce.com/s/articleView?id=000395788&language=en_US&type=1)

Success Paths are also relevant to **Premier**. Its public review guidance
describes a Success Guide reviewing goals, refining recommendations, and updating
the Success Path with business and technical stakeholders. It describes up to two
Success Reviews per year. The app should therefore make the planning artifact
usable independently of the selected service tier.
[Premier Success Reviews](https://help.salesforce.com/s/success-reviews?language=en_US)

### CSM work combines outcomes, adoption, technical context, and coordination

Salesforce describes CSM work as understanding the customer's business and
environment, helping adoption, improving platform efficiency, bringing in
specialists, and reducing disruption. Its examples include unused capabilities,
integrations, technical debt, data hygiene, release readiness, and preparation for
important business events. These establish useful areas for organizing context;
they do not make this app an org diagnostic tool.
[Working with a CSM](https://help.salesforce.com/s/articleView?id=000393050&language=en_US&type=1)

The Signature offering also lists annual technical reviews, architecture guidance,
monitoring, event support, and education. These are potential engagement topics,
not automatically verified benefits for every product or account. Keep
“recommended,” “eligibility to confirm,” “requested,” “scheduled,” and “delivered”
as distinct engagement states.
[Signature Success Plan](https://www.salesforce.com/services/success-plans/signature/)

### An official Customer Success Score must stay distinct from local observations

Salesforce's FAQ says score availability depends on the plan, product, and access
conditions. Scores are reported for an org or realm, with no rolled-up multi-org
view in the documented experience, and refreshed periodically. A supplied score
needs its org/realm label, reporting period, capture date, and source. A screenshot
is a dated observation, not a live feed.
[Customer Success Score FAQ](https://help.salesforce.com/s/articleView?id=000396262&language=en_US&type=1)

Salesforce's learning material groups guidance around **Product Adoption,
Customer Expertise, and Technical Health**, and recommends prioritizing signals
that matter to business outcomes instead of pursuing a perfect score. These are
useful optional categories. Asael should not label its own inferred sentiment,
task completion, or risk rating as an official Salesforce Customer Success Score.
[Customer Success Score guidance](https://trailhead.salesforce.com/content/learn/modules/customer-success-score/dive-deeper-and-improve-your-score)

## People and coordination boundaries

The documented responsibilities below inform a configurable stakeholder map.
Names, coverage, decision authority, and engagement ownership must come from the
user's account context. A role title alone must not grant application permissions.

| Role | Publicly documented emphasis | Suggested workspace use |
| --- | --- | --- |
| Customer Success Manager | Advocacy, contextual technical guidance, and coordination of the Signature experience. [Signature resources](https://help.salesforce.com/s/articleView?id=000395788&language=en_US&type=1) | Record the customer's priorities, relationship context, commitments, and the specialist needed for each issue. |
| Account Executive / specialist AE | Public Salesforce hiring material describes sales-cycle ownership, account strategy, stakeholder relationships, and coordination with other Salesforce resources. It does not establish one universal renewal ownership model. [Commercial AE role](https://careers.salesforce.com/en/jobs/jr293226/commercial-account-executive-canada/) | Identify the actual commercial contact; route licensing, scope, or commercial questions as drafts for that contact. |
| Success Guide / Onboarding Specialist | Premier documentation describes product guidance, onboarding alignment, and Success Reviews; its review page explicitly identifies the Success Guide. [Premier resources](https://help.salesforce.com/s/articleView?id=000346616&language=en_US&type=2), [Success Reviews](https://help.salesforce.com/s/success-reviews?language=en_US) | Track coaching needs, prerequisites, intended outcomes, and resulting recommendations. |
| Technical Account Manager (TAM) | An older Salesforce employee profile describes technical advisory work, cases/escalations, major events, and deployment governance. Current general Signature pages use CSM terminology. This does not prove TAM is universally renamed, assigned, or included. [Salesforce TAM profile](https://www.salesforce.com/blog/crafting-a-career-centered-on-customer-success/) | Offer TAM as an optional stakeholder label and preserve the title supplied by the user. |
| Success Architect | A current Salesforce role description emphasizes solution design, scalability, security, technical health, collaboration with CSMs and support, and product feedback. A job description is evidence of role emphasis, not a service entitlement. [Success Architect role](https://careers.salesforce.com/en/jobs/jr322959/salesforce-success-architect/) | Prepare a focused architecture question, environment summary, business impact, prior findings, and decision needed. |
| Support Engineer / Critical Incident team | Signature guidance identifies technical support and urgent incident resources. Published response language depends on the issue and offering. [Signature resources](https://help.salesforce.com/s/articleView?id=000395788&language=en_US&type=1) | Record supplied case references, impact, observed status, current owner, latest update, and next follow-up. No invented case severity, response deadline, or resolution promise. |
| Salesforce Professional Services / certified partner | Salesforce describes tailored planning, implementation, optimization, and transformation work; certified partners provide additional industry and delivery expertise. [Professional Services](https://www.salesforce.com/services/professional-services/) | Track the actual engagement scope, deliverables, dependencies, and handoffs. Do not treat CSM advice as an implementation commitment. |
| Customer business and technical leaders | Salesforce asks for business and technical leaders in Success Reviews to align and prioritize recommendations. [Success Reviews](https://help.salesforce.com/s/success-reviews?language=en_US) | Record the sponsor, business owner, technical owner, admin, and operational contacts where known; keep unknown owners explicit. |

**Lead and Secondary CSM:** the sources reviewed do not establish a universal
public responsibility split. Model this as the user's assignment per customer,
with explicit owned workstreams, counterpart, coverage dates, and escalation or
handoff preferences. A Secondary CSM can own specific actions without the system
silently making them the account's final decision maker. When acting as Lead, the
user can choose the broader coordination brief and customer-facing plan view.

## Recommended client workspace data

These fields are an Asael design proposal for working from supplied evidence.

| Record | Minimum useful fields |
| --- | --- |
| Client profile | Name, industry, timezone, business context, products/clouds as stated, environment/org labels when supplied, my Lead/Secondary assignment, counterpart, plan tier and verification source. |
| Evidence item | File or note, type, title, client, event date, upload date, author/speaker where known, page/slide/timestamp locator, extraction status, sensitivity and sharing scope. |
| Goal / Success Path item | Customer outcome, business owner, baseline and target if known, metric definition, reporting period, milestone, product relevance, recommendations, dependencies, review date, source. |
| Stakeholder | Name, organization, role, responsibility, influence/decision authority if explicitly known, engagement preference, last confirmed date. |
| Commitment / action | Specific next step, owner, due date or “not agreed,” origin meeting/source, goal, status, dependency, completion evidence, and whether it is a proposal or an accepted commitment. |
| Risk / open question | Observed issue, customer impact, evidence, uncertainty, accountable owner, mitigation, next checkpoint, escalation need. A local assessment must identify its author and rationale. |
| Engagement | Coaching/review/architecture/event topic, desired outcome, proposed specialist, eligibility status, request state, schedule, prerequisites, follow-through. |
| Support observation | User-supplied case reference, affected service, business impact, supplied severity/status, latest update time, next follow-up, source. |
| Metric observation | Exact metric name, value/unit, baseline or comparison, period, environment scope, capture time, source, and whether it is an official supplied metric or a local assessment. |
| Decision / relationship history | Decision, participants, date, rationale the participants actually recorded, superseded decision, and source; preserve conflicting accounts for review. |

Every extracted fact should retain provenance. Distinguish **stated in source**,
**confirmed by user**, **suggested by agent**, and **unknown**. Missing or old data
should lead to a focused follow-up task, not a fabricated value or a healthy
default. A recording's meeting date and a document's upload date are different.

## Dedicated CSM agent outputs

The agent's job is to prepare, connect context, and help the CSM follow through.
It should use only the selected client's authorized evidence plus clearly labeled
public reference material. These are proposed capabilities, not claims that an
ingestion, transcription, scheduling, or external messaging feature already exists.

1. **Client brief:** current outcomes, recent developments, stakeholder context,
   upcoming milestones, open risks, and three useful next steps. Cite source
   locators and show what is missing.
2. **Meeting preparation:** the meeting's purpose, prior commitments, relevant
   changes, audience-specific questions, decisions needed, and an agenda.
3. **Meeting follow-through:** a concise recap; separate decisions, customer
   commitments, Salesforce commitments, proposed actions, and unanswered
   questions. Preserve uncertain speakers or dates for confirmation.
4. **Success Path draft:** map each customer goal to a recommendation, owner,
   measure, milestone, dependency, and next review. Do not invent a baseline,
   target, ROI, entitlement, or customer agreement.
5. **Success Review preparation:** progress against goals, evidence of value,
   dated adoption/expertise/technical observations, risks, recommendations,
   changed priorities, and decisions for the customer.
6. **Specialist or escalation brief:** customer impact, evidence timeline,
   work already performed, exact question or decision, relevant contact, and
   what information is still needed. Draft requests; do not claim they were sent.
7. **Lead/Secondary handoff:** my owned work, counterpart-owned work, decisions
   needed from the Lead, commitments due before the next touchpoint, coverage
   gaps, and a concise handoff note.
8. **Proactive work queue:** surface explicit overdue commitments, upcoming
   agreed milestones, missing owners, unresolved questions, and stale evidence.
   Explain each suggestion with a reason and source. Let the user accept,
   change, defer, or dismiss it; deduplicate repeated suggestions.

Proactivity means reasoning over stored dates and evidence within an authorized
workflow. It must not imply live org monitoring, autonomous Salesforce case
updates, customer outreach, or scheduled execution that has not been configured.
All actual tool actions stay within Asael's governed executor and client/tenant
scope. Retrieved material remains evidence, never an instruction to change
permissions or contact a third party.

## Starter templates

### Client onboarding and context checklist

- Confirm the client's business priorities and the user's Lead/Secondary scope.
- Record the known stakeholder map and the counterpart CSM, if any.
- Add the latest supplied Success Path, review deck, meeting transcript, and
  architecture/context documents.
- Record products and environment labels, plan tier evidence, major events,
  agreed cadence, and owned workstreams where known.
- Identify missing context and create a short, owner-assigned request list.

### Success Path row

| Outcome | Why it matters | Baseline → target | Recommendation | Owner | Milestone | Dependency | Evidence / next review |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Customer-stated outcome | Supplied business impact | Known values or “to confirm” | Proposed or agreed action | Named person or unknown | Agreed date or unscheduled | Prerequisite | Source locator and review date |

### Meeting-to-action note

```text
Client / meeting / date / participants:
Purpose and customer priorities:
Confirmed decisions [source locator]:
Commitments [action; owner; agreed due date; source locator]:
Proposed next steps [reason; proposed owner; no implied agreement]:
Risks or blockers [impact; evidence; uncertainty]:
Questions to resolve:
Updates proposed for the Success Path:
Draft follow-up for the CSM to review:
```

### Specialist handoff

```text
Customer goal and affected business process:
Observed issue and business impact:
Product/environment scope as supplied:
Evidence timeline and supplied case/reference:
Work already done and result:
Specific expertise, decision, or help requested:
Relevant customer and Salesforce contacts:
Known prerequisites / eligibility to confirm:
Next customer commitment and CSM follow-up:
```

### Success Review checklist

- Confirm participants, meeting objective, and the current Success Path.
- Gather evidence of completed recommendations and customer outcomes.
- Date and scope every supplied metric, support update, and technical finding.
- Review changed goals, risks, dependencies, and outstanding commitments.
- Prepare a small set of prioritized recommendations and explicit decisions.
- Record agreed owners, dates, and the next review after the meeting.

The workspace should start with real customer evidence and clearly empty states.
Examples must be labeled as examples. No demo accounts, fabricated usage
telemetry, automatic “healthy” classifications, or unverified Salesforce service
promises should be presented as the user's actual client portfolio.
