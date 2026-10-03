"use client";

import Link from "next/link";
import { useState } from "react";
import styles from "./demo-workspace.module.css";

const demoSteps = [
  {
    label: "Goal", title: "Define the sample goal",
    body: "Prepare a welcome checklist for a fictional project. In a real workspace, the goal, account, and constraints determine the work you request.",
    example: "Draft a welcome checklist for the sample project. Leave external messages for review.",
    detail: "This text is an example. It has not been submitted to an agent.",
  },
  {
    label: "Memory", title: "Inspect the example context",
    body: "Context can include relevant source material and prior work. This walkthrough uses a short fictional policy instead of reading private memory.",
    example: "Sample policy: introductions should name the project owner and explain the first review step.",
    detail: "No memory search, source retrieval, or account read is performed.",
  },
  {
    label: "Workflow", title: "Read the example plan",
    body: "A plan separates drafting from actions that may require a decision. Real progress comes from the workspace's recorded execution state.",
    example: "1. Draft the checklist. 2. Review its sources. 3. Ask before sending an external message.",
    detail: "These steps are illustrative. No workflow has been queued or started.",
  },
  {
    label: "Tools", title: "Understand the review point",
    body: "An external action can require approval under the workspace's policy. A real approval must name the exact action and current request.",
    example: "Example action: send the reviewed welcome message. Example review point: inspect recipient and message before deciding.",
    detail: "There is no approval request here. Selecting this step does not authorize anything.",
  },
  {
    label: "Evidence", title: "Know what a result needs",
    body: "A real result should show what happened and the evidence available for review. A finished walkthrough is not proof of a completed run.",
    example: "Example review: compare the checklist with its sources and inspect the returned action receipt, if an action was authorized.",
    detail: "No run, release, health, isolation, or signing checks were performed by this demo.",
  },
] as const;

export function DemoWorkspace() {
  const [active, setActive] = useState(0);
  const [started, setStarted] = useState(false);
  const step = demoSteps[active];

  function selectStep(index: number) {
    setStarted(true);
    setActive(index);
  }

  return <main id="main-content" tabIndex={-1} className={styles.page} data-testid="demo-workspace">
    <header className={styles.intro}>
      <p className={styles.eyebrow}>Demo workspace · Simulated</p>
      <h1 className={styles.title}>Explore a sample agent workflow.</h1>
      <p className={styles.reading}>Step through a fictional goal, context, plan, review point, and result. Everything in this walkthrough stays on this page.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} onClick={() => selectStep(0)}>{started ? "Restart walkthrough" : "Start walkthrough"}</button>
        <Link href="/login" prefetch={false} className={styles.button}>Sign in to workspace</Link>
      </div>
      <p className={styles.support}>No model, connector, or private workspace is accessed. The walkthrough does not run work or grant permission.</p>
    </header>

    <section className={styles.walkthrough} aria-labelledby="demo-walkthrough-title">
      <div className={styles.walkthroughHeader}>
        <h2 id="demo-walkthrough-title">Sample onboarding workflow</h2>
        <p className={styles.support} role="status">{started ? `Viewing step ${active + 1} of ${demoSteps.length}` : "Choose a step or start the walkthrough."}</p>
      </div>
      <div className={styles.steps} role="group" aria-label="Simulation steps">
        {demoSteps.map((item, index) => <button key={item.label} type="button" className={styles.step}
          aria-pressed={index === active} aria-controls="demo-step-detail" onClick={() => selectStep(index)}>
          <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span><span>{item.label}</span>
        </button>)}
      </div>
      <div id="demo-step-detail" className={styles.detail}>
        <div className={styles.explanation}>
          <p className={styles.eyebrow}>Simulated step {active + 1} · {step.label}</p>
          <h3>{step.title}</h3>
          <p className={styles.reading}>{step.body}</p>
        </div>
        <div className={styles.example}>
          <p className={styles.exampleLabel}>Fictional example</p>
          <p className={styles.reading}>{step.example}</p>
          <p className={styles.support}>{step.detail}</p>
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={active === 0} onClick={() => selectStep(active - 1)}>Previous step</button>
        <button type="button" className={styles.button} disabled={active === demoSteps.length - 1} onClick={() => selectStep(active + 1)}>Next step</button>
      </div>
      {active === demoSteps.length - 1 ? <p className={styles.support}>Last step of the walkthrough. No work was executed or verified.</p> : null}
    </section>

    <section className={styles.scope} aria-labelledby="demo-scope-title">
      <h2 id="demo-scope-title">Simulation boundaries</h2>
      <dl className={styles.facts}>
        <div><dt>Tenant shown</dt><dd><code>sample-tenant</code> · Fictional</dd></div>
        <div><dt>Account access</dt><dd>None</dd></div>
        <div><dt>External actions</dt><dd>None</dd></div>
        <div><dt>Release and health checks</dt><dd>Not performed</dd></div>
      </dl>
      <p className={styles.support}>The private workspace is available to approved accounts. <Link href="/docs" prefetch={false} className={styles.textLink}>Read the product guide</Link></p>
    </section>
  </main>;
}
