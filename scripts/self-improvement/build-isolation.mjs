import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

/** Release credentials never belong in candidate build processes. */
export function candidateBuildEnvironment(source, home) {
  return {
    PATH: source.PATH || "/usr/bin:/bin",
    HOME: home,
    TMPDIR: `${home}/tmp`,
    npm_config_cache: `${home}/npm-cache`,
    npm_config_userconfig: `${home}/empty-npmrc`,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: "--max-old-space-size=6144",
    NEXT_PUBLIC_APP_URL: "https://asael.bennierichard.com",
    LANG: "en_US.UTF-8",
    CI: "1",
  };
}

function quoted(value) { return JSON.stringify(value); }

export function candidateBuildSandboxProfile({ root, home, modules, executable, gitDirectory }) {
  const readable = new Set(["/System", "/usr", "/bin", "/sbin", "/opt/homebrew", "/dev", "/private/var/db/dyld", root, home, modules, path.dirname(executable)]);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork sysctl-read)",
    "(allow signal (target same-sandbox))",
    "(allow ipc-posix-shm)",
    "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    ...[...readable].map((item) => `(allow file-read* (subpath ${quoted(item)}))`),
    `(allow file-write* (subpath ${quoted(home)}) (subpath ${quoted(path.join(root, ".next"))}) (literal ${quoted(path.join(root, "tsconfig.tsbuildinfo"))}) (literal ${quoted(path.join(root, "next-env.d.ts"))}) (literal "/dev/null"))`,
    // Read permission for source does not include ignored dotenv files or Git
    // credentials/config. No network or Keychain/XPC service is admitted.
    '(deny file-read* (regex #"(^|/)[.]env([./]|$)"))',
    `(deny file-read* (subpath ${quoted(gitDirectory)}) (subpath ${quoted(path.join(homedir(), ".asael"))}) (subpath ${quoted(path.join(homedir(), ".ssh"))}) (subpath ${quoted(path.join(homedir(), "Library/Keychains"))}))`,
  ].join("\n");
}

/** Caller must await cleanup after the build, including failures. */
export async function prepareCandidateBuild(source = process.env, options = {}) {
  const root = await realpath(options.cwd || process.cwd());
  const folder = await mkdtemp(path.join(tmpdir(), "asael-isolated-build-"));
  const home = await realpath(folder);
  const cleanup = () => rm(folder, { recursive: true, force: true });
  try {
    await mkdir(path.join(home, "tmp"), { mode: 0o700 });
    await writeFile(path.join(home, "empty-npmrc"), "", { mode: 0o600 });
    const env = candidateBuildEnvironment(source, home);
    const required = source.OMNIAGENT_RELEASE_ISOLATED_BUILD === "required";
    if (!required) return { env, commandPrefix: [], cleanup };
    if (process.platform !== "darwin") throw new Error("Unattended local releases require the installed macOS build sandbox.");
    const modules = await realpath(path.join(root, "node_modules"));
    const executable = await realpath(process.execPath);
    const profile = path.join(home, "build.sb");
    await writeFile(profile, candidateBuildSandboxProfile({
      root, home, modules, executable, gitDirectory: path.join(root, ".git"),
    }), { mode: 0o600 });
    return { env, commandPrefix: ["/usr/bin/sandbox-exec", "-f", profile], cleanup };
  } catch (error) { await cleanup(); throw error; }
}
