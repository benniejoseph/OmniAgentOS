/** Discovery hints only. These IDs never widen the caller's allowed toolbox. */
export function requestsConversationalResearch(query: string | undefined) {
  const text = query?.toLowerCase() || "";
  if (/\b(?:status|progress|cancel|stop|pause|resume|previous|last|finished)\b.{0,32}\bresearch\b|\bresearch\b.{0,24}\b(?:status|progress|finished)\b/.test(text)) return false;
  return /\b(?:deep research|deep dive (?:on|into)|research (?:on|about|how|why|whether|the|a|an|this|that)|(?:do|start|conduct|perform|run)\b.{0,24}\bresearch|research\b.{0,50}\b(?:report|multiple sources|in depth))\b/.test(text);
}

/** Keep readable-name resolvers beside the actions they make usable. */
export function conversationControlToolPreferences(query: string | undefined): string[] {
  const text = query?.toLowerCase() || "";
  const ids = new Set<string>();
  const add = (...tools: string[]) => tools.forEach(id => ids.add(id));
  const changing = /\b(?:add|create|update|edit|change|set|mark|complete|move|rename|remove|delete|forget|save|remember|install|enable|disable|uninstall|link|attach|cancel|pause|resume|start|run)\b/.test(text);
  if (/\b(?:connections?|integrations?|connectors?|connected|sync(?:ing)?|gmail|calendar|drive)\b/.test(text)) {
    add("app.integrations.overview.show", "app.sources.coverage.show", "app.connectors.list", "app.connectors.show");
    if (changing) add("app.connectors.update", "app.connectors.refresh", "app.connectors.register", "app.connectors.review");
    if (/\b(?:remove|delete|trash)\b/.test(text)) add("app.connectors.delete.preview", "app.connectors.delete");
  }
  if (/\b(?:plugins?|extensions?)\b/.test(text)) {
    add("app.plugins.list");
    if (/\b(?:install|add|preview)\b/.test(text)) add("app.plugins.preview", "app.plugins.install");
    for (const action of ["enable", "disable", "uninstall"] as const) {
      if (text.includes(action)) add(`app.plugins.${action}`);
    }
  }
  if (/\b(?:consumption|usage|tokens?|spend|spent|costs?|billing|credits?)\b/.test(text)) add("app.usage.summary.show");
  if (/\b(?:about me|my profile|my preferences|my name|call me|who i am|how i work|what you know about me)\b/.test(text)) {
    add("app.personal_profile.show");
    if (changing || /\bcall me\b/.test(text)) add("app.personal_profile.update");
  }
  if (/\b(?:csm|customer success|my role|role context|role notes|role playbook)\b/.test(text)) {
    add("app.csm.role.show");
    if (changing) add("app.csm.role.update");
    if (/\b(?:link|attach|document|source|evidence)\b/.test(text)) add("app.library.list", "app.library.show", "app.csm.role.sources.link", "app.csm.role.sources.unlink");
  }
  if (/\b(?:clients?|customer brief|success plan|stakeholders?)\b/.test(text)) {
    add("app.csm.clients.list", "app.csm.clients.show");
    if (changing) add("app.csm.clients.update");
    if (/\b(?:link|attach|document|source|evidence)\b/.test(text)) add("app.library.list", "app.library.show", "app.csm.clients.sources.link", "app.csm.clients.sources.unlink");
  }
  if (/\b(?:projects?|tasks?|today|reminders?|checklist|work items?|to.?do|commitments?)\b/.test(text)) {
    add("app.projects.list", "app.projects.show", "app.today.show");
    if (changing) add("app.work_items.update", "app.work_items.create", "app.today.item.update", "app.today.item.create", "app.projects.update");
    if (/\b(?:create|add|new)\b.{0,24}\bproject\b/.test(text)) add("app.projects.create");
  }
  if (/\b(?:history|activity|results?|previous runs?|recent runs?)\b/.test(text)) add("app.runs.list", "app.runs.show", "app.runs.trajectory");
  if (/\b(?:workflows?|routines?|schedules?|research status|research progress)\b/.test(text)) {
    add("app.workflows.list", "app.workflows.show", "app.workflows.schedules.list");
    if (changing) add("app.workflows.signal", "app.workflows.start", "app.workflows.schedules.control", "app.workflows.schedules.preview");
  }
  if (/\b(?:memory|memories|remember|forget)\b/.test(text)) {
    add("app.memory.search", "app.memory.list", "app.memory.inspect", "app.memory.intelligence.show");
    if (changing) add("app.memory.write", "app.memory.correct", "app.memory.forget.preview", "app.memory.forget");
  }
  if (/\b(?:knowledge|library|documents?|transcripts?|recordings?|decks?|evidence)\b/.test(text)) {
    add("app.library.list", "app.library.show", "app.knowledge.search", "app.knowledge.list");
    if (/\b(?:add|save|ingest)\b/.test(text)) add("app.knowledge.ingest");
    if (/\b(?:remove|delete|forget)\b/.test(text)) add("app.knowledge.delete.preview", "app.knowledge.delete");
  }
  if (/\b(?:settings?|default model|model routing|providers?)\b/.test(text)) {
    add("app.settings.show", "app.settings.models.list");
    if (changing) add("app.settings.assignments.update");
  }
  if (requestsConversationalResearch(query)) add("app.research.start", "web.search", "web.read", "app.workflows.show");
  if (/\b(?:mac|desktop|screen|click|type|keyboard|shortcut|finder|safari|chrome|textedit|notes|pages)\b/.test(text)) {
    add("local.macos.list_apps", "local.macos.activate_app", "local.macos.observe", "local.macos.press", "local.macos.click", "local.macos.type", "local.macos.key", "local.macos.scroll", "local.macos.open_url");
  }
  if (/\b(?:terminal|command|repo(?:sitory)?|git|build|compile|folder|directory|files?|code)\b/.test(text)) add("local.macos.command.run");
  return [...ids];
}
