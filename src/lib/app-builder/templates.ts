import { APP_BUILDER_TEMPLATE_ID } from "@/lib/app-builder/contracts";

export type AppBuilderTemplateFile = Readonly<{ path: string; content: string }>;

export const appBuilderStarterTemplate = Object.freeze({
  id: APP_BUILDER_TEMPLATE_ID,
  name: "Next.js product starter",
  description: "A responsive, accessible TypeScript application with a reviewed dependency set.",
  files: Object.freeze<AppBuilderTemplateFile[]>([
    {
      path: "package.json",
      content: `${JSON.stringify({
        name: "asael-built-app",
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          lint: "eslint . --max-warnings=0",
          typecheck: "next typegen && tsc --noEmit",
          test: "npm run typecheck",
        },
        dependencies: { next: "16.3.1", react: "19.2.8", "react-dom": "19.2.8" },
        devDependencies: {
          "@types/node": "24.13.3",
          "@types/react": "19.2.18",
          "@types/react-dom": "19.2.4",
          eslint: "9.39.5",
          "eslint-config-next": "16.3.1",
          typescript: "5.9.3",
        },
      }, null, 2)}\n`,
    },
    {
      path: "app/layout.tsx",
      content: `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = { title: "Built with Asael", description: "A project built in Asael Studio." };\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
    },
    {
      path: "app/page.tsx",
      content: `const signals = [\n  { value: "01", label: "One focused outcome" },\n  { value: "Fast", label: "Responsive by default" },\n  { value: "Yours", label: "Ready to shape with Forge" },\n];\n\nexport default function Home() {\n  return (\n    <main>\n      <nav aria-label="Primary"><span className="mark">A</span><span>Asael Studio</span><a href="#start">Start here</a></nav>\n      <section className="hero">\n        <p className="eyebrow">A living application canvas</p>\n        <h1>Build something <em>useful.</em></h1>\n        <p className="lede">Describe the outcome, let Forge work in a governed sandbox, then inspect every file and check before you keep it.</p>\n        <a className="cta" id="start" href="mailto:hello@example.com">Make it yours <span aria-hidden="true">↗</span></a>\n      </section>\n      <section className="signals" aria-label="Product principles">{signals.map((signal) => <article key={signal.label}><strong>{signal.value}</strong><span>{signal.label}</span></article>)}</section>\n      <footer><span>Built inside a private project workspace.</span><span>Next.js · TypeScript</span></footer>\n    </main>\n  );\n}\n`,
    },
    {
      path: "app/globals.css",
      content: `:root{color-scheme:light;--ink:#102e2a;--muted:#58706b;--paper:#f3efe4;--mint:#bce9da;--line:rgba(16,46,42,.16)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:Arial,Helvetica,sans-serif}main{min-height:100svh;padding:clamp(1rem,3vw,2.4rem);display:grid;grid-template-rows:auto 1fr auto auto;gap:2rem;background:radial-gradient(circle at 80% 20%,rgba(188,233,218,.58),transparent 35%)}nav,footer{display:flex;align-items:center;gap:.75rem;border-bottom:1px solid var(--line);padding-bottom:1rem;font-size:.82rem;letter-spacing:.08em;text-transform:uppercase}nav a{margin-left:auto;color:inherit}.mark{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--ink);color:var(--paper);font-family:Georgia,serif;font-size:1.2rem}.hero{align-self:center;max-width:920px;padding-block:clamp(3rem,10vw,8rem)}.eyebrow{font-size:.76rem;letter-spacing:.18em;text-transform:uppercase}.hero h1{margin:.45rem 0;font:clamp(3.2rem,10vw,8.6rem)/.88 Georgia,serif;letter-spacing:-.065em;max-width:9ch}.hero h1 em{font-weight:400;color:#2a7564}.lede{max-width:58ch;color:var(--muted);font-size:clamp(1rem,1.7vw,1.35rem);line-height:1.65}.cta{display:inline-flex;gap:1.5rem;margin-top:1.4rem;padding:1rem 1.2rem;border-radius:999px;background:var(--ink);color:white;text-decoration:none}.signals{display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid var(--line)}.signals article{padding:1.2rem 0;display:flex;flex-direction:column;gap:.25rem}.signals article+article{border-left:1px solid var(--line);padding-left:1.2rem}.signals strong{font:2rem Georgia,serif}.signals span,footer{color:var(--muted)}footer{border:0;padding:0;justify-content:space-between}@media(max-width:680px){.signals{grid-template-columns:1fr}.signals article+article{border-left:0;border-top:1px solid var(--line);padding-left:0}.hero h1{font-size:clamp(3rem,17vw,5.3rem)}footer{align-items:flex-start;flex-direction:column}}@media(prefers-reduced-motion:no-preference){.hero>*{animation:rise .6s both}.hero>*:nth-child(2){animation-delay:.06s}.hero>*:nth-child(3){animation-delay:.12s}.hero>*:nth-child(4){animation-delay:.18s}@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}}\n`,
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify({
        compilerOptions: {
          target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: false,
          skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
          module: "esnext", moduleResolution: "bundler", resolveJsonModule: true,
          isolatedModules: true, jsx: "react-jsx", incremental: true,
          plugins: [{ name: "next" }], paths: { "@/*": ["./*"] },
        },
        include: ["next-env.d.ts", ".next/types/**/*.ts", "**/*.ts", "**/*.tsx"],
        exclude: ["node_modules"],
      }, null, 2)}\n`,
    },
    { path: ".gitignore", content: `.next/\nnode_modules/\nnext-env.d.ts\n*.tsbuildinfo\n` },
    { path: "next.config.ts", content: `import type { NextConfig } from "next";\nconst nextConfig: NextConfig = { reactStrictMode: true };\nexport default nextConfig;\n` },
    { path: "eslint.config.mjs", content: `import { defineConfig, globalIgnores } from "eslint/config";\nimport nextVitals from "eslint-config-next/core-web-vitals";\nimport nextTs from "eslint-config-next/typescript";\nexport default defineConfig([...nextVitals, ...nextTs, globalIgnores([".next/**","out/**","build/**","next-env.d.ts"])]);\n` },
  ]),
});
