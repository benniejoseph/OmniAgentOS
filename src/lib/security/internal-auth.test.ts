import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSyntheticRequestMetadata } from "@/lib/observability/store";
import { getSecurityContext } from "@/lib/security/context";
import {
  carriesInternalSecret,
  hasInternalIdentityToken,
  secretsMatch,
} from "@/lib/security/internal-auth";
import {
  INTERNAL_IDENTITY_TOKEN_LIFETIME_SECONDS,
  internalIdentityHeaders,
} from "../../../scripts/internal-identity-token.mjs";

const secret = "internal-auth-test-secret-of-at-least-32-bytes";
const now = Date.parse("2026-09-29T12:00:00.000Z");
const worker = {
  tenantId: "tenant_a",
  actorId: "dedicated-worker",
  role: "system",
  method: "POST",
  pathname: "/api/workflows/tick",
};

beforeEach(() => {
  vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", secret);
  vi.stubEnv("OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS", "false");
  vi.stubEnv("OMNIAGENT_DEFAULT_TENANT", "default");
  vi.stubEnv("OMNIAGENT_DEFAULT_ACTOR", "anonymous");
  vi.stubEnv("OMNIAGENT_DEFAULT_ROLE", "viewer");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("internal identity tokens", () => {
  it("authenticates a signed request as exactly the identity it names, without sending the secret", () => {
    const headers = internalIdentityHeaders(secret, worker);

    expect(headers).toEqual({
      "x-omni-internal-auth": expect.stringMatching(/^v1\.\d{10}\.[A-Za-z0-9_-]{43}$/),
      "x-omni-tenant-id": "tenant_a",
      "x-omni-user-id": "dedicated-worker",
      "x-omni-user-role": "system",
    });
    expect(headers["x-omni-internal-auth"]).not.toContain(secret);
    expect(getSecurityContext(signedRequest(headers))).toEqual({
      tenantId: "tenant_a",
      actorId: "dedicated-worker",
      role: "system",
      source: "headers",
    });
  });

  it.each([
    ["tenant", { headers: { "x-omni-tenant-id": "tenant_b" } }],
    ["actor", { headers: { "x-omni-user-id": "someone-else" } }],
    ["role", { headers: { "x-omni-user-role": "admin" } }],
    ["method", { method: "PUT" }],
    ["path", { pathname: "/api/security/retention" }],
  ])("refuses a token whose %s does not match the request", (_field, change: {
    headers?: Record<string, string>;
    method?: string;
    pathname?: string;
  }) => {
    const headers = { ...internalIdentityHeaders(secret, worker, now), ...change.headers };
    const request = signedRequest(headers, change);

    expect(hasInternalIdentityToken(request, now)).toBe(false);
    expect(getSecurityContext(signedRequest({
      ...internalIdentityHeaders(secret, worker),
      ...change.headers,
    }, change))).toMatchObject({ tenantId: "default", actorId: "anonymous", role: "viewer", source: "default" });
  });

  it("binds a request that names only some identity headers", () => {
    const headers = internalIdentityHeaders(secret, { role: "operator", method: "post", pathname: "/api/agent" }, now);

    expect(headers).toEqual({
      "x-omni-internal-auth": expect.any(String),
      "x-omni-user-role": "operator",
    });
    expect(hasInternalIdentityToken(signedRequest(headers, { pathname: "/api/agent" }), now)).toBe(true);
    expect(hasInternalIdentityToken(signedRequest({
      ...headers,
      "x-omni-tenant-id": "tenant_b",
    }, { pathname: "/api/agent" }), now)).toBe(false);
  });

  it("expires five minutes after signing, and refuses a token that claims a later expiry", () => {
    const lifetimeMs = INTERNAL_IDENTITY_TOKEN_LIFETIME_SECONDS * 1_000;
    const request = signedRequest(internalIdentityHeaders(secret, worker, now));

    expect(INTERNAL_IDENTITY_TOKEN_LIFETIME_SECONDS).toBe(300);
    expect(hasInternalIdentityToken(request, now + lifetimeMs - 1_000)).toBe(true);
    expect(hasInternalIdentityToken(request, now + lifetimeMs)).toBe(false);
    expect(hasInternalIdentityToken(
      signedRequest(internalIdentityHeaders(secret, worker, now + 600_000)),
      now,
    )).toBe(true);
    expect(hasInternalIdentityToken(
      signedRequest(internalIdentityHeaders(secret, worker, now + 601_000)),
      now,
    )).toBe(false);
  });

  it("refuses a token signed with another secret, a malformed token, and any token when no secret is configured", () => {
    const signed = internalIdentityHeaders(secret, worker, now);
    const token = signed["x-omni-internal-auth"];
    const [version, expiresAt, signature] = token.split(".");
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

    for (const candidate of [
      internalIdentityHeaders("another-secret-of-at-least-32-bytes!!", worker, now)["x-omni-internal-auth"],
      `${version}.${expiresAt}.${flipped}`,
      `v2.${expiresAt}.${signature}`,
      `${version}.${expiresAt}.${signature}=`,
      `${version}.${expiresAt}`,
      secret,
    ]) {
      expect(hasInternalIdentityToken(signedRequest({ ...signed, "x-omni-internal-auth": candidate }), now)).toBe(false);
    }

    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "");
    expect(hasInternalIdentityToken(signedRequest(signed), now)).toBe(false);
    expect(getSecurityContext(signedRequest(internalIdentityHeaders(secret, worker)))).toMatchObject({ source: "default" });
  });

  it("refuses to sign without the secret, the method or an absolute path", () => {
    expect(() => internalIdentityHeaders("", worker)).toThrow("deployment secret");
    expect(() => internalIdentityHeaders(secret, { ...worker, method: "" })).toThrow("method and path");
    expect(() => internalIdentityHeaders(secret, { ...worker, pathname: "api/workflows/tick" })).toThrow("method and path");
  });
});

describe("raw internal secret", () => {
  it("still trusts the raw secret in x-omni-internal-auth for the release scripts", () => {
    expect(getSecurityContext(signedRequest({
      "x-omni-internal-auth": ` ${secret} `,
      "x-omni-tenant-id": "tenant_a",
      "x-omni-user-id": "production-smoke",
      "x-omni-user-role": "admin",
    }))).toEqual({ tenantId: "tenant_a", actorId: "production-smoke", role: "admin", source: "headers" });
    expect(getSecurityContext(signedRequest({
      "x-omni-internal-auth": `${secret}x`,
      "x-omni-tenant-id": "tenant_a",
    }))).toMatchObject({ tenantId: "default", source: "default" });
  });

  it("marks synthetic traffic only for the exact secret", () => {
    const synthetic = (value: string) => signedRequest({
      "x-omni-synthetic-auth": value,
      "x-omni-synthetic-source": "production-smoke",
    });

    expect(carriesInternalSecret(synthetic(secret), "x-omni-synthetic-auth")).toBe(true);
    expect(getSyntheticRequestMetadata(synthetic(secret))).toMatchObject({ synthetic: true });
    for (const value of [secret.slice(0, -1), `${secret}x`, secret.toUpperCase()]) {
      expect(carriesInternalSecret(synthetic(value), "x-omni-synthetic-auth")).toBe(false);
      expect(getSyntheticRequestMetadata(synthetic(value))).toEqual({});
    }
    expect(carriesInternalSecret(synthetic(secret), "x-omni-internal-auth")).toBe(false);
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "");
    expect(carriesInternalSecret(synthetic(""), "x-omni-synthetic-auth")).toBe(false);
  });

  it("compares secrets of any length", () => {
    expect(secretsMatch(secret, secret)).toBe(true);
    expect(secretsMatch(secret, `${secret}${secret}`)).toBe(false);
    expect(secretsMatch(secret, "")).toBe(false);
  });

  it("is read from its two headers in one place only", async () => {
    const files = await sourceFiles("src");
    const readers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/\.get\(\s*["'`]x-omni-(internal|synthetic)-auth/.test(source)) readers.push(file);
    }

    expect(readers).toEqual([path.join("src", "lib", "security", "internal-auth.ts")]);
  });
});

describe("dedicated worker", () => {
  it("signs every request instead of sending the secret", async () => {
    const workerScript = await readFile("scripts/worker.mjs", "utf8");

    expect(workerScript).toContain("...internalIdentityHeaders(internalSecret, {");
    expect(workerScript).toContain("workerHeaders(destination.target, url.pathname)");
    expect(workerScript).not.toMatch(/"x-omni-internal-auth"\s*:/);
  });

  it("copies every local module the worker imports into its image", async () => {
    const [dockerfile, modules] = await Promise.all([
      readFile("Dockerfile.worker", "utf8"),
      localModules("scripts/worker.mjs"),
    ]);
    const copied = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("COPY "))
      .flatMap((line) => line.split(/\s+/));

    expect(modules).toContain("scripts/internal-identity-token.mjs");
    for (const imported of modules) expect(copied).toContain(imported);
  });

  it("keeps every module the worker imports in its image build context", async () => {
    const [ignored, modules] = await Promise.all([
      readFile(".dockerignore", "utf8"),
      localModules("scripts/worker.mjs"),
    ]);
    const rules = dockerIgnoreRules(ignored);

    expect(inDockerContext(rules, ".env.local")).toBe(false);
    expect(inDockerContext(rules, "scripts/deploy-production.mjs")).toBe(false);
    for (const file of ["Dockerfile.worker", ...modules]) {
      expect({ file, included: inDockerContext(rules, file) })
        .toEqual({ file, included: true });
    }
  });
});

