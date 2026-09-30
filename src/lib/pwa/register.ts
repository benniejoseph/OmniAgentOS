/**
 * Registers the service worker once the page has loaded. The load event has
 * already fired when the registrar mounts late, so it registers at once.
 */
export function registerServiceWorkerAfterLoad(target: Window) {
  if (!("serviceWorker" in target.navigator)) return () => {};
  const register = () => {
    void target.navigator.serviceWorker.register("/sw.js", { scope: "/" });
  };
  if (target.document.readyState === "complete") {
    register();
    return () => {};
  }
  target.addEventListener("load", register, { once: true });
  return () => target.removeEventListener("load", register);
}
