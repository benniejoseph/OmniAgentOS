import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RELEASE_MANIFEST_MAX_CHARS,
  RELEASE_SIGNING_PUBLIC_KEYS,
  generateReleaseSigningKey,
  loadReleaseSigningKey,
  publicKeyFromBase64,
  releaseSigningKeyId,
  signReleaseManifest,
  verifyReleaseManifest,
} from "../../../scripts/release-manifest.mjs";
import { REQUIRED_RELEASE_CHECKS } from "../../../scripts/release-provenance.mjs";

const revision = "a53a77aee2e1056f8989cc19b24b0a6a620cf084";
const otherRevision = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";
// Readable checks whose names fill an encoded manifest past what a deployment
// serves.
const longChecks = Array.from({ length: 40 }, (_, index) => `${index}`.padStart(100, "c"));

function releaseManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    revision,
    repository: "benniejoseph/OmniAgentOS",
    branch: "main",
    checks: [...REQUIRED_RELEASE_CHECKS, "macos-policy"],
    signedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function signingKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    keyId: releaseSigningKeyId(publicKey),
  };
}

type Envelope = {
  payload: Record<string, unknown>;
  signature: Record<string, unknown>;
};

function decode(encoded: string): Envelope {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function encode(envelope: unknown) {
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}

// Signs any payload the way the runner does, so the checks after the
// signature can be reached with payloads the runner would refuse to sign.
function signPayload(
  payload: unknown,
  key: { privateKey: KeyObject; keyId: string },
) {
  return encode({
    payload,
    signature: {
      algorithm: "Ed25519",
      keyId: key.keyId,
      value: sign(null, Buffer.from(JSON.stringify(sorted(payload))), key.privateKey)
        .toString("base64url"),
    },
  });
}

describe("signed release manifests", () => {
  const trusted = signingKey();
  const untrusted = signingKey();

  it("verifies a manifest that a trusted key signed", () => {
    const encoded = signReleaseManifest(releaseManifest(), trusted);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded.length).toBeLessThan(RELEASE_MANIFEST_MAX_CHARS / 4);
    const expected = {
      valid: true,
      keyId: trusted.keyId,
      manifest: releaseManifest(),
    };
    expect(verifyReleaseManifest(encoded, { publicKeys: [trusted.publicKey] }))
      .toEqual(expected);
    expect(
      verifyReleaseManifest(encoded, {
        publicKeys: [untrusted.publicKey, trusted.publicKey],
      }),
    ).toEqual(expected);
    expect(decode(encoded).signature).toEqual({
      algorithm: "Ed25519",
      keyId: trusted.keyId,
      value: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/),
    });
  });

  it("signs what a manifest says, not the order its fields are written in", () => {
    const envelope = decode(signReleaseManifest(releaseManifest(), trusted));
    const reordered = Object.fromEntries(Object.entries(envelope.payload).reverse());

    expect(Object.keys(reordered)).not.toEqual(Object.keys(envelope.payload));
    expect(
      verifyReleaseManifest(encode({ ...envelope, payload: reordered }), {
        publicKeys: [trusted.publicKey],
      }).valid,
    ).toBe(true);
  });

  it("refuses a manifest that no trusted key signed, or that changed after signing", () => {
    const encoded = signReleaseManifest(releaseManifest(), trusted);
    const envelope = decode(encoded);
    const options = { publicKeys: [trusted.publicKey] };
    const forged = decode(signReleaseManifest(releaseManifest(), untrusted));
    const unsignedBy = `carries a signature key ${trusted.keyId} did not make`;

    for (const [candidate, publicKeys, error] of [
      [
        encoded,
        [untrusted.publicKey],
        `is signed by key ${trusted.keyId}, which this repository does not trust`,
      ],
      [
        encoded,
        [],
        `is signed by key ${trusted.keyId}, which this repository does not trust`,
      ],
      [
        encode({ ...envelope, payload: { ...envelope.payload, revision: otherRevision } }),
        options.publicKeys,
        unsignedBy,
      ],
      [
        encode({
          ...envelope,
          payload: { ...envelope.payload, checks: [...REQUIRED_RELEASE_CHECKS] },
        }),
        options.publicKeys,
        unsignedBy,
      ],
      // Another key's signature, claimed for the trusted key.
      [
        encode({
          ...envelope,
          signature: { ...envelope.signature, value: forged.signature.value },
        }),
        options.publicKeys,
        unsignedBy,
      ],
      [
        encode({
          ...envelope,
          signature: {
            ...envelope.signature,
            value: String(envelope.signature.value).slice(0, -2),
          },
        }),
        options.publicKeys,
        unsignedBy,
      ],
      [
        encode({
          ...envelope,
          signature: {
            ...envelope.signature,
            value: Buffer.from(String(envelope.signature.value), "base64url").toString("base64"),
          },
        }),
        options.publicKeys,
        unsignedBy,
      ],
      [
        encode({ ...envelope, signature: { ...envelope.signature, value: 64 } }),
        options.publicKeys,
        unsignedBy,
      ],
      [
        encode({ ...envelope, signature: { ...envelope.signature, algorithm: "RS256" } }),
        options.publicKeys,
        "is signed with RS256, not Ed25519",
      ],
      [
        encode({
          ...envelope,
          signature: { ...envelope.signature, algorithm: `\u0000${"x".repeat(100)}` },
        }),
        options.publicKeys,
        `is signed with ?${"x".repeat(79)}, not Ed25519`,
      ],
      [
        encode({
          ...envelope,
          signature: { ...envelope.signature, keyId: trusted.keyId.slice(1) },
        }),
        options.publicKeys,
        "names no signing key",
      ],
      [
        encode({ ...envelope, signature: { ...envelope.signature, keyId: 7 } }),
        options.publicKeys,
        "names no signing key",
      ],
    ] as const) {
      expect(verifyReleaseManifest(candidate, { publicKeys })).toEqual({
        valid: false,
        error,
      });
    }
  });

  it("refuses what is not a signed manifest at all", () => {
    const envelope = decode(signReleaseManifest(releaseManifest(), trusted));
    const options = { publicKeys: [trusted.publicKey] };
    const oversized = signPayload(
      releaseManifest({ checks: [...REQUIRED_RELEASE_CHECKS, ...longChecks] }),
      trusted,
    );
    expect(oversized.length).toBeGreaterThan(RELEASE_MANIFEST_MAX_CHARS);

    for (const [candidate, error] of [
      [undefined, "is missing"],
      ["", "is missing"],
      [42, "is missing"],
      ["not+base64/", "is not an encoded release manifest"],
      ["A".repeat(RELEASE_MANIFEST_MAX_CHARS + 1), "is not an encoded release manifest"],
      [Buffer.from("not json").toString("base64url"), "is not an encoded release manifest"],
      [encode({ ...envelope, extra: true }), "is not a signed release manifest"],
      [encode({ payload: envelope.payload }), "is not a signed release manifest"],
      [encode({ ...envelope, payload: [envelope.payload] }), "is not a signed release manifest"],
      [
        encode({ ...envelope, signature: { ...envelope.signature, note: "x" } }),
        "is not a signed release manifest",
      ],
      [encode([envelope]), "is not a signed release manifest"],
      [encode(null), "is not a signed release manifest"],
      [`${signReleaseManifest(releaseManifest(), trusted)}=`, "is not an encoded release manifest"],
      [oversized, "is not an encoded release manifest"],
    ] as const) {
      expect(verifyReleaseManifest(candidate, options)).toEqual({
        valid: false,
        error,
      });
    }
  });

  it("refuses a signed manifest that does not release this repository's main", () => {
    const options = { publicKeys: [trusted.publicKey] };

    for (const [payload, error] of [
      [releaseManifest({ version: 2 }), "is version 2, not 1"],
      [
        Object.fromEntries(
          Object.entries(releaseManifest()).filter(([key]) => key !== "version"),
        ),
        "is version missing, not 1",
      ],
      [{ ...releaseManifest(), notes: "x" }, "is not a version 1 release manifest"],
      [
        Object.fromEntries(
          Object.entries(releaseManifest()).filter(([key]) => key !== "signedAt"),
        ),
        "is not a version 1 release manifest",
      ],
      [releaseManifest({ revision: "a53a77a" }), "names no exact revision"],
      [releaseManifest({ revision: revision.toUpperCase() }), "names no exact revision"],
      [
        releaseManifest({ repository: "someone/OmniAgentOS" }),
        "releases someone/OmniAgentOS main, not benniejoseph/OmniAgentOS main",
      ],
      [
        releaseManifest({ branch: "release" }),
        "releases benniejoseph/OmniAgentOS release, not benniejoseph/OmniAgentOS main",
      ],
      [
        releaseManifest({ repository: "" }),
        "releases missing main, not benniejoseph/OmniAgentOS main",
      ],
      [
        releaseManifest({
          checks: REQUIRED_RELEASE_CHECKS.filter((check) => check !== "gitleaks"),
        }),
        "does not list the required checks gitleaks",
      ],
      [
        releaseManifest({
          checks: ["macos-policy", ...REQUIRED_RELEASE_CHECKS.slice(2)],
        }),
        `does not list the required checks ${REQUIRED_RELEASE_CHECKS.slice(0, 2).join(", ")}`,
      ],
      [releaseManifest({ checks: "quality" }), "lists unreadable checks"],
      [releaseManifest({ checks: [...REQUIRED_RELEASE_CHECKS, 7] }), "lists unreadable checks"],
      [releaseManifest({ checks: [...REQUIRED_RELEASE_CHECKS, ""] }), "lists unreadable checks"],
      [
        releaseManifest({ checks: [...REQUIRED_RELEASE_CHECKS, "line\nbreak"] }),
        "lists unreadable checks",
      ],
      [
        releaseManifest({ checks: [...REQUIRED_RELEASE_CHECKS, "c".repeat(101)] }),
        "lists unreadable checks",
      ],
      [
        releaseManifest({
          checks: [
            ...REQUIRED_RELEASE_CHECKS,
            ...Array.from({ length: 65 - REQUIRED_RELEASE_CHECKS.length }, (_, index) => `job-${index}`),
          ],
        }),
        "lists unreadable checks",
      ],
      [releaseManifest({ signedAt: "2026-10-01" }), "has no signing time"],
      [releaseManifest({ signedAt: "2026-02-30T00:00:00.000Z" }), "has no signing time"],
      [releaseManifest({ signedAt: 1790000000000 }), "has no signing time"],
    ] as const) {
      expect(verifyReleaseManifest(signPayload(payload, trusted), options)).toEqual({
        valid: false,
        error,
      });
    }
    // Exactly the most checks a manifest may list still verifies.
    const most = releaseManifest({
      checks: [
        ...REQUIRED_RELEASE_CHECKS,
        ...Array.from({ length: 64 - REQUIRED_RELEASE_CHECKS.length }, (_, index) => `job-${index}`),
      ],
    });
    expect(verifyReleaseManifest(signPayload(most, trusted), options).valid).toBe(true);
  });

  it("signs only a manifest it would verify, and only one a deployment can serve", () => {
    expect(() => signReleaseManifest(releaseManifest({ branch: "release" }), trusted))
      .toThrow(
        "The release manifest releases benniejoseph/OmniAgentOS release, not benniejoseph/OmniAgentOS main.",
      );
    expect(() => signReleaseManifest(releaseManifest({ signedAt: "now" }), trusted))
      .toThrow("The release manifest has no signing time.");
    const oversized = releaseManifest({ checks: [...REQUIRED_RELEASE_CHECKS, ...longChecks] });
    expect(() => signReleaseManifest(oversized, trusted)).toThrow(
      `The release manifest is longer than ${RELEASE_MANIFEST_MAX_CHARS} characters.`,
    );
    const annotated = { ...releaseManifest(), notes: "x" };
    expect(() => signReleaseManifest(annotated, trusted))
      .toThrow("The release manifest is not a version 1 release manifest.");
  });

  it("trusts only distinct Ed25519 keys", () => {
    expect(Object.isFrozen(RELEASE_SIGNING_PUBLIC_KEYS)).toBe(true);
    const keyIds = RELEASE_SIGNING_PUBLIC_KEYS.map((publicKey) => {
      const key = publicKeyFromBase64(publicKey);
      expect(key.asymmetricKeyType).toBe("ed25519");
      return releaseSigningKeyId(key);
    });
    expect(new Set(keyIds).size).toBe(keyIds.length);
  });

  it("generates a key whose public half names it", () => {
    const generated = generateReleaseSigningKey();

    expect(generated.keyId).toMatch(/^[a-f0-9]{16}$/);
    // The start of the SHA-256 of the key's SPKI DER, as the docs promise.
    expect(generated.keyId).toBe(
      createHash("sha256")
        .update(Buffer.from(generated.publicKey, "base64"))
        .digest("hex")
        .slice(0, 16),
    );
    expect(releaseSigningKeyId(publicKeyFromBase64(generated.publicKey))).toBe(
      generated.keyId,
    );
    expect(generated.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(generateReleaseSigningKey().keyId).not.toBe(generated.keyId);
  });
});

