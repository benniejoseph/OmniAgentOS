"use client";

import { useEffect } from "react";

export function PwaRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => { void navigator.serviceWorker.register("/sw.js", { scope: "/" }); };
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
