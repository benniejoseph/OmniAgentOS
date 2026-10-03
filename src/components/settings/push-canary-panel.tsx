"use client";

import { useCallback, useEffect, useState } from "react";
import { mutationOptions, settingsJson, useAdvancedSettingsActions } from "./settings-advanced-lifecycle";
import { date, member, object, text } from "./settings-advanced-state";
import { Metadata, ReadNotice, SettingsField } from "./settings-advanced-ui";
import styles from "./settings-advanced.module.css";

type PushRegistration = Readonly<{ id: string; deviceId: string; platform: "android" | "ios" | "macos"; provider: "apns" | "fcm"; environment: "sandbox" | "production"; lastRegisteredAt: string; lastDeliveredAt: string | null }>;
type CanaryTargets = Readonly<{ schemaVersion: 1; registrations: readonly PushRegistration[]; providers: Readonly<{ apns: "configured" | "configuration_required"; fcm: "configured" | "configuration_required" }> }>;
type CanaryResult = Readonly<{
  schemaVersion: 1; canaryId: string; deliveryId: string; outcome: "received" | "provider_failed" | "timed_out"; timedOut: boolean;
  state: Readonly<{ providerState: "queued" | "sending" | "accepted" | "failed"; appState: "none" | "received" | "opened" | "action"; providerAcceptedAt: string | null; receivedAt: string | null; failureCode: string | null }>;
}>;

export function readPushTargets(value: unknown): CanaryTargets {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.providers) || ![value.providers.apns, value.providers.fcm].every((item) => member(item, ["configured", "configuration_required"])) ||
    !Array.isArray(value.registrations) || value.registrations.length > 20 || !value.registrations.every((item) => object(item) && text(item.id) && text(item.deviceId) && member(item.platform, ["android", "ios", "macos"]) &&
      member(item.provider, ["apns", "fcm"]) && member(item.environment, ["sandbox", "production"]) && date(item.lastRegisteredAt) && (item.lastDeliveredAt === null || date(item.lastDeliveredAt))) ||
    new Set(value.registrations.map((item) => item.id)).size !== value.registrations.length) throw new Error("Push readiness returned incomplete or conflicting installation metadata.");
  return value as unknown as CanaryTargets;
}
export function readPushCanaryResult(value: unknown): CanaryResult {
  const fail = () => { throw new Error("The push response did not contain a consistent canary and delivery receipt. Delivery is unconfirmed."); };
  if (!object(value) || value.schemaVersion !== 1 || !text(value.canaryId) || !text(value.deliveryId) || !member(value.outcome, ["received", "provider_failed", "timed_out"]) || typeof value.timedOut !== "boolean" || !object(value.state)) return fail();
  const state = value.state;
  if (state.id !== value.deliveryId || state.causeKind !== "canary" || state.causeId !== value.canaryId || !member(state.providerState, ["queued", "sending", "accepted", "failed"]) || !member(state.appState, ["none", "received", "opened", "action"]) ||
    !(state.providerAcceptedAt === null || date(state.providerAcceptedAt)) || !(state.receivedAt === null || date(state.receivedAt)) || !(state.failureCode === null || text(state.failureCode))) return fail();
  if (value.outcome === "received" && (value.timedOut || state.appState === "none" || !date(state.receivedAt))) return fail();
  if (value.outcome === "provider_failed" && (value.timedOut || state.providerState !== "failed" || state.appState !== "none")) return fail();
  if (value.outcome === "timed_out" && (!value.timedOut || state.appState !== "none" || state.providerState === "failed" || state.receivedAt !== null)) return fail();
  if (state.providerState === "accepted" && !date(state.providerAcceptedAt)) return fail();
  return value as unknown as CanaryResult;
}
export function pushCanaryOutcomeCopy(result: CanaryResult) {
  if (result.outcome === "received") return { tone: "success" as const, title: "Device receipt confirmed", detail: result.state.appState === "received" ? "The installed app acknowledged receipt of the live notification." : `The installed app confirmed the notification by reporting ${result.state.appState}.` };
  if (result.outcome === "provider_failed") return { tone: "danger" as const, title: "Provider rejected the notification", detail: result.state.failureCode ? `Failure code: ${result.state.failureCode}.` : "The notification provider did not accept this delivery." };
  const accepted = result.state.providerState === "accepted";
  return { tone: "warning" as const, title: accepted ? "Provider accepted; device receipt timed out" : "Device receipt timed out", detail: accepted ? "This is not counted as delivery. Open the target app, check notification permission and connectivity, then try again." : "The provider has not accepted this notification yet. Retry after checking provider configuration and queue health." };
}

