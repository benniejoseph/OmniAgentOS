import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const personalConnections = readFileSync(
  new URL("../connectors/personal-connections.tsx", import.meta.url),
  "utf8",
);
const connectedSources = readFileSync(
  new URL("../capture/connected-sources.tsx", import.meta.url),
  "utf8",
);
const truthPanel = readFileSync(
  new URL("./integration-truth-panel.tsx", import.meta.url),
  "utf8",
);

describe("Google integration UI consistency", () => {
  it("projects granted scopes through the canonical capability registry", () => {
    for (const source of [personalConnections, connectedSources]) {
      expect(source).toContain('from "@/lib/connectors/google-workspace-capabilities"');
      expect(source).toContain('capabilities.has("gmail.modify")');
      expect(source).toContain('capabilities.has("gmail.trash")');
      expect(source).toContain('capabilities.has("calendar.events.write")');
      expect(source).toContain('capabilities.has("drive.write")');
      expect(source).toContain('capabilities.has("photos.pick")');
    }
    expect(personalConnections).toContain("Read, send, organize, and move messages to Trash.");
    expect(personalConnections).toContain("View and change accessible files.");
    expect(personalConnections).toContain("Import only photos you explicitly choose.");
    expect(connectedSources).toContain("Read + send + trash");
    expect(connectedSources).toContain("Full read + write");
    expect(connectedSources).toContain("User-picked only");
    expect(personalConnections).not.toContain("The read-only connection remains active");
    expect(connectedSources).not.toContain("Google access stays read-only");
    expect(personalConnections).toContain('? "Managed by owner"');
    expect(personalConnections).toContain("grant && grant.manageable !== true");
    expect(personalConnections).toContain("only its stored owner can use or change it");
    expect(personalConnections).toContain("if (!grant || blockUnavailableAction()) return;");
    expect(connectedSources).toContain("Managed by owner");
    expect(truthPanel).toContain('return integration.permissions.mode === "no_access" ? "No access" : "User-picked only"');
  });

  it("shows bounded OAuth callback outcomes and removes them from the URL", () => {
    for (const source of [truthPanel, connectedSources]) {
      expect(source).toContain('status !== "connected"');
      expect(source).toContain('status !== "denied"');
      expect(source).toContain('status !== "failed"');
      expect(source).toContain('url.searchParams.delete("oauth")');
      expect(source).toContain('url.searchParams.delete("provider")');
      expect(source).toContain("Google connected");
      expect(source).toContain("Google connection was not completed");
      expect(source).toContain("Google could not be connected");
    }
    expect(truthPanel).toContain("window.history.replaceState");
    expect(connectedSources).toContain("window.history.replaceState");
  });

  it("revalidates the overview after connection and sync state changes", () => {
    for (const source of [truthPanel, personalConnections, connectedSources]) {
      expect(source).toContain('"asael:integration-status-changed"');
    }
    expect(truthPanel).toContain("window.addEventListener(INTEGRATION_STATUS_CHANGED_EVENT");
    expect(truthPanel).toContain("window.removeEventListener(INTEGRATION_STATUS_CHANGED_EVENT");
    expect(personalConnections).toContain("window.dispatchEvent(new Event(INTEGRATION_STATUS_CHANGED_EVENT))");
    expect(connectedSources).toContain("window.dispatchEvent(new Event(INTEGRATION_STATUS_CHANGED_EVENT))");
    expect(personalConnections).toContain("onChanged={refreshIntegrationViews}");
    expect(personalConnections).toContain("await onChanged()");
    expect(connectedSources).toContain("await refreshIntegrationViews()");
  });

  it("forces fresh consent only from explicit repair actions", () => {
    expect(personalConnections).toContain('if (repair) params.set("intent", "repair")');
    expect(personalConnections).toMatch(
      /googleAuthorizeUrl\(\s*provider\?\.authorizeUrl \|\| "\/api\/oauth\/google\/authorize",\s*account\.purpose,\s*grant\?\.id,\s*Boolean\(grant\),\s*\)/,
    );
    expect(connectedSources).toContain("const repairUrl = googleAccountAuthorizeUrl(");
    expect(connectedSources).toContain('intent: "repair"');
    expect(connectedSources).toContain('if (grant?.id) params.set("connectionId", grant.id);');
    expect(connectedSources).toContain('addReturnTo(provider?.authorizeUrl || "/api/oauth/google/authorize")');
    expect(connectedSources).toContain('<a href={repairUrl} className="action-button">Manage access</a>');
  });
});
