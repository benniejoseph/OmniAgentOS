"use client";

import { useEffect } from "react";

import { registerServiceWorkerAfterLoad } from "@/lib/pwa/register";

export function PwaRegistrar() {
  useEffect(() => registerServiceWorkerAfterLoad(window), []);
  return null;
}
