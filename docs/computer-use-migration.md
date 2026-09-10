# Computer Use migration

Status: staged adoption · 2026-09-10

## Decision

Use Asael's tenant-, actor-, and task-scoped Playwright MCP service as the
primary Computer Use execution runtime. Treat the Browser Use connector as a
disabled fallback after canary validation; do not remove the isolated browser
runtime, browser action policy, observation redaction, approval gates, or
session persistence.

Computer Use is an agent control strategy, not a replacement for the browser
or desktop runtime it drives. The model route is selected through Settings
scope `computer_use`; execution remains inside the governed tool executor and
the existing scoped Playwright boundary. A task persona can guide behavior but
cannot grant tools, context, budget, credentials, or approval authority.

## Evidence

- OpenAI's current model guide identifies GPT-6 Astra as supporting Computer
  Use and multi-agent orchestration:
  <https://developers.openai.com/api/docs/guides/latest-model>
- OpenAI's Computer Use guide recommends an isolated persistent environment,
  explicit permissions and limits, and a Playwright or desktop runtime driven
  through code execution:
  <https://developers.openai.com/api/docs/guides/tools-computer-use>
- Browser Use is itself a browser-agent and runtime layer, so replacing it does
  not eliminate the underlying browser requirement:
  <https://github.com/browser-use/browser-use>
- Asael already operates the official Microsoft Playwright MCP server in an
  isolated Fly service:
  <https://github.com/microsoft/playwright-mcp>

## Boundaries

1. The current UTC clock is injected into the Main Agent, Council members,
   semantic router, workflow planner, verifier, and workflow node agent. Live
   web search is selected when a request contains time-sensitive or explicit
   research intent. Web results, screen observations, and remote tool output
   remain untrusted evidence.
2. Every Computer Use action continues through the governed executor. Safe
   navigation and inspection remain low risk; form submission, upload,
   authentication, financial, destructive, or arbitrary-code actions retain
   their existing approval and risk classification.
3. The `computer_use` model assignment is tenant-configurable. No provider
   model name is embedded in an agent persona or tool contract.
4. Browser profiles, screenshots, accessibility snapshots, and session state
   remain owner-scoped and bounded by the existing P9.5/P9.6 contracts.
5. The Browser Use connector remains supported during rollback but is not the
   recommended new connection.

## Canary and removal gate

Run a fixed set of authenticated read, navigation, multi-tab, form, upload,
resume, timeout, prompt-injection, and approval-boundary tasks against the
Computer Use runtime. Removal of Browser Use requires all of the following:

- task success is at least equal to the Browser Use baseline;
- zero tenant, actor, task, profile, or credential boundary violations;
- no unapproved consequential effects and no false success receipts;
- bounded wall time, browser actions, model turns, and retained observations;
- successful reconnect/resume and forced-timeout cleanup;
- rollback verified by re-enabling the existing connector without schema or
  data migration.

Until that gate passes in production, the migration is additive and
reversible. Deleting Browser Use-specific connector support is a later cleanup,
not part of this release.
