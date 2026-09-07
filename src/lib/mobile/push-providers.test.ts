import { afterEach, describe, expect, it } from "vitest";
import { mobilePushProviderConfiguration } from "@/lib/mobile/push-providers";

const names = [
  "OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON",
  "OMNIAGENT_APNS_TEAM_ID",
  "OMNIAGENT_APNS_KEY_ID",
  "OMNIAGENT_APNS_BUNDLE_ID",
  "OMNIAGENT_APNS_PRIVATE_KEY",
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("mobile push provider configuration", () => {
  it("fails closed without complete server credentials", () => {
    for (const name of names) delete process.env[name];
    expect(mobilePushProviderConfiguration()).toEqual({
      apns: "configuration_required",
      fcm: "configuration_required",
    });
  });

  it("reports only structurally complete providers", () => {
    process.env.OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "asael-project",
      client_email: "push@example.test",
      private_key: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    });
    process.env.OMNIAGENT_APNS_TEAM_ID = "TEAM123456";
    process.env.OMNIAGENT_APNS_KEY_ID = "KEY1234567";
    process.env.OMNIAGENT_APNS_BUNDLE_ID = "app.omniagent.omniagent";
    process.env.OMNIAGENT_APNS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----";
    expect(mobilePushProviderConfiguration()).toEqual({
      apns: "configured",
      fcm: "configured",
    });
  });
});
