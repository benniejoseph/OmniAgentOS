import { describe, expect, it } from "vitest";
import {
  buildPluginInstallation,
  buildPluginPreview,
  parsePluginManifest,
  pluginManifestSha256,
} from "@/lib/plugins/contracts";
import {
  createCapabilityEffectGate,
  parseCapabilityInventory,
  parsePluginInstallation,
  parsePluginPreview,
  parseScheduleControl,
  parseScheduleCreated,
  parseScheduleDetail,
} from "./capability-state";

const now = "2026-10-04T10:00:00.000Z";
const sha = "a".repeat(64);
const submitted = {
  triggerKind: "schedule", name: "Daily evidence", procedureId: "procedure-a", agentId: "atlas",
  timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=10;BYMINUTE=0", startsAt: now,
  maxOccurrences: 7, missedPolicy: "skip", failureLimit: 3, authorityMode: "read_only",
};
function schedule() {
  return {
    id: "schedule-a", name: submitted.name, triggerKind: "schedule", status: "active",
    schedule: { config: {
      schemaVersion: 1, configSha256: sha, procedurePin: { procedureId: submitted.procedureId },
      agentIdentityPin: { logicalAgentId: submitted.agentId }, timezone: submitted.timezone,
      rrule: submitted.rrule, startsAt: now, maxOccurrences: 7, missedPolicy: "skip", failureLimit: 3, authorityMode: "read_only",
    } },
  };
}
const rawManifest = {
  schemaVersion: 1, pluginId: "personal.evidence", version: "1.0.0", name: "Evidence guide",
  description: "A declarative guide for reading evidence.", publisher: { id: "personal.publisher", name: "Personal publisher" }, license: "MIT",
  skills: [{ key: "evidence", name: "Read evidence", description: "Read source evidence", instructions: "Read and cite the exact source evidence.", category: "research" }],
};
const manifest = parsePluginManifest(rawManifest);
const expectedPlugin = { pluginId: manifest.pluginId, version: manifest.version, manifestSha256: pluginManifestSha256(manifest) };
function installation(state: "enabled" | "disabled" | "uninstalled" = "enabled", revision = 1) {
  const record = buildPluginInstallation({ installationId: "installation-evidence-a", manifest, state, revision, installedAt: now, updatedAt: now });
  return { installation: record, manifest, activation: {
    pluginEnabled: state === "enabled", skillsActive: state === "enabled", activeSkillCount: state === "enabled" ? 1 : 0,
    mcpConnected: false, mcpContractsReviewed: false, workflowTemplatesExecutable: false,
  } };
}

describe("capability effect lifetime", () => {
  it("claims synchronously across different controls and releases only its own attempt", () => {
    const gate = createCapabilityEffectGate();
    const first = gate.begin("preview")!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(gate.begin("pause")).toBeUndefined();
    expect(gate.finish({ ...first })).toBe(false);
    expect(gate.current(first)).toBe(true);
    expect(gate.finish(first)).toBe(true);
    expect(gate.begin("pause")).toBeDefined();
  });

  it("does not let an old receipt or finally affect a remounted owner or same-name attempt", () => {
    const gate = createCapabilityEffectGate();
    const first = gate.begin("install:a")!;
    gate.dispose();
    expect(gate.current(first)).toBe(false);
    expect(gate.begin("install:b")).toBeUndefined();
    gate.mount();
    const next = gate.begin("install:a")!;
    expect(gate.finish(first)).toBe(false);
    expect(gate.current(next)).toBe(true);
    gate.finish(next);
    const final = gate.begin("install:a")!;
    expect(gate.current(next)).toBe(false);
    expect(gate.current(final)).toBe(true);
  });
});

describe("capability read truth", () => {
  it("distinguishes a confirmed empty inventory from an absent or malformed collection", () => {
    expect(parseCapabilityInventory("skills", { skills: [] })).toEqual({ skills: [] });
    for (const payload of [{}, { skills: null }, { skills: [null] }, { skills: "empty" }]) {
      expect(() => parseCapabilityInventory("skills", payload)).toThrow("incomplete");
    }
    expect(() => parseCapabilityInventory("triggers", { triggers: [] })).toThrow("incomplete");
    expect(parseCapabilityInventory("plugins", { plugins: [] })).toEqual({ plugins: [] });
  });

  it("requires detail identity, current preview config and bounded child receipts", () => {
    const detail = { trigger: schedule(), preview: { triggerId: "schedule-a", configurationSha256: sha, occurrences: [now] }, occurrences: [{ triggerId: "schedule-a" }], receipts: [] };
    expect(parseScheduleDetail(detail, "schedule-a")).toBe(detail);
    expect(() => parseScheduleDetail(detail, "schedule-b")).toThrow("unconfirmed");
    expect(() => parseScheduleDetail({ ...detail, preview: { ...detail.preview, configurationSha256: "b".repeat(64) } }, "schedule-a")).toThrow();
    expect(() => parseScheduleDetail({ ...detail, occurrences: [{ triggerId: "another-schedule" }] }, "schedule-a")).toThrow();
    expect(() => parseScheduleDetail({ ...detail, occurrences: Array.from({ length: 31 }, () => ({ triggerId: "schedule-a" })) }, "schedule-a")).toThrow();
  });
});

