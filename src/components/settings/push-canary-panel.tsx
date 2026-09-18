"use client";

import { BellRing, CheckCircle2, Loader2, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "@/components/settings/push-canary-panel.module.css";

type PushRegistration = Readonly<{
  id: string;
  deviceId: string;
  platform: "android" | "ios" | "macos";
  provider: "apns" | "fcm";
  environment: "sandbox" | "production";
  lastRegisteredAt: string;
  lastDeliveredAt: string | null;
}>;

type CanaryTargets = Readonly<{
  schemaVersion: 1;
  registrations: readonly PushRegistration[];
  providers: Readonly<{
    apns: "configured" | "configuration_required";
    fcm: "configured" | "configuration_required";
  }>;
}>;

type CanaryResult = Readonly<{
  schemaVersion: 1;
  canaryId: string;
  deliveryId: string;
  outcome: "received" | "provider_failed" | "timed_out";
  timedOut: boolean;
  state: Readonly<{
    providerState: "queued" | "sending" | "accepted" | "failed";
    appState: "none" | "received" | "opened" | "action";
    providerAcceptedAt: string | null;
    receivedAt: string | null;
    failureCode: string | null;
  }>;
}>;

export function pushCanaryOutcomeCopy(result: CanaryResult) {
  if (result.outcome === "received") {
    return {
      tone: "success" as const,
      title: "Device receipt confirmed",
      detail: result.state.appState === "received"
        ? "The installed app acknowledged receipt of the live notification."
        : `The installed app confirmed the notification by reporting ${result.state.appState}.`,
    };
  }
  if (result.outcome === "provider_failed") {
    return {
      tone: "danger" as const,
      title: "Provider rejected the notification",
      detail: result.state.failureCode
        ? `Failure code: ${result.state.failureCode.replaceAll("_", " ")}.`
        : "The notification provider did not accept this delivery.",
    };
  }
  const providerAccepted = result.state.providerState === "accepted";
  return {
    tone: "warning" as const,
    title: providerAccepted
      ? "Provider accepted; device receipt timed out"
      : "Device receipt timed out",
    detail: providerAccepted
      ? "This is not counted as delivery. Open the target app, check notification permission and connectivity, then try again."
      : "The provider has not accepted this notification yet. Retry after checking provider configuration and queue health.",
  };
}

export function PushCanaryPanel() {
  const [targets, setTargets] = useState<CanaryTargets>();
  const [selectedId, setSelectedId] = useState("");
  const [result, setResult] = useState<CanaryResult>();
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/mobile/push/canary", {
        cache: "no-store",
        signal,
      });
      const payload = await response.json().catch(() => ({})) as CanaryTargets & {
        error?: { message?: string };
        message?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error?.message || payload.message || "Push readiness could not be loaded.");
      }
      setTargets(payload);
      setSelectedId((current) =>
        payload.registrations.some((item) => item.id === current)
          ? current
          : payload.registrations[0]?.id || ""
      );
    } catch (value) {
      if (signal?.aborted) return;
      setTargets(undefined);
      setError(value instanceof Error ? value.message : "Push readiness could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  const selected = useMemo(
    () => targets?.registrations.find((item) => item.id === selectedId),
    [selectedId, targets],
  );
  const outcome = result ? pushCanaryOutcomeCopy(result) : undefined;

  const run = async () => {
    if (!selectedId || running) return;
    setRunning(true);
    setResult(undefined);
    setError(undefined);
    try {
      const response = await fetch("/api/mobile/push/canary", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `settings-push-canary-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ registrationId: selectedId, timeoutSeconds: 12 }),
      });
      const payload = await response.json().catch(() => ({})) as CanaryResult & {
        error?: { message?: string };
        message?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error?.message || payload.message || "The live push check could not run.");
      }
      setResult(payload);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "The live push check could not run.");
    } finally {
      setRunning(false);
    }
  };

  return <section className={styles.panel} aria-labelledby="push-canary-title">
    <div className={styles.heading}>
      <span className={styles.icon}><BellRing size={19} /></span>
      <div>
        <p className={styles.eyebrow}>Native delivery</p>
        <h3 id="push-canary-title">Live notification receipt</h3>
        <p>Send a real notification and require an acknowledgement from the installed app. Provider acceptance alone never appears as delivered.</p>
      </div>
      <button type="button" className="action-button" onClick={() => void load()} disabled={loading || running}>
        <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
        Refresh
      </button>
    </div>

    {loading && !targets ? <div className={styles.state}><Loader2 size={17} className="animate-spin" />Checking registered devices…</div> : null}
    {error ? <div className={`${styles.state} ${styles.danger}`} role="alert"><TriangleAlert size={17} />{error}</div> : null}

    {targets ? <>
      <div className={styles.providerRow}>
        <span>APNs <strong data-ready={targets.providers.apns === "configured"}>{providerLabel(targets.providers.apns)}</strong></span>
        <span>FCM <strong data-ready={targets.providers.fcm === "configured"}>{providerLabel(targets.providers.fcm)}</strong></span>
        <span>{targets.registrations.length} active target{targets.registrations.length === 1 ? "" : "s"}</span>
      </div>
      {targets.registrations.length ? <div className={styles.controls}>
        <label>
          <span>Target installation</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={running}>
            {targets.registrations.map((item) => <option key={item.id} value={item.id}>
              {registrationLabel(item)}
            </option>)}
          </select>
        </label>
        <button type="button" className="primary-button" onClick={() => void run()} disabled={!selected || running}>
          {running ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          {running ? "Waiting for device…" : "Run live check"}
        </button>
      </div> : <div className={styles.state}>
        <TriangleAlert size={17} />
        No active native installation is registered. Enable notifications in Asael on Android, iOS, or an Apple-provisioned macOS build.
      </div>}
    </> : null}

    {outcome ? <div className={`${styles.outcome} ${styles[outcome.tone]}`}>
      {outcome.tone === "success" ? <CheckCircle2 size={19} /> : <TriangleAlert size={19} />}
      <div><strong>{outcome.title}</strong><p>{outcome.detail}</p></div>
    </div> : null}
  </section>;
}

function providerLabel(value: "configured" | "configuration_required") {
  return value === "configured" ? "Ready" : "Setup required";
}

function registrationLabel(registration: PushRegistration) {
  const platform = registration.platform === "macos"
    ? "Mac"
    : registration.platform === "ios"
      ? "iPhone / iPad"
      : "Android";
  const suffix = registration.deviceId.length > 8
    ? registration.deviceId.slice(-8)
    : registration.deviceId;
  return `${platform} · ${registration.provider.toUpperCase()} ${registration.environment} · …${suffix}`;
}
