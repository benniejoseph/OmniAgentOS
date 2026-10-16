"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./watches.module.css";

type Registration = { id:string;state:string };
type Status = { configured:boolean;publicKey:string|null;registrations:Registration[] };
export function BrowserAlerts({ active,ownerKey }: { active:boolean;ownerKey:string }) {
  const [state,setState] = useState<Status>();
  const [id,setId] = useState<string>();
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const alive = useRef(false);
  const storageKey = `asael-browser-alerts:${ownerKey}`;
  const supported = typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  useEffect(() => {
    alive.current = active;
    if (active && supported) void fetch("/api/web-push",{ cache:"no-store" }).then(async response => {
      if (!response.ok) throw new Error("Browser alert settings are unavailable.");
      const result = await response.json() as Status;
      if (!alive.current) return;
      setState(result);
      const saved = localStorage.getItem(storageKey);
      setId(result.registrations.find(row => row.id === saved && row.state === "active")?.id);
    }).catch(error => { if (alive.current) setMessage(error.message); });
    return () => { alive.current = false; };
  },[active,storageKey,supported]);
  async function update(action:"enable"|"disable"|"test") {
    if (!active || busy || !state) return;
    setBusy(true); setMessage("");
    try {
      let body:unknown;
      if (action === "enable") {
        if (!state.publicKey) throw new Error("Browser delivery needs server configuration.");
        if (await Notification.requestPermission() !== "granted") throw new Error("Allow notifications for this site in browser settings, then retry.");
        if (!alive.current) return;
        await navigator.serviceWorker.register("/sw.js",{ scope:"/",updateViaCache:"none" });
        const worker = await navigator.serviceWorker.ready;
        // An explicit opt-in creates a fresh subscription for this account.
        await (await worker.pushManager.getSubscription())?.unsubscribe();
        const bytes = Uint8Array.from(atob(state.publicKey.replaceAll("-","+").replaceAll("_","/")),char => char.charCodeAt(0));
        const subscription = await worker.pushManager.subscribe({ userVisibleOnly:true,applicationServerKey:bytes });
        if (!alive.current) { await subscription.unsubscribe(); return; }
        body = { action:"register",subscription:subscription.toJSON() };
      } else body = action === "disable" ? { action,id } : { action,id,requestId:crypto.randomUUID() };
      if (!alive.current) return;
      const response = await fetch("/api/web-push",{ method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Browser alert settings could not be saved.");
      if (!alive.current) return;
      if (action === "enable") { setId(value.id);localStorage.setItem(storageKey,value.id);setMessage("Browser alerts enabled for this sign-in. Send a test to verify receipt."); }
      if (action === "disable") {
        setId(undefined);localStorage.removeItem(storageKey);
        await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
        setMessage("Browser alerts disabled.");
      }
      if (action === "test") setMessage("Test alert queued. The normal server scheduler will deliver it; this does not indicate a booking opening.");
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "Browser alerts could not be updated."); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section className={styles.section} aria-label="Browser alerts"><h2>This browser</h2>
    <p>{!supported ? "This browser does not support background notifications. Your alerts still appear in Asael Inbox." : id ? "Browser alerts are enabled for this sign-in." : "Enable browser notifications to receive booking alerts when this tab is closed."}</p>
    <p className={styles.support}>Asael Inbox is shared across the app and web. Browser alerts need an active sign-in; signing out stops delivery. The browser and operating system control background delivery.</p>
    {supported && <div className={styles.actions}>
      {id ? <><button disabled={busy || !active} onClick={() => void update("test")}>Send test alert</button><button disabled={busy || !active} onClick={() => void update("disable")}>Disable browser alerts</button></>
        : <button disabled={busy || !active || !state?.configured} onClick={() => void update("enable")}>Enable browser alerts</button>}
    </div>}
    {state && !state.configured && <p>Browser push is awaiting server configuration.</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
