import { isJsonRecord, recordAt, type AutomationResourceKey, type JsonRecord } from "./automation-model";

export type CapabilityAttempt = Readonly<{ generation: number; name: string }>;

/** One locally exclusive effect; leaving its owner never cancels accepted server work. */
export function createCapabilityEffectGate() {
  let generation = 0;
  let mounted = true;
  let current: CapabilityAttempt | undefined;
  return {
    mount() { mounted = true; },
    begin(name: string): CapabilityAttempt | undefined {
      if (!mounted || current) return undefined;
      current = Object.freeze({ generation: ++generation, name });
      return current;
    },
    current(attempt: CapabilityAttempt) { return mounted && current === attempt; },
    finish(attempt: CapabilityAttempt) {
      if (!mounted || current !== attempt) return false;
      current = undefined;
      return true;
    },
    dispose() { mounted = false; current = undefined; generation += 1; },
  };
}

export const isCapabilityId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 500 && value.trim() === value;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const records = (value: unknown): value is JsonRecord[] => Array.isArray(value) && value.every(isJsonRecord);
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 500);
function requireReceipt(valid: unknown): asserts valid {
  if (!valid) throw new Error("The service did not return a matching, complete receipt. The outcome is unconfirmed; refresh before trying again.");
}

export function parseCapabilityInventory(key: AutomationResourceKey, value: unknown): JsonRecord {
  if (!isJsonRecord(value)) throw new Error("The service returned an unreadable inventory.");
  const fields: Partial<Record<AutomationResourceKey, string[]>> = {
    skills: ["skills"], mcp: ["connectors", "tools"], tools: ["tools"],
    workflows: ["runs"], triggers: ["triggers", "procedures", "agents", "occurrences", "receipts"],
    plugins: ["plugins", "catalog", "installations"],
  };
  const valid = key === "connections"
    ? recordAt(value, "overview")?.version === "p11.7-truthful-integrations:1" && records(recordAt(value, "overview")?.installed)
    : key === "plugins"
      ? records(value.plugins) || (records(value.catalog) && records(value.installations))
      : fields[key]?.every((field) => records(value[field]));
  if (!valid) throw new Error("The inventory response is incomplete. Previously loaded records are retained.");
  return value;
}

export function parseScheduleDetail(value: unknown, id: string): JsonRecord {
  const trigger = recordAt(value, "trigger");
  const preview = recordAt(value, "preview");
  requireReceipt(isJsonRecord(value) && trigger?.id === id && preview && Array.isArray(preview.occurrences) &&
    preview.triggerId === id && digest(preview.configurationSha256) && preview.configurationSha256 === recordAt(recordAt(trigger, "schedule"), "config")?.configSha256 &&
    preview.occurrences.length <= 6 && preview.occurrences.every(date) &&
    records(value.occurrences) && value.occurrences.length <= 30 && records(value.receipts) && value.receipts.length <= 60);
  requireReceipt(value.occurrences.every((item) => item.triggerId === id) && value.receipts.every((item) => item.triggerId === id));
  return value;
}

export function parseScheduleControl(value: unknown, id: string, action: "pause" | "resume" | "run_once", scheduledFor?: string): JsonRecord {
  if (action === "run_once") {
    const occurrence = recordAt(value, "occurrence");
    requireReceipt(occurrence && isCapabilityId(occurrence.id) && occurrence.triggerId === id &&
      date(occurrence.scheduledFor) && Date.parse(occurrence.scheduledFor) === Math.floor(Date.parse(scheduledFor || "") / 60_000) * 60_000 &&
      typeof occurrence.status === "string" && ["claimed", "enqueued", "completed", "failed", "skipped"].includes(occurrence.status));
    return occurrence;
  }
  const trigger = recordAt(value, "trigger");
  requireReceipt(trigger?.id === id && trigger.status === (action === "pause" ? "paused" : "active"));
  return trigger;
}

export function parseScheduleCreated(value: unknown, submitted: JsonRecord): JsonRecord {
  const trigger = recordAt(value, "trigger");
  const config = recordAt(recordAt(trigger, "schedule"), "config");
  requireReceipt(trigger && isCapabilityId(trigger.id) && trigger.triggerKind === "schedule" &&
    ["active", "paused"].includes(String(trigger.status)) &&
    trigger.name === String(submitted.name).trim() && config && config.schemaVersion === 1 && digest(config.configSha256) &&
    recordAt(config, "procedurePin")?.procedureId === submitted.procedureId &&
    recordAt(config, "agentIdentityPin")?.logicalAgentId === submitted.agentId &&
    config.timezone === submitted.timezone && config.rrule === submitted.rrule &&
    date(config.startsAt) && Date.parse(config.startsAt) === Date.parse(String(submitted.startsAt)) &&
    config.maxOccurrences === submitted.maxOccurrences && config.missedPolicy === submitted.missedPolicy && config.failureLimit === submitted.failureLimit &&
    config.authorityMode === submitted.authorityMode && trigger.replacesTriggerId === submitted.replacesTriggerId);
  if (submitted.authorityMode === "reviewed_mutation") {
    const policy = recordAt(config, "mutationPolicy");
    requireReceipt(policy?.schemaVersion === 1 && policy.policyKind === "reviewed_static_mutation" &&
      policy.maximumOccurrences === submitted.maxOccurrences && digest(policy.policySha256) && records(policy.bindings));
  }
  return trigger;
}