function signedRequest(
  headers: Record<string, string>,
  { method = "POST", pathname = "/api/workflows/tick" }: { method?: string; pathname?: string } = {},
) {
  return new Request(`https://asael.example.test${pathname}`, { method, headers });
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [entryPath] : [];
  }));
  return files.flat();
}

/** Docker's rule: the last pattern matching a path or a parent decides. */
function dockerIgnoreRules(source: string) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const include = line.startsWith("!");
      const pattern = (include ? line.slice(1) : line).replace(/^\/+|\/+$/g, "");
      const expression = pattern
        .split("/")
        .map((part) =>
          part === "**"
            ? ".*"
            : part
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replaceAll("*", "[^/]*")
                .replaceAll("?", "[^/]"),
        )
        .join("/");
      return { include, expression: new RegExp(`^${expression}$`) };
    });
}

function inDockerContext(
  rules: ReturnType<typeof dockerIgnoreRules>,
  file: string,
) {
  const parts = file.split("/");
  const paths = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  let included = true;
  for (const rule of rules) {
    if (paths.some((candidate) => rule.expression.test(candidate))) {
      included = rule.include;
    }
  }
  return included;
}

async function localModules(entry: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const source = await readFile(entry, "utf8");
  const imports = [...source.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)]
    .map((match) => path.posix.join(path.posix.dirname(entry), match[1]));
  for (const imported of imports) await localModules(imported, seen);
  return [...seen];
}
