const signals = [
  { value: "01", label: "One focused outcome" },
  { value: "Fast", label: "Responsive by default" },
  { value: "Yours", label: "Ready to shape with Forge" },
];

export default function Home() {
  return (
    <main>
      <nav aria-label="Primary"><span className="mark">A</span><span>Asael Studio</span><a href="#start">Start here</a></nav>
      <section className="hero">
        <p className="eyebrow">A living application canvas</p>
        <h1>Build something <em>useful.</em></h1>
        <p className="lede">Describe the outcome, let Forge work in a governed sandbox, then inspect every file and check before you keep it.</p>
        <a className="cta" id="start" href="mailto:hello@example.com">Make it yours <span aria-hidden="true">↗</span></a>
      </section>
      <section className="signals" aria-label="Product principles">{signals.map((signal) => <article key={signal.label}><strong>{signal.value}</strong><span>{signal.label}</span></article>)}</section>
      <footer><span>Built inside a private project workspace.</span><span>Next.js · TypeScript</span></footer>
    </main>
  );
}