// These checks deliberately avoid importing server-only crypto/contracts into the client.
// The server remains authoritative for manifest and preview digests and exact-owner activation.
export async function parsePluginPreview(value: unknown, expected: { pluginId: string; version: string; manifestSha256?: string; submittedManifest?: JsonRecord }): Promise<{ preview: JsonRecord; manifest: JsonRecord }> {
  const preview = recordAt(value, "preview");
  const manifest = recordAt(value, "manifest");
  const counts = recordAt(preview, "componentCounts");
  requireReceipt(preview && manifest && preview.schemaVersion === 1 && manifest.schemaVersion === 1 &&
    isCapabilityId(preview.previewId) && preview.pluginId === expected.pluginId && preview.pluginVersion === expected.version &&
    manifest.pluginId === expected.pluginId && manifest.version === expected.version &&
    digest(preview.manifestSha256) && (!expected.manifestSha256 || preview.manifestSha256 === expected.manifestSha256) &&
    digest(preview.previewSha256) && date(preview.createdAt) && date(preview.expiresAt) &&
    Date.parse(preview.expiresAt) > Date.parse(preview.createdAt) && preview.name === manifest.name && preview.publisherName === recordAt(manifest, "publisher")?.name &&
    strings(preview.effects, 12) && preview.effects.length > 0 && strings(preview.limitations, 12) && preview.limitations.length > 0 && counts);
  for (const [key, maximum] of [["skills", 40], ["mcpTemplates", 20], ["workflowTemplates", 30]] as const) {
    requireReceipt(records(manifest[key]) && manifest[key].length <= maximum && counts[key] === manifest[key].length);
  }
  requireReceipt(new TextEncoder().encode(JSON.stringify(manifest)).byteLength <= 128_000);
  requireReceipt(!expected.submittedManifest || submittedFieldsMatch(manifest, expected.submittedManifest));
  requireReceipt(await capabilityJsonSha256(manifest) === preview.manifestSha256);
  await verifyDigest(preview, "previewSha256");
  return { preview, manifest };
}

export async function parsePluginInstallation(value: unknown, expected: {
  pluginId: string; version: string; manifestSha256: string;
  installationId?: string; revision?: number; state: "enabled" | "disabled" | "uninstalled";
}): Promise<JsonRecord> {
  const installation = recordAt(value, "installation");
  const activation = recordAt(value, "activation");
  requireReceipt(installation && installation.schemaVersion === 1 && isCapabilityId(installation.installationId) &&
    (!expected.installationId || installation.installationId === expected.installationId) &&
    installation.pluginId === expected.pluginId && installation.pluginVersion === expected.version &&
    installation.manifestSha256 === expected.manifestSha256 && digest(installation.installationSha256) &&
    installation.state === expected.state && count(installation.revision) && installation.revision >= 1 &&
    (expected.revision === undefined || installation.revision === expected.revision + 1) &&
    activation && activation.pluginEnabled === (expected.state === "enabled") &&
    activation.mcpConnected === false && activation.mcpContractsReviewed === false && activation.workflowTemplatesExecutable === false);
  const components = recordAt(installation, "components");
  requireReceipt(components && records(components.skills) && components.skills.length <= 40 && records(components.mcpTemplates) &&
    components.mcpTemplates.length <= 20 && records(components.workflowTemplates) && components.workflowTemplates.length <= 30);
  const activeSkillCount = expected.state === "enabled" ? components.skills.length : 0;
  requireReceipt(activation.activeSkillCount === activeSkillCount && activation.skillsActive === (activeSkillCount > 0) &&
    components.skills.every((skill) => skill.state === (expected.state === "enabled" ? "active" : "disabled")) &&
    components.mcpTemplates.every((template) => template.state === "connection_and_review_required") &&
    components.workflowTemplates.every((template) => template.state === "metadata_only") && date(installation.installedAt) && date(installation.updatedAt));
  const manifest = recordAt(value, "manifest");
  requireReceipt(manifest && manifest.pluginId === expected.pluginId && manifest.version === expected.version &&
    await capabilityJsonSha256(manifest) === expected.manifestSha256);
  await verifyDigest(installation, "installationSha256");
  return installation;
}

async function verifyDigest(value: JsonRecord, key: string) {
  const { [key]: expected, ...body } = value;
  requireReceipt(await capabilityJsonSha256(body) === expected);
}

export async function capabilityJsonSha256(value: unknown) {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : isJsonRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  const json = JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
  const bytes = new TextEncoder().encode(json);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function submittedFieldsMatch(received: unknown, submitted: unknown): boolean {
  if (typeof submitted === "string") return received === submitted.trim();
  if (Array.isArray(submitted)) return Array.isArray(received) && received.length === submitted.length && submitted.every((item, index) => submittedFieldsMatch(received[index], item));
  if (isJsonRecord(submitted)) return isJsonRecord(received) && Object.entries(submitted).every(([key, item]) => submittedFieldsMatch(received[key], item));
  return received === submitted;
}
