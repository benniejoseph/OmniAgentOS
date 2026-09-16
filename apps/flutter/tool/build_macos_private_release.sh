#!/usr/bin/env bash
set -euo pipefail

task_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_flutter_dir="$(cd "$task_script_dir/.." && pwd)"
task_xcode_path="$(xcode-select -p 2>/dev/null || true)"
task_signing_identity="${ASAEL_MACOS_SIGNING_IDENTITY:-}"
task_notary_profile="${ASAEL_MACOS_NOTARY_PROFILE:-}"
task_dist_dir="${ASAEL_MACOS_DIST_DIR:-$task_flutter_dir/build/distribution/macos}"

if [[ -z "$task_xcode_path" || "$task_xcode_path" == *"CommandLineTools"* ]]; then
  echo "Full Xcode is required. Install Xcode, then select Xcode.app with xcode-select." >&2
  exit 1
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is not available on PATH." >&2
  exit 1
fi

cd "$task_flutter_dir"
flutter build macos --release "$@"

task_source_app="$task_flutter_dir/build/macos/Build/Products/Release/omniagent.app"
if [[ ! -d "$task_source_app" ]]; then
  echo "Expected macOS application was not produced: $task_source_app" >&2
  exit 1
fi

task_version_line="$(awk '/^version:/ { print $2; exit }' pubspec.yaml)"
task_version="${task_version_line%%+*}"
task_build="${task_version_line#*+}"
if [[ "$task_build" == "$task_version_line" ]]; then
  task_build="0"
fi

mkdir -p "$task_dist_dir"
task_stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/asael-macos.XXXXXX")"
trap 'rm -rf "$task_stage_dir"' EXIT
task_staged_app="$task_stage_dir/Asael.app"
task_dmg="$task_dist_dir/Asael-${task_version}-${task_build}-macOS.dmg"

ditto "$task_source_app" "$task_staged_app"

if [[ -n "$task_signing_identity" ]]; then
  codesign \
    --force \
    --deep \
    --options runtime \
    --timestamp \
    --sign "$task_signing_identity" \
    --entitlements "$task_flutter_dir/macos/Runner/Release.entitlements" \
    "$task_staged_app"
fi

codesign --verify --deep --strict --verbose=2 "$task_staged_app"

hdiutil create \
  -volname "Asael" \
  -srcfolder "$task_stage_dir" \
  -format UDZO \
  -ov \
  "$task_dmg"

if [[ -n "$task_signing_identity" ]]; then
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
echo "Private macOS release: $task_dmg"
