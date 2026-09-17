#!/usr/bin/env bash
set -euo pipefail

task_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_flutter_dir="$(cd "$task_script_dir/.." && pwd)"
task_xcode_path="$(xcode-select -p 2>/dev/null || true)"
task_developer_signing_identity="${ASAEL_MACOS_SIGNING_IDENTITY:-}"
task_notary_profile="${ASAEL_MACOS_NOTARY_PROFILE:-}"
task_dist_dir="${ASAEL_MACOS_DIST_DIR:-$task_flutter_dir/build/distribution/macos}"
task_local_signing_dir="${ASAEL_MACOS_LOCAL_SIGNING_DIR:-${HOME}/Library/Application Support/Asael/signing}"
task_local_signing_keychain="${ASAEL_MACOS_LOCAL_SIGNING_KEYCHAIN:-$task_local_signing_dir/asael-private-signing.keychain-db}"
task_local_signing_password_file="${ASAEL_MACOS_LOCAL_SIGNING_PASSWORD_FILE:-$task_local_signing_dir/asael-private-signing.password}"
task_local_signing_identity="${ASAEL_MACOS_LOCAL_SIGNING_IDENTITY:-Asael Private Code Signing}"
task_signing_identity="$task_developer_signing_identity"
task_signing_mode="developer"
task_main_entitlements="$task_flutter_dir/macos/Runner/Release.entitlements"
task_codesign_keychain_args=()
task_version_line="$(awk '/^version:/ { print $2; exit }' "$task_flutter_dir/pubspec.yaml")"
task_version="${task_version_line%%+*}"
task_build="${task_version_line#*+}"
if [[ "$task_build" == "$task_version_line" ]]; then
  task_build="0"
fi
task_flutter_build_args=(
  "$@"
  "--dart-define=APP_VERSION=$task_version"
  "--dart-define=APP_BUILD_NUMBER=$task_build"
)

if [[ -z "$task_developer_signing_identity" ]]; then
  if [[ -f "$task_local_signing_keychain" && -f "$task_local_signing_password_file" ]]; then
    task_signing_identity="$task_local_signing_identity"
    task_signing_mode="local"
    task_local_signing_password="$(<"$task_local_signing_password_file")"
    security unlock-keychain -p "$task_local_signing_password" "$task_local_signing_keychain"
    task_codesign_keychain_args=(--keychain "$task_local_signing_keychain")
  elif [[ -e "$task_local_signing_keychain" || -e "$task_local_signing_password_file" ]]; then
    echo "The private macOS signing keychain is incomplete. Repair it before packaging." >&2
    exit 1
  else
    task_signing_mode="adhoc"
  fi
fi

if [[ "$task_signing_mode" != "developer" ]]; then
  # A self-signed identity has no Apple Team Identifier or provisioning
  # profile, so macOS cannot assign a default Keychain access group to a
  # sandboxed process. Keep Apple-signed releases on Release.entitlements,
  # while the owner-Mac package uses the ordinary file-based login Keychain.
  # TCC still protects microphone and other private resources, and the Share
  # Extension retains its own sandboxed entitlement profile.
  task_main_entitlements="$task_flutter_dir/macos/Runner/LocalRelease.entitlements"
fi

if [[ -z "$task_xcode_path" || "$task_xcode_path" == *"CommandLineTools"* ]]; then
  echo "Full Xcode is required. Install Xcode, then select Xcode.app with xcode-select." >&2
  exit 1
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is not available on PATH." >&2
  exit 1
fi

cd "$task_flutter_dir"
if [[ "$task_signing_mode" == "developer" ]]; then
  flutter build macos --release "${task_flutter_build_args[@]}"
else
  # Xcode 27 refuses its automatic signing phase when App Group entitlements
  # are present but the owner-only identity has no Apple TeamIdentifier. Build
  # the exact Flutter Release product unsigned, then sign the extension and app
  # explicitly below with the private identity and retained entitlements.
  flutter build macos --release --config-only "${task_flutter_build_args[@]}"
  xcodebuild \
    -quiet \
    -workspace macos/Runner.xcworkspace \
    -scheme Runner \
    -configuration Release \
    SYMROOT="$task_flutter_dir/build/macos/Build/Products" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    build
fi

task_source_app="$task_flutter_dir/build/macos/Build/Products/Release/omniagent.app"
if [[ ! -d "$task_source_app" ]]; then
  echo "Expected macOS application was not produced: $task_source_app" >&2
  exit 1
fi

mkdir -p "$task_dist_dir"
task_stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/asael-macos.XXXXXX")"
trap 'rm -rf "$task_stage_dir"' EXIT
task_staged_app="$task_stage_dir/Asael.app"
task_dmg="$task_dist_dir/Asael-${task_version}-${task_build}-macOS.dmg"

ditto "$task_source_app" "$task_staged_app"

if [[ -n "$task_signing_identity" ]]; then
  task_codesign_args=(
    --force
    --sign "$task_signing_identity"
  )
  if [[ "$task_signing_mode" == "developer" ]]; then
    task_codesign_args+=(--options runtime --timestamp)
  fi

  while IFS= read -r -d '' task_nested_code; do
    if [[ "$task_nested_code" == *.appex ]]; then
      codesign \
        "${task_codesign_keychain_args[@]}" \
        "${task_codesign_args[@]}" \
        --entitlements "$task_flutter_dir/macos/ShareExtension/ShareExtension.entitlements" \
        "$task_nested_code"
    else
      codesign \
        "${task_codesign_keychain_args[@]}" \
        "${task_codesign_args[@]}" \
        "$task_nested_code"
    fi
  done < <(
    find "$task_staged_app/Contents" -depth \
      \( \
        -type d \( -name '*.framework' -o -name '*.bundle' -o -name '*.xpc' -o -name '*.appex' \) \
        -o -type f -name '*.dylib' \
      \) \
      -print0
  )

  codesign \
    "${task_codesign_keychain_args[@]}" \
    "${task_codesign_args[@]}" \
    --entitlements "$task_main_entitlements" \
    "$task_staged_app"
fi

codesign --verify --deep --strict --verbose=2 "$task_staged_app"

rm -f "$task_dmg"
if command -v diskutil >/dev/null 2>&1 && diskutil help image create from >/dev/null 2>&1; then
  diskutil image create from \
    --volumeName "Asael" \
    --format UDZO \
    "$task_stage_dir" \
    "$task_dmg"
else
  hdiutil create \
    -volname "Asael" \
    -srcfolder "$task_stage_dir" \
    -format UDZO \
    -ov \
    "$task_dmg"
fi

if [[ "$task_signing_mode" == "developer" && -n "$task_signing_identity" ]]; then
  codesign --force --timestamp --sign "$task_signing_identity" "$task_dmg"
  codesign --verify --strict --verbose=2 "$task_dmg"

  if [[ -z "$task_notary_profile" ]]; then
    echo "ASAEL_MACOS_NOTARY_PROFILE is required for a Developer ID release." >&2
    exit 1
  fi
  xcrun notarytool submit "$task_dmg" --keychain-profile "$task_notary_profile" --wait
  xcrun stapler staple "$task_dmg"
  xcrun stapler validate "$task_dmg"
fi

shasum -a 256 "$task_dmg"
echo "macOS signing mode: $task_signing_mode"
echo "Private macOS release: $task_dmg"
