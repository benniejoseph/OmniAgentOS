/** A push carries only an opaque receipt ID. Resolve its live owner/session on
 * this origin before displaying anything or following a navigation target. */
export const browserPushWorkerScript = `
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let message;
    try { message = event.data.json(); } catch { return; }
    if (message?.version !== 1 || !/^web_delivery_[a-f0-9]{48}$/.test(message.id)) return;
    const path = "/api/web-push/deliveries/" + message.id;
    const response = await fetch(path, { credentials:"same-origin",cache:"no-store" });
    if (!response.ok) return;
    const notice = await response.json();
    if (!notice.display || typeof notice.body !== "string" || notice.body.length > 300) return;
    const existing = await self.registration.getNotifications({ tag:message.id });
    if (!existing.length) await self.registration.showNotification(notice.title, {
      body:notice.body,icon:"/asael-mark.png",tag:message.id,renotify:false,data:{ id:message.id },
    });
    await fetch(path,{ method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({ kind:"received" }) });
  })().catch(() => undefined));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const id = event.notification.data?.id;
    if (!/^web_delivery_[a-f0-9]{48}$/.test(id)) return;
    const response = await fetch("/api/web-push/deliveries/"+id,{ method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({ kind:"opened" }) });
    let href = "/app/watches";
    if (response.ok) {
      const value = await response.json();
      if (/^\\/app\\/watches(?:\\/watch_[a-f0-9]{48})?$/.test(value.href)) href = value.href;
    }
    const url = new URL(href,self.location.origin).href;
    const windows = await self.clients.matchAll({ type:"window",includeUncontrolled:true });
    const current = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (current) { await current.navigate(url); await current.focus(); }
    else await self.clients.openWindow(url);
  })().catch(() => undefined));
});
`;
