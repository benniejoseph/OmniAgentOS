import { CredentialVaultUnavailableError } from "@/lib/settings/credential-vault";
import { ProviderValidationError } from "@/lib/settings/provider-catalog";
import { ServiceApiKeyError } from "@/lib/settings/service-api-keys";
import { SettingsStoreError } from "@/lib/settings/store";

export function settingsErrorResponse(error: unknown) {
  if (
    error instanceof CredentialVaultUnavailableError ||
    error instanceof ProviderValidationError ||
    error instanceof ServiceApiKeyError ||
    error instanceof SettingsStoreError
  ) {
    return Response.json(
      { error: error.name, message: error.message, ...("code" in error ? { code: error.code } : {}) },
      { status: error.status },
    );
  }
  console.error("Settings operation failed.", error instanceof Error ? error.name : "UnknownError");
  return Response.json(
    { error: "Settings operation failed", message: "The settings operation could not be completed safely." },
    { status: 500 },
  );
}
