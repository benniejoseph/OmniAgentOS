#!/usr/bin/env bash
set -euo pipefail

task_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_flutter_dir="$(cd "$task_script_dir/.." && pwd)"
task_source_dir="$task_flutter_dir/macos/CredentialBroker"
task_signing_dir="${ASAEL_MACOS_LOCAL_SIGNING_DIR:-${HOME}/Library/Application Support/Asael/signing}"
task_artifact_dir="${ASAEL_MACOS_CREDENTIAL_BROKER_DIR:-$task_signing_dir/credential-broker-v1}"
task_artifact_app="$task_artifact_dir/AsaelCredentialBroker.app"
task_manifest="$task_artifact_dir/manifest.json"
task_executable="$task_artifact_app/Contents/MacOS/AsaelCredentialBroker"
task_info="$task_artifact_app/Contents/Info.plist"
task_local_keychain="${ASAEL_MACOS_LOCAL_SIGNING_KEYCHAIN:-$task_signing_dir/asael-private-signing.keychain-db}"
task_password_file="${ASAEL_MACOS_LOCAL_SIGNING_PASSWORD_FILE:-$task_signing_dir/asael-private-signing.password}"
task_identity="${ASAEL_MACOS_SIGNING_IDENTITY:-${ASAEL_MACOS_LOCAL_SIGNING_IDENTITY:-Asael Private Code Signing}}"
task_verify_only=false

if [[ "${1:-}" == "--verify-only" ]]; then
  task_verify_only=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--verify-only]" >&2
  exit 64
fi

for task_command in xcrun swiftc lipo codesign shasum jq; do
  if ! command -v "$task_command" >/dev/null 2>&1; then
    echo "$task_command is required to provision the macOS credential broker." >&2
    exit 1
  fi
done

source_digest() {
  (
    cd "$task_source_dir"
    shasum -a 256 BrokerMain.swift Info.plist
  ) | shasum -a 256 | awk '{print $1}'
}

bundle_digest() {
  local task_bundle="$1"
  (
    cd "$task_bundle"
    while IFS= read -r task_file; do
      shasum -a 256 "$task_file"
    done < <(find . -type f -print | LC_ALL=C sort)
  ) | shasum -a 256 | awk '{print $1}'
}

code_hash() {
  codesign -d -vvv "$1" 2>&1 | awk -F= '/^CDHash=/{value=$2} END{print value}'
}

designated_requirement() {
  codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'
}

signing_certificate_digest() {
  local task_certificate_output
  if [[ -f "$task_local_keychain" ]]; then
    task_certificate_output="$(
      security find-certificate -c "$task_identity" -a -Z "$task_local_keychain"
    )"
  else
    task_certificate_output="$(security find-certificate -c "$task_identity" -a -Z)"
  fi
  printf '%s\n' "$task_certificate_output" | awk '
    /^SHA-256 hash:/ { digest=tolower($3); matches += 1 }
    END {
      if (matches != 1 || digest == "") exit 1
      print digest
    }
  '
}

verify_artifact() {
  if [[ ! -d "$task_artifact_app" || ! -f "$task_manifest" || ! -x "$task_executable" ]]; then
    echo "Credential broker v1 is not provisioned at: $task_artifact_dir" >&2
    return 1
  fi
  if [[ "$(stat -f '%Lp' "$task_artifact_dir")" != "700" || "$(stat -f '%Lp' "$task_manifest")" != "600" ]]; then
    echo "Credential broker directory/manifest permissions are not owner-only." >&2
    return 1
  fi
  codesign --verify --strict --verbose=2 "$task_artifact_app" >/dev/null

  local task_observed_source task_observed_bundle task_observed_executable
  local task_observed_info task_observed_hash task_observed_certificate task_observed_requirement
  local task_observed_architectures
  task_observed_source="$(source_digest)"
  task_observed_bundle="$(bundle_digest "$task_artifact_app")"
  task_observed_executable="$(shasum -a 256 "$task_executable" | awk '{print $1}')"
  task_observed_info="$(shasum -a 256 "$task_info" | awk '{print $1}')"
  task_observed_hash="$(code_hash "$task_artifact_app")"
  task_observed_certificate="$(signing_certificate_digest)"
  task_observed_requirement="$(designated_requirement "$task_artifact_app")"
  task_observed_architectures="$(lipo -archs "$task_executable")"

  jq -e \
    --arg source "$task_observed_source" \
    --arg bundle "$task_observed_bundle" \
    --arg executable "$task_observed_executable" \
    --arg info "$task_observed_info" \
    --arg cdhash "$task_observed_hash" \
    --arg certificate "$task_observed_certificate" \
    --arg requirement "$task_observed_requirement" \
    --arg architectures "$task_observed_architectures" \
    '.schema == 1 and .version == "1.0.0" and .build == "1"
      and .sourceDigest == $source and .bundleDigest == $bundle
      and .executableDigest == $executable and .infoDigest == $info
      and .cdhash == $cdhash and .certificateDigest == $certificate
      and .designatedRequirement == $requirement
      and .architectures == $architectures' \
    "$task_manifest" >/dev/null || {
      echo "Credential broker verification failed. Never overwrite or re-sign v1; introduce v2." >&2
      return 1
    }
}