describe("schedule effect receipts", () => {
  it.each(["claimed", "enqueued", "completed", "skipped", "failed"])("accepts the actual occurrence state %s", (status) => {
    const occurrence = { id: "occurrence-a", triggerId: "schedule-a", status, scheduledFor: now };
    expect(parseScheduleControl({ occurrence }, "schedule-a", "run_once", now)).toEqual(occurrence);
  });

  it("rejects job-state aliases, another schedule and a different manual occurrence time", () => {
    const occurrence = { id: "occurrence-a", triggerId: "schedule-a", status: "enqueued", scheduledFor: now };
    expect(() => parseScheduleControl({ occurrence: { ...occurrence, status: "queued" } }, "schedule-a", "run_once", now)).toThrow();
    expect(() => parseScheduleControl({ occurrence }, "schedule-b", "run_once", now)).toThrow();
    expect(() => parseScheduleControl({ occurrence }, "schedule-a", "run_once", "2026-10-04T11:00:00.000Z")).toThrow();
    expect(() => parseScheduleControl({ trigger: { id: "schedule-a", status: "active" } }, "schedule-a", "pause")).toThrow();
    expect(parseScheduleControl({ trigger: { id: "schedule-a", status: "paused" } }, "schedule-a", "pause")).toMatchObject({ status: "paused" });
  });

  it("matches the server's minute normalization of the submitted run-once timestamp", () => {
    const occurrence = { id: "occurrence-a", triggerId: "schedule-a", status: "enqueued", scheduledFor: now };
    expect(parseScheduleControl({ occurrence }, "schedule-a", "run_once", "2026-10-04T10:00:42.123Z")).toEqual(occurrence);
    expect(() => parseScheduleControl({ occurrence }, "schedule-a", "run_once", "2026-10-04T10:01:00.000Z")).toThrow();
  });

  it("binds creation to the submitted immutable schedule rather than subsequent form values", () => {
    const trigger = schedule();
    expect(parseScheduleCreated({ trigger }, submitted)).toBe(trigger);
    for (const change of [{ agentId: "other-agent" }, { maxOccurrences: 8 }, { failureLimit: 4 }, { procedureId: "procedure-b" }, { replacesTriggerId: "old-schedule" }]) {
      expect(() => parseScheduleCreated({ trigger }, { ...submitted, ...change })).toThrow();
    }
    expect(() => parseScheduleCreated({ trigger: { ...trigger, schedule: { config: { ...trigger.schedule.config, startsAt: "invalid" } } } }, submitted)).toThrow();
  });
});

describe("declarative extension receipts", () => {
  it("accepts server-built preview digests and normalized defaults for the exact imported manifest", async () => {
    const preview = buildPluginPreview({ manifest, createdAt: now });
    const receipt = await parsePluginPreview({ preview, manifest }, { ...expectedPlugin, submittedManifest: { ...rawManifest, name: ` ${rawManifest.name} ` } });
    expect(receipt.preview.previewSha256).toBe(preview.previewSha256);
    expect(receipt.manifest.skills).toEqual(manifest.skills);
  });

  it("rejects a changed manifest, review body or submitted instructions even with a valid unrelated preview", async () => {
    const preview = buildPluginPreview({ manifest, createdAt: now });
    await expect(parsePluginPreview({ preview, manifest: { ...manifest, name: "Changed" } }, expectedPlugin)).rejects.toThrow();
    await expect(parsePluginPreview({ preview: { ...preview, effects: ["Different effect"] }, manifest }, expectedPlugin)).rejects.toThrow();
    const changed = { ...rawManifest, skills: [{ ...rawManifest.skills[0], instructions: "An unrelated instruction for another task." }] };
    await expect(parsePluginPreview({ preview, manifest }, { ...expectedPlugin, submittedManifest: changed })).rejects.toThrow();
  });

  it("accepts install/reinstall and exact revision transitions without treating metadata as connected or executable", async () => {
    const first = installation("enabled", 4);
    expect(await parsePluginInstallation(first, { ...expectedPlugin, state: "enabled" })).toEqual(first.installation);
    const disabled = installation("disabled", 5);
    expect(await parsePluginInstallation(disabled, { ...expectedPlugin, state: "disabled", revision: 4, installationId: "installation-evidence-a" })).toEqual(disabled.installation);
    await expect(parsePluginInstallation(disabled, { ...expectedPlugin, state: "disabled", revision: 3 })).rejects.toThrow();
    await expect(parsePluginInstallation(first, { ...expectedPlugin, state: "enabled", installationId: "another-installation" })).rejects.toThrow();
  });

  it("refuses digest tampering and inconsistent activation claims while preserving the server boundary", async () => {
    const receipt = installation();
    await expect(parsePluginInstallation({ ...receipt, installation: { ...receipt.installation, name: "Tampered name" } }, { ...expectedPlugin, state: "enabled" })).rejects.toThrow();
    for (const change of [{ mcpConnected: true }, { workflowTemplatesExecutable: true }, { activeSkillCount: 0 }, { skillsActive: false }]) {
      await expect(parsePluginInstallation({ ...receipt, activation: { ...receipt.activation, ...change } }, { ...expectedPlugin, state: "enabled" })).rejects.toThrow();
    }
    await expect(parsePluginInstallation({ ...receipt, manifest: { ...manifest, name: "Other manifest" } }, { ...expectedPlugin, state: "enabled" })).rejects.toThrow();
  });
});