describe("loading the release signing key", () => {
  let directory: string;
  let checkout: string;
  let keyFile: string;
  const generated = generateReleaseSigningKey();
  const name = "OMNIAGENT_RELEASE_SIGNING_KEY_FILE";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "asael-signing-key-"));
    checkout = path.join(directory, "checkout");
    await mkdir(checkout);
    keyFile = path.join(directory, "release-signing-key.pem");
    await writeFile(keyFile, generated.privateKeyPem, { mode: 0o600 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  function load(file: string | undefined) {
    return loadReleaseSigningKey({ env: { [name]: file }, checkout });
  }

  it("loads an Ed25519 key that only its owner can read, outside the checkout", () => {
    const key = load(` ${keyFile} `);

    expect(key.keyId).toBe(generated.keyId);
    expect(key.publicKey).toBe(generated.publicKey);
    expect(key.privateKey.asymmetricKeyType).toBe("ed25519");
    const encoded = signReleaseManifest(releaseManifest(), key);
    expect(
      verifyReleaseManifest(encoded, { publicKeys: [generated.publicKey] }).valid,
    ).toBe(true);
  });

  it("accepts a read-only key and a link to one", async () => {
    await chmod(keyFile, 0o400);
    const link = path.join(directory, "link.pem");
    await symlink(keyFile, link);

    expect(load(keyFile).keyId).toBe(generated.keyId);
    expect(load(link).keyId).toBe(generated.keyId);
  });

  it("refuses a key file that is not configured, not absolute, or not a file", () => {
    expect(() => load(undefined)).toThrow(
      `${name} is required: every release signs its manifest with that key.`,
    );
    expect(() => load("  ")).toThrow(`${name} is required`);
    expect(() => load("release-signing-key.pem")).toThrow(
      `${name} must be an absolute path.`,
    );
    expect(() => load(path.join(directory, "absent.pem"))).toThrow(
      `${name} does not name a readable file.`,
    );
    expect(() => load(directory)).toThrow(`${name} does not name a readable file.`);
  });

  it("refuses a key inside the checkout, even through a link", async () => {
    const inside = path.join(checkout, "release-signing-key.pem");
    await writeFile(inside, generated.privateKeyPem, { mode: 0o600 });
    const link = path.join(directory, "into-checkout.pem");
    await symlink(inside, link);
    const error = `${name} must be outside the release checkout, which the deploy uploads.`;

    expect(() => load(inside)).toThrow(error);
    expect(() => load(link)).toThrow(error);
    // A checkout reached through a link is the same checkout.
    const checkoutLink = path.join(directory, "checkout-link");
    await symlink(checkout, checkoutLink);
    expect(() =>
      loadReleaseSigningKey({ env: { [name]: inside }, checkout: checkoutLink }),
    ).toThrow(error);
    // The checkout itself is never a key file, and a sibling is outside it.
    const sibling = `${checkout}-sibling.pem`;
    await writeFile(sibling, generated.privateKeyPem, { mode: 0o600 });
    expect(load(sibling).keyId).toBe(generated.keyId);
  });

  it("refuses a key that anyone but its owner can read, or that another user owns", async () => {
    for (const mode of [0o640, 0o604, 0o610, 0o700]) {
      await chmod(keyFile, mode);
      if (mode === 0o700) {
        expect(load(keyFile).keyId).toBe(generated.keyId);
        continue;
      }
      expect(() => load(keyFile)).toThrow(
        `${name} must be readable only by its owner (chmod 600).`,
      );
    }
    await chmod(keyFile, 0o600);
    const owner = process.getuid?.() ?? 0;
    vi.spyOn(process as { getuid(): number }, "getuid").mockReturnValue(owner + 1);
    expect(() => load(keyFile)).toThrow(
      `${name} must be owned by the user running the release.`,
    );
  });

  it("refuses anything but an Ed25519 private key, without quoting the file", async () => {
    const error = `${name} is not an Ed25519 private key.`;
    const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey
      .export({ type: "pkcs8", format: "pem" });
    for (const content of [
      String(p256),
      "not a key at all",
      generated.publicKey,
      // A real key padded past the largest key file the loader reads.
      `${generated.privateKeyPem}${" ".repeat(4097 - generated.privateKeyPem.length)}`,
    ]) {
      await writeFile(keyFile, content, { mode: 0o600 });
      let message = "";
      try {
        load(keyFile);
      } catch (thrown) {
        message = thrown instanceof Error ? thrown.message : String(thrown);
      }
      expect(message).toBe(error);
    }
    // The largest key file the loader reads still loads.
    await writeFile(
      keyFile,
      `${generated.privateKeyPem}${" ".repeat(4096 - generated.privateKeyPem.length)}`,
      { mode: 0o600 },
    );
    expect(load(keyFile).keyId).toBe(generated.keyId);
  });
});