if [[ -e "$task_artifact_dir" ]]; then
  verify_artifact
  echo "Verified immutable credential broker v1: $task_artifact_app"
  exit 0
fi
if [[ "$task_verify_only" == true ]]; then
  echo "Run $0 once before packaging this Mac's first broker-enabled release." >&2
  exit 1
fi

task_codesign_keychain_args=()
if [[ -z "${ASAEL_MACOS_SIGNING_IDENTITY:-}" ]]; then
  if [[ ! -f "$task_local_keychain" || ! -f "$task_password_file" ]]; then
    echo "Install Asael's private signing identity before provisioning the broker." >&2
    exit 1
  fi
  task_password="$(<"$task_password_file")"
  security unlock-keychain -p "$task_password" "$task_local_keychain"
  task_codesign_keychain_args=(--keychain "$task_local_keychain")
fi

task_stage="$(mktemp -d "${TMPDIR:-/tmp}/asael-broker-v1.XXXXXX")"
trap 'rm -rf "$task_stage"' EXIT
task_stage_app="$task_stage/AsaelCredentialBroker.app"
task_stage_executable="$task_stage_app/Contents/MacOS/AsaelCredentialBroker"
mkdir -p "$task_stage_app/Contents/MacOS"
cp "$task_source_dir/Info.plist" "$task_stage_app/Contents/Info.plist"

task_sdk="$(xcrun --sdk macosx --show-sdk-path)"
task_architectures="${ASAEL_MACOS_CREDENTIAL_BROKER_ARCHS:-arm64 x86_64}"
task_slices=()
for task_architecture in $task_architectures; do
  task_slice="$task_stage/AsaelCredentialBroker-$task_architecture"
  xcrun swiftc \
    -parse-as-library -O -whole-module-optimization \
    -sdk "$task_sdk" \
    -target "$task_architecture-apple-macos14.0" \
    -framework CryptoKit -framework LocalAuthentication -framework Security \
    "$task_source_dir/BrokerMain.swift" \
    -o "$task_slice"
  task_slices+=("$task_slice")
done
if [[ "${#task_slices[@]}" -eq 1 ]]; then
  cp "${task_slices[0]}" "$task_stage_executable"
else
  lipo -create "${task_slices[@]}" -output "$task_stage_executable"
fi
chmod 0755 "$task_stage_executable"

task_codesign_args=(--force --sign "$task_identity" --identifier app.omniagent.omniagent)
if [[ -n "${ASAEL_MACOS_SIGNING_IDENTITY:-}" ]]; then
  task_codesign_args+=(--options runtime --timestamp)
fi
codesign "${task_codesign_keychain_args[@]}" "${task_codesign_args[@]}" "$task_stage_app"
codesign --verify --strict --verbose=2 "$task_stage_app"

task_source_hash="$(source_digest)"
task_bundle_hash="$(bundle_digest "$task_stage_app")"
task_executable_hash="$(shasum -a 256 "$task_stage_executable" | awk '{print $1}')"
task_info_hash="$(shasum -a 256 "$task_stage_app/Contents/Info.plist" | awk '{print $1}')"
task_cdhash="$(code_hash "$task_stage_app")"
task_certificate_hash="$(signing_certificate_digest)"
task_requirement="$(designated_requirement "$task_stage_app")"
task_archs="$(lipo -archs "$task_stage_executable")"

mkdir -m 0700 "$task_artifact_dir"
ditto "$task_stage_app" "$task_artifact_app"
jq -n \
  --arg source "$task_source_hash" --arg bundle "$task_bundle_hash" \
  --arg executable "$task_executable_hash" --arg info "$task_info_hash" \
  --arg cdhash "$task_cdhash" --arg certificate "$task_certificate_hash" \
  --arg requirement "$task_requirement" --arg archs "$task_archs" \
  '{schema: 1, version: "1.0.0", build: "1", sourceDigest: $source,
    bundleDigest: $bundle, executableDigest: $executable, infoDigest: $info,
    cdhash: $cdhash, certificateDigest: $certificate,
    designatedRequirement: $requirement, architectures: $archs}' > "$task_manifest"
chmod 0600 "$task_manifest"
verify_artifact
echo "Provisioned immutable credential broker v1: $task_artifact_app"
echo "Frozen CDHash: $task_cdhash"
