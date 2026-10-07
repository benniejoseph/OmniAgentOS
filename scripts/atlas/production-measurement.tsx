/** Isolated display fixture. Imports production code unchanged; no application route. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompanionAtlasPortrait, useCompanionAtlasPlayer } from "../../src/components/companion-atlas-player";
import { companionPresentation, companionWork } from "../../src/lib/companion/presentation";

type StyleSample = { atMs: number; renderer: "lottie" | "still"; vectorTransforms: string[]; stillImage: string | null };
type ControlSample = { eventTimestampMs: number; handlerAtMs: number; secondRafAtMs: number | null; lottieVisibleAtHandler: boolean };
const parameters = new URLSearchParams(location.search);
const mode = parameters.get("mode");
const size = Number(parameters.get("size"));
const theme = parameters.get("theme");
if (!["neutral", "poster", "motion"].includes(mode ?? "") || ![36, 64, 72, 108, 256].includes(size)
  || !["light", "dark"].includes(theme ?? "")) throw new Error("Unsupported measurement case.");
document.documentElement.dataset.theme = theme!;
const observation = {
  fixture: { contract: "atlas-lottie-measurement:2", mode, size, theme, transition: "available -> working", synthetic: true },
  entryAtMs: performance.now(),
  trigger: null as { eventTimestampMs: number; handlerAtMs: number } | null,
  styles: [] as StyleSample[],
  controls: [] as ControlSample[],
};
declare global {
  interface Window { __atlasMeasurement: typeof observation }
}
window.__atlasMeasurement = observation;

function Measurement() {
  const [working, setWorking] = useState(false);
  const [counter, setCounter] = useState(0);
  const presentation = companionPresentation({ work: companionWork(working
    ? { status: "running", runId: "atlas-measurement-synthetic-run" } : {}) });
  const { read, showPortrait, motion, observationRef, portrait } = useCompanionAtlasPlayer({
    scope: "atlas-measurement-tenant:atlas-measurement-actor",
    conversationId: "atlas-measurement-synthetic-conversation", presentation,
  });
  useEffect(() => {
    const host = observationRef.current;
    if (!host) return;
    const capture = () => {
      observation.styles.push({ atMs: performance.now(), renderer: lottieVisible(host) ? "lottie" : "still",
        vectorTransforms: [...host.querySelectorAll<SVGElement>("[data-atlas-lottie] svg [transform]")].map((element) => element.getAttribute("transform") ?? ""),
        stillImage: host.querySelector<HTMLImageElement>("[data-atlas-lottie] img")?.getAttribute("src") ?? null });
    };
    const observer = new MutationObserver(capture);
    observer.observe(host, { attributes: true, childList: true, subtree: true, attributeFilter: ["style", "transform", "d", "opacity"] });
    capture();
    return () => observer.disconnect();
  }, [observationRef]);
  return <main>
    <h1>ATLAS production component measurement</h1>
    <p>Isolated synthetic display state. No microphone, audio, Agent or application action.</p>
    <section id="stage" ref={observationRef} data-preferences={read.state}
      data-portrait={String(showPortrait)} data-state={presentation.state}
      data-motion={motion} style={{ width: size, height: size }}>
      <CompanionAtlasPortrait {...portrait} className="portrait" size={`${size}px`} />
    </section>
    <button id="transition" disabled={working} onClick={(event) => {
      observation.trigger = { eventTimestampMs: event.timeStamp, handlerAtMs: performance.now() };
      setWorking(true);
    }}>Show synthetic working state</button>
    <button id="independent" onClick={(event) => {
      const sample: ControlSample = { eventTimestampMs: event.timeStamp, handlerAtMs: performance.now(), secondRafAtMs: null,
        lottieVisibleAtHandler: lottieVisible(document) };
      observation.controls.push(sample);
      setCounter((value) => value + 1);
      requestAnimationFrame(() => requestAnimationFrame(() => { sample.secondRafAtMs = performance.now(); }));
    }}>Independent control</button>
    <output id="counter">{counter}</output>
  </main>;
}

function lottieVisible(root: ParentNode) {
  const surface = root.querySelector<HTMLElement>("[data-atlas-lottie] > span");
  return Boolean(surface?.querySelector("svg") && getComputedStyle(surface).opacity !== "0");
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing measurement mount.");
createRoot(root).render(<Measurement />);