export function PushCanaryPanel() {
  const actions = useAdvancedSettingsActions();
  const [targets, setTargets] = useState<CanaryTargets>();
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<{ response: CanaryResult; requested: PushRegistration }>();
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string>();
  const readBlocked = actions.blocked("read");
  const runBlocked = actions.blocked("run.agent");
  const load = useCallback(async () => {
    if (readBlocked) return;
    const ticket = actions.gate.read("push-canary-targets"); setLoading(true); setFresh(false); setError(undefined);
    try { const value = readPushTargets(await settingsJson("/api/mobile/push/canary", { signal: ticket.signal })); if (ticket.current()) { setTargets(value); setFresh(true); } else if (ticket.owned()) setError("Push readiness read interrupted by a settings action. Refresh to recheck."); }
    catch (failure) { if (ticket.owned()) setError(ticket.current() ? failure instanceof Error ? failure.message : "Push readiness could not be checked." : "Push readiness read interrupted by a settings action. Refresh to recheck."); }
    finally { if (ticket.owned()) setLoading(false); }
  }, [actions.gate, readBlocked]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  const selected = targets?.registrations.find((item) => item.id === selectedId);
  const outcome = result ? pushCanaryOutcomeCopy(result.response) : undefined;
  async function run() {
    if (!selected || actions.busy || runBlocked || !fresh || loading) return;
    const submitted = { ...selected };
    const value = await actions.run({ label: "Wait for live notification receipt", permission: "run.agent", fingerprint: JSON.stringify(["push-canary", submitted.id, submitted.lastRegisteredAt]), replayable: true, success: "The push canary returned a confirmed outcome; provider acceptance and app receipt remain distinct.",
      execute: async ({ idempotencyKey }) => readPushCanaryResult(await settingsJson("/api/mobile/push/canary", mutationOptions("POST", { registrationId: submitted.id, timeoutSeconds: 12 }, `settings-push-canary-${idempotencyKey}`))),
    });
    if (value) { setResult({ response: value.value, requested: submitted }); setFresh(false); void load(); }
  }
  return <section className={styles.panel} aria-labelledby="push-canary-title">
    <div className={styles.rowHeader}><div><h3 id="push-canary-title">Live notification receipt</h3><p>Send one real notification and wait for the installed app&apos;s acknowledgement. Provider acceptance alone is never shown as delivered.</p></div><button type="button" disabled={Boolean(actions.busy) || Boolean(readBlocked)} onClick={() => void load()}>Refresh push readiness</button></div>
    <ReadNotice loaded={Boolean(targets)} loading={loading && !readBlocked} error={readBlocked || error} label="Push readiness details" />
    {targets ? <><Metadata items={[{ label: "APNs", value: targets.providers.apns === "configured" ? "Configured" : "Setup required" }, { label: "FCM", value: targets.providers.fcm === "configured" ? "Configured" : "Setup required" }, { label: fresh ? "Available targets" : "Last-loaded targets", value: targets.registrations.length }]} />
      <SettingsField label="Target installation"><select value={selectedId} disabled={Boolean(actions.busy)} onChange={(event) => setSelectedId(event.target.value)}><option value="">Choose an installation</option>{selectedId && !selected ? <option value={selectedId}>{selectedId} · unavailable</option> : null}{targets.registrations.map((item) => <option key={item.id} value={item.id}>{item.platform} · {item.provider} {item.environment} · {item.deviceId} · {item.id}</option>)}</select></SettingsField>
      {!targets.registrations.length ? <p className={styles.empty}>{fresh ? "No active native installation was returned. Enable notifications in the native app and refresh." : "The last successful read returned no active installations; current availability is unknown."}</p> : null}
    </> : <p className={styles.support}>Installation count unavailable.</p>}
    {selected ? <Metadata items={[{ label: "Registration ID", value: selected.id }, { label: "Device ID", value: selected.deviceId }, { label: "Platform", value: selected.platform }, { label: "Provider environment", value: `${selected.provider} · ${selected.environment}` }, { label: "Last registered", value: selected.lastRegisteredAt }, { label: "Last delivered", value: selected.lastDeliveredAt || "Not reported" }]} /> : selectedId ? <p className={styles.warning}>The selected installation is unavailable. Choose an available installation or refresh; it has not been replaced automatically.</p> : null}
    {runBlocked ? <p className={styles.warning}>{runBlocked}</p> : null}{!fresh ? <p className={styles.support}>A successful current readiness read is required before sending.</p> : null}
    <div className={styles.actions}><button type="button" className={styles.primary} disabled={!selected || Boolean(actions.busy) || Boolean(runBlocked) || !fresh || loading} onClick={() => void run()}>Run live check</button></div>
    {outcome && result ? <div className={styles.receipt} role="status"><h4>{outcome.title}</h4><p>{outcome.detail}</p><Metadata items={[{ label: "Requested registration ID", value: result.requested.id }, { label: "Requested device ID", value: result.requested.deviceId }, { label: "Canary ID", value: result.response.canaryId }, { label: "Delivery ID", value: result.response.deliveryId }, { label: "Provider state", value: result.response.state.providerState }, { label: "App state", value: result.response.state.appState }, { label: "Provider accepted at", value: result.response.state.providerAcceptedAt || "Not reported" }, { label: "App receipt at", value: result.response.state.receivedAt || "Not reported" }, { label: "Failure code", value: result.response.state.failureCode || "None reported" }]} /></div> : null}
  </section>;
}
