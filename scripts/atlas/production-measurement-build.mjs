#!/usr/bin/env node
/** Build only this isolated component fixture into a NEW external evidence directory. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const acceptedManifest = "d485ef524ff7441ea663c38a59e21e7b258f9a6186b832c9d0a3b3ce866c19a8";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("node scripts/atlas/production-measurement-build.mjs --output NEW_EXTERNAL_DIRECTORY\nBuilds the unchanged production component; records source, dirty state, dependencies and exact admitted assets. No app build/server/browser or publication.");
  process.exit(0);
}
if (args.length !== 2 || args[0] !== "--output") throw new Error("Use --output NEW_EXTERNAL_DIRECTORY or --help.");
const output = path.resolve(args[1]);
if (output === path.resolve(repo) || output.startsWith(path.resolve(repo) + path.sep)) throw new Error("Evidence output must be outside the repository.");
const git = (...values) => execFileSync("git", values, { cwd: repo, encoding: "utf8" }).trimEnd();
const source = { revision: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  dirtyStatus: git("status", "--porcelain=v1", "--untracked-files=all") };
source.clean = source.dirtyStatus.length === 0;
const file = async (name) => {
  const bytes = await readFile(path.resolve(repo, name));
  return { kind: "physical", path: name, bytes: bytes.length, sha256: sha(bytes) };
};
const assetRoot = "public/companion/atlas-v1";
const manifestBytes = await readFile(path.join(repo, assetRoot, "manifest.json"));
if (sha(manifestBytes) !== acceptedManifest) throw new Error("Public manifest is not the accepted HELD01 byte identity.");
const manifest = JSON.parse(manifestBytes);
const assets = [await file(`${assetRoot}/manifest.json`)];
const names = ["manifest.json"];
for (const [state, clip] of Object.entries(manifest.states)) {
  for (const theme of ["light", "dark"]) for (const kind of ["poster", "sprite"]) {
    const name = `${state}-${theme}-${kind}.webp`;
    if (clip[theme][kind] !== name) throw new Error("Unexpected admitted asset name.");
    const asset = await file(`${assetRoot}/${name}`);
    if (asset.sha256 !== clip[theme][`${kind}Sha256`]) throw new Error(`Admitted asset differs: ${name}`);
    assets.push(asset); names.push(name);
  }
}
if (assets.length !== 33 || JSON.stringify((await readdir(path.join(repo, assetRoot))).sort()) !== JSON.stringify(names.sort())) throw new Error("Expected exactly the accepted 33 assets.");
assets.push(await file("public/companion/atlas-neutral.png"));
await mkdir(output, { recursive: false }); // Never replace previous measurement evidence.
const loadedInputs = new Map();
const definitions = { "process.env.NODE_ENV": '"production"', "process.env.__NEXT_IMAGE_OPTS": "undefined",
  "process.env.__NEXT_ROUTER_BASEPATH": '""', "process.env.__NEXT_OPTIMIZE_CSS": "false",
  "process.env.__NEXT_OPTIMIZE_FONTS": "false", "process.env": "{}" };
const result = await build({ absWorkingDir: repo, entryPoints: ["scripts/atlas/production-measurement.tsx"],
  outfile: path.join(output, "player.js"), bundle: true, platform: "browser", format: "iife", target: "es2020",
  jsx: "automatic", minify: true, metafile: true, write: true, sourcemap: false,
  define: definitions,
  plugins: [{ name: "record-exact-loaded-bytes", setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?js|jsx|tsx?|json)$/ }, async ({ path: input }) => {
      const bytes = await readFile(input);
      loadedInputs.set(path.relative(repo, input), bytes);
      const extension = path.extname(input).slice(1);
      return { contents: bytes, loader: ["mjs", "cjs"].includes(extension) ? "js" : extension };
    });
  } }],
});
const mandatory = ["scripts/atlas/production-measurement-build.mjs", "scripts/atlas/production_measurement.py",
  "scripts/atlas/production_measurement_server.py", "scripts/atlas/PRODUCTION_MEASUREMENTS.md",
  "package.json", "package-lock.json", "tsconfig.json", "performance-budgets.json",
  "scripts/check-route-js-budget.mjs", ".design/asael-ace-revamp/atlas-production/source/model.json"];
const inputs = [];
const virtualInputs = [];
for (const name of [...new Set([...Object.keys(result.metafile.inputs), ...mandatory])].sort()) {
  if (name.startsWith("<")) {
    const match = /^<define:(.+)>$/.exec(name);
    if (!match || !Object.hasOwn(definitions, match[1]) || !Object.hasOwn(result.metafile.inputs, name)) {
      throw new Error(`Unsupported esbuild virtual input: ${name}`);
    }
    virtualInputs.push({ kind: "esbuild-virtual-define", name, definitionKey: match[1],
      replacement: definitions[match[1]], metadata: result.metafile.inputs[name] });
    continue;
  }
  const row = await file(name);
  const compiled = loadedInputs.get(name);
  if (compiled && row.sha256 !== sha(compiled)) throw new Error(`Input changed while compiling: ${name}`);
  inputs.push(row);
}
if (!inputs.some((row) => row.path === "src/components/companion-atlas-player.tsx")) throw new Error("Actual production player was not bundled.");
if (source.revision !== git("rev-parse", "HEAD") || source.tree !== git("rev-parse", "HEAD^{tree}")
  || source.dirtyStatus !== git("status", "--porcelain=v1", "--untracked-files=all")) throw new Error("Git source identity changed while compiling.");
const bundle = await readFile(path.join(output, "player.js"));
const metafile = JSON.stringify(result.metafile, null, 2) + "\n";
const record = { schemaVersion: 1, kind: "atlas-production-component-build", createdAt: new Date().toISOString(),
  repo, source, tools: { node: process.version, esbuild: esbuildVersion,
    react: JSON.parse(await readFile(path.join(repo, "node_modules/react/package.json"), "utf8")).version,
    next: JSON.parse(await readFile(path.join(repo, "node_modules/next/package.json"), "utf8")).version },
  creativeRevision: manifest.creativeRevision, acceptedManifestSha256: acceptedManifest, inputs, virtualInputs, assets,
  bundle: { path: "player.js", bytes: bundle.length, sha256: sha(bundle) },
  metafile: { path: "esbuild-metafile.json", sha256: sha(metafile) },
  compilation: { productionReact: true, minified: true, nextBuild: false, componentSubstitutions: [], define: definitions },
  routeCosts: { status: "unobserved", reason: "Isolated esbuild bytes are not Next route bytes. Use a separate matching-source Next build and the existing route-bundle budget gate; no route budget pass is inferred." },
};
await writeFile(path.join(output, "esbuild-metafile.json"), metafile, { flag: "wx" });
await writeFile(path.join(output, "build.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
console.log(`Built isolated production player: ${path.join(output, "build.json")}`);
