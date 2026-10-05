/** Isolated display fixture. Imports production code unchanged; no application route. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompanionAtlasPortrait, useCompanionAtlasPlayer } from "../../src/components/companion-atlas-player";
import { companionPresentation, companionWork } from "../../src/lib/companion/presentation";

type StyleSample = { atMs: number; display: string; position: string; image: string };
type ControlSample = { eventTimestampMs: number; handlerAtMs: number; secondRafAtMs: number | null; spriteVisibleAtHandler: boolean };
const parameters = new URLSearchParams(location.search);
const mode = parameters.get("mode");
const size = Number(parameters.get("size"));
const theme = parameters.get("theme");
if (!["neutral", "poster", "motion"].includes(mode ?? "") || ![36, 64, 72, 108, 256].includes(size)
  || !["light", "dark"].includes(theme ?? "")) throw new Error("Unsupported measurement case.");
document.documentElement.dataset.theme = theme!;
const observation = {
  fixture: { mode, size, theme, transition: "available -> working", synthetic: true },
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
  const { read, showPortrait, motion, observationRef, posterRef, spriteRef, poster, fullBody, onPosterError } = useCompanionAtlasPlayer({
    scope: "atlas-measurement-tenant:atlas-measurement-actor",
    conversationId: "atlas-measurement-synthetic-conversation", presentation,
  });
  useEffect(() => {
    const sprite = spriteRef.current;
    if (!sprite) return;
    const capture = () => {
      observation.styles.push({ atMs: performance.now(), display: sprite.style.display,
        position: sprite.style.backgroundPosition, image: sprite.style.backgroundImage });
    };
    const observer = new MutationObserver(capture);
    observer.observe(sprite, { attributes: true, attributeFilter: ["style"] });
    capture();
    return () => observer.disconnect();
  }, [spriteRef]);
  return <main>
    <h1>ATLAS production component measurement</h1>
    <p>Isolated synthetic display state. No microphone, audio, Agent or application action.</p>
    <section id="stage" ref={observationRef} data-preferences={read.state}
      data-portrait={String(showPortrait)} data-state={presentation.state}
      data-motion={motion} style={{ width: size, height: size }}>
      <CompanionAtlasPortrait posterRef={posterRef} spriteRef={spriteRef} showPortrait={showPortrait}
        poster={poster} fullBody={fullBody} onPosterError={onPosterError}
        className="portrait" imageClassName="portrait-image" size={`${size}px`} />
    </section>
    <button id="transition" disabled={working} onClick={(event) => {
      observation.trigger = { eventTimestampMs: event.timeStamp, handlerAtMs: performance.now() };
      setWorking(true);
    }}>Show synthetic working state</button>
    <button id="independent" onClick={(event) => {
      const sample: ControlSample = { eventTimestampMs: event.timeStamp, handlerAtMs: performance.now(), secondRafAtMs: null,
        spriteVisibleAtHandler: document.querySelector<HTMLElement>("[data-atlas-sprite]")?.style.display === "block" };
      observation.controls.push(sample);
      setCounter((value) => value + 1);
      requestAnimationFrame(() => requestAnimationFrame(() => { sample.secondRafAtMs = performance.now(); }));
    }}>Independent control</button>
    <output id="counter">{counter}</output>
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing measurement mount.");
createRoot(root).render(<Measurement />);
