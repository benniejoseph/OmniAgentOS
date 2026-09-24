#!/usr/bin/env bash
set -euo pipefail

task_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_flutter_dir="$(cd "$task_script_dir/.." && pwd)"
source "$task_script_dir/lib/macos_signing_rotation_guard.sh"
task_xcode_path="$(xcode-select -p 2>/dev/null || true)"
task_developer_signing_identity="${ASAEL_MACOS_SIGNING_IDENTITY:-}"
task_notary_profile="${ASAEL_MACOS_NOTARY_PROFILE:-}"
task_dist_dir="${ASAEL_MACOS_DIST_DIR:-$task_flutter_dir/build/distribution/macos}"
task_local_signing_dir="${ASAEL_MACOS_LOCAL_SIGNING_DIR:-${HOME}/Library/Application Support/Asael/signing-v2}"
task_local_signing_keychain="${ASAEL_MACOS_LOCAL_SIGNING_KEYCHAIN:-$task_local_signing_dir/asael-private-signing.keychain-db}"
task_local_signing_password_file="${ASAEL_MACOS_LOCAL_SIGNING_PASSWORD_FILE:-$task_local_signing_dir/asael-private-signing.password}"
task_local_signing_identity="${ASAEL_MACOS_LOCAL_SIGNING_IDENTITY:-Asael Private Code Signing 2026}"
task_local_signing_install_lock="$task_local_signing_dir/.install.lock"
task_credential_broker_dir="${ASAEL_MACOS_CREDENTIAL_BROKER_DIR:-$task_local_signing_dir/credential-broker-v2}"
task_credential_broker_source_app="$task_credential_broker_dir/AsaelCredentialBroker.app"
task_credential_broker_manifest="$task_credential_broker_dir/manifest.json"
task_signing_identity="$task_developer_signing_identity"
task_signing_mode="developer"
task_main_entitlements="$task_flutter_dir/macos/Runner/Release.entitlements"
task_installed_app="/Applications/Asael.app"
task_signing_rotation_acknowledgement="${ASAEL_MACOS_ACKNOWLEDGE_SIGNING_ROTATION:-}"
task_codesign_keychain_args=()
task_local_signing_lock_token=""
task_stage_dir=""
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

cleanup_macos_release() {
  local task_status=$?
  local task_observed_lock_token=""
  trap - EXIT
  set +e
  if [[ -n "$task_stage_dir" && -d "$task_stage_dir" ]]; then
    rm -rf "$task_stage_dir"
  fi
  if [[ -n "$task_local_signing_lock_token" && -L "$task_local_signing_install_lock" ]]; then
    task_observed_lock_token="$(readlink "$task_local_signing_install_lock" 2>/dev/null || true)"
    if [[ "$task_observed_lock_token" == "$task_local_signing_lock_token" ]]; then
      unlink "$task_local_signing_install_lock"
    fi
  fi
  exit "$task_status"
}
trap cleanup_macos_release EXIT

local_signing_lock_is_owned() {
  local task_observed_lock_token=""
  if [[ -z "$task_local_signing_lock_token" || ! -L "$task_local_signing_install_lock" ]]; then
    return 1
  fi
  task_observed_lock_token="$(readlink "$task_local_signing_install_lock" 2>/dev/null || true)"
  [[ "$task_observed_lock_token" == "$task_local_signing_lock_token" ]]
}

acquire_local_signing_lock() {
  mkdir -p "$task_local_signing_dir"
  chmod 700 "$task_local_signing_dir"
  task_local_signing_lock_token="build:${BASHPID:-$$}:$RANDOM:$RANDOM"
  if ! ln -s "$task_local_signing_lock_token" "$task_local_signing_install_lock" 2>/dev/null; then
    task_local_signing_lock_token=""
    return 1
  fi
}

unlock_local_signing_keychain() {
  if [[ "$task_signing_mode" != "local" ]]; then
    return 0
  fi
  if ! local_signing_lock_is_owned; then
    echo "The private macOS signing lease was lost during packaging." >&2
    return 1
  fi
  if [[ ! -f "$task_local_signing_keychain" || ! -f "$task_local_signing_password_file" ]]; then
    echo "The private macOS signing keychain became unavailable during packaging." >&2
    return 1
  fi
  local task_password
  task_password="$(<"$task_local_signing_password_file")"
  security unlock-keychain -p "$task_password" "$task_local_signing_keychain"
  unset task_password
}

codesign_with_active_identity() {
  # Owner-only keychains can auto-lock while the unsigned Xcode build runs.
  # Refresh immediately before every private-key operation instead of relying
  # on the early availability check to remain valid for the whole release.
  unlock_local_signing_keychain
  codesign "$@"
}

if [[ -z "$task_developer_signing_identity" ]]; then
  if ! acquire_local_signing_lock; then
    echo "The private macOS signing identity is being installed, validated, or used by another release." >&2
    exit 1
  elif [[ -f "$task_local_signing_keychain" && -f "$task_local_signing_password_file" ]]; then
    task_signing_identity="$task_local_signing_identity"
    task_signing_mode="local"
    unlock_local_signing_keychain
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

if [[ "$task_signing_mode" == "adhoc" ]]; then
  echo "A stable signing certificate is required for the frozen credential broker." >&2
  echo "Install Asael's rotated private signing identity, then provision broker v2 once." >&2
  exit 1
fi
"$task_script_dir/install_macos_credential_broker_v2.sh" --verify-only
jq -e \
  '.schema == 2 and .version == "2.0.0" and .build == "2"
    and .protocol == "credential-broker-v2"
    and .keychainService == "app.omniagent.omniagent.credential-broker.v2"
    and .initializationMarker == "asael.credential_broker_initialization_v2"
    and .requiresFreshSignIn == true' \
  "$task_credential_broker_manifest" >/dev/null || {
    echo "The immutable credential broker manifest is not the required v2 fresh-sign-in contract." >&2
    exit 1
  }
task_expected_broker_cdhash="$(jq -r '.cdhash' "$task_credential_broker_manifest")"
task_expected_broker_bundle_digest="$(jq -r '.bundleDigest' "$task_credential_broker_manifest")"
task_expected_broker_requirement="$(jq -r '.designatedRequirement' "$task_credential_broker_manifest")"
task_expected_broker_certificate="$(jq -r '.certificateDigest' "$task_credential_broker_manifest")"

credential_broker_bundle_digest() {
  local task_bundle="$1"
  (
    cd "$task_bundle"
    while IFS= read -r task_file; do
      shasum -a 256 "$task_file"
    done < <(find . -type f -print | LC_ALL=C sort)
  ) | shasum -a 256 | awk '{print $1}'
}

signing_certificate_digest() {
  local task_certificate_output
  if [[ "$task_signing_mode" == "local" ]]; then
    task_certificate_output="$(
      security find-certificate -c "$task_signing_identity" -a -Z "$task_local_signing_keychain"
    )"
  else
    task_certificate_output="$(security find-certificate -c "$task_signing_identity" -a -Z)"
  fi
  printf '%s\n' "$task_certificate_output" | awk '
    /^SHA-256 hash:/ { digest=tolower($3); matches += 1 }
    END {
      if (matches != 1 || digest == "") exit 1
      print digest
    }
  '
}

if [[ "$(signing_certificate_digest)" != "$task_expected_broker_certificate" ]]; then
  echo "The active signing certificate does not match the frozen credential broker." >&2
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
task_dmg_source_dir="$task_stage_dir/dmg-root"
task_staged_app="$task_dmg_source_dir/Asael.app"
task_dmg="$task_dist_dir/Asael-${task_version}-${task_build}-macOS.dmg"
task_helper_source_dir="$task_flutter_dir/macos/ComputerUseHelper"
task_helper_app="$task_staged_app/Contents/Helpers/AsaelComputerUseHelper.app"
task_helper_executable="$task_helper_app/Contents/MacOS/AsaelComputerUseHelper"
task_command_helper_source_dir="$task_flutter_dir/macos/CommandRunnerHelper"
task_command_helper_app="$task_staged_app/Contents/Helpers/AsaelCommandRunnerHelper.app"
task_command_helper_executable="$task_command_helper_app/Contents/MacOS/AsaelCommandRunnerHelper"
task_credential_broker_app="$task_staged_app/Contents/Helpers/AsaelCredentialBroker.app"

mkdir -p "$task_dmg_source_dir"
ditto "$task_source_app" "$task_staged_app"
mkdir -p "$task_staged_app/Contents/Helpers"
ditto "$task_credential_broker_source_app" "$task_credential_broker_app"
codesign --verify --strict --verbose=2 "$task_credential_broker_app"
if [[ "$(credential_broker_bundle_digest "$task_credential_broker_app")" != "$task_expected_broker_bundle_digest" ]]; then
  echo "Embedding changed the immutable credential broker bundle." >&2
  exit 1
fi

# Build the credential-free local Computer Use process outside the Flutter
# target and embed it as a separately signed helper. It has no package
# dependencies, network entitlement, inherited environment, XPC service, shell,
# file, or Apple Events interface; the host communicates over child-only pipes.
if [[ ! -f "$task_helper_source_dir/HelperMain.swift" || ! -f "$task_helper_source_dir/Info.plist" ]]; then
  echo "The local Computer Use helper sources are incomplete." >&2
  exit 1
fi
task_helper_build_dir="$task_stage_dir/helper-build"
task_helper_sdk="$(xcrun --sdk macosx --show-sdk-path)"
task_main_executable="$task_staged_app/Contents/MacOS/omniagent"
task_helper_architectures="$(lipo -archs "$task_main_executable")"
mkdir -p "$task_helper_build_dir" "$task_helper_app/Contents/MacOS"
cp "$task_helper_source_dir/Info.plist" "$task_helper_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $task_version" "$task_helper_app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $task_build" "$task_helper_app/Contents/Info.plist"

task_helper_slices=()
for task_helper_architecture in $task_helper_architectures; do
  task_helper_slice="$task_helper_build_dir/AsaelComputerUseHelper-$task_helper_architecture"
  xcrun swiftc \
    -parse-as-library \
    -O \
    -whole-module-optimization \
    -sdk "$task_helper_sdk" \
    -target "$task_helper_architecture-apple-macos14.0" \
    -framework AppKit \
    -framework ApplicationServices \
    -framework Carbon \
    -framework CoreGraphics \
    -framework CryptoKit \
    -framework ScreenCaptureKit \
    -framework Security \
    "$task_helper_source_dir/HelperMain.swift" \
    -o "$task_helper_slice"
  task_helper_slices+=("$task_helper_slice")
done
if [[ "${#task_helper_slices[@]}" -eq 1 ]]; then
  cp "${task_helper_slices[0]}" "$task_helper_executable"
else
  lipo -create "${task_helper_slices[@]}" -output "$task_helper_executable"
fi
chmod 0755 "$task_helper_executable"

# Build the separately signed, one-shot command runner. It accepts one bounded
# executable-plus-argv request over child pipes, carries no credentials, and
# receives an owner-approved workspace path only from the native host.
if [[ ! -f "$task_command_helper_source_dir/HelperMain.swift" \
      || ! -f "$task_command_helper_source_dir/Info.plist" ]]; then
  echo "The local command runner helper sources are incomplete." >&2
  exit 1
fi
task_command_helper_build_dir="$task_stage_dir/command-helper-build"
mkdir -p "$task_command_helper_build_dir" "$task_command_helper_app/Contents/MacOS"
cp "$task_command_helper_source_dir/Info.plist" "$task_command_helper_app/Contents/Info.plist"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleShortVersionString $task_version" \
  "$task_command_helper_app/Contents/Info.plist"
/usr/libexec/PlistBuddy \
  -c "Set :CFBundleVersion $task_build" \
  "$task_command_helper_app/Contents/Info.plist"

task_command_helper_slices=()
for task_helper_architecture in $task_helper_architectures; do
  task_command_helper_slice="$task_command_helper_build_dir/AsaelCommandRunnerHelper-$task_helper_architecture"
  xcrun swiftc \
    -parse-as-library \
    -O \
    -whole-module-optimization \
    -sdk "$task_helper_sdk" \
    -target "$task_helper_architecture-apple-macos14.0" \
    -framework CryptoKit \
    -framework Security \
    "$task_command_helper_source_dir/HelperMain.swift" \
    -o "$task_command_helper_slice"
  task_command_helper_slices+=("$task_command_helper_slice")
done
if [[ "${#task_command_helper_slices[@]}" -eq 1 ]]; then
  cp "${task_command_helper_slices[0]}" "$task_command_helper_executable"
else
  lipo -create "${task_command_helper_slices[@]}" -output "$task_command_helper_executable"
fi
chmod 0755 "$task_command_helper_executable"

if [[ -n "$task_signing_identity" ]]; then
  task_codesign_args=(
    --force
    --sign "$task_signing_identity"
  )
  if [[ "$task_signing_mode" == "developer" ]]; then
    task_codesign_args+=(--options runtime --timestamp)
  fi

  while IFS= read -r -d '' task_nested_code; do
    if [[ "$task_nested_code" == "$task_credential_broker_app"/* ]]; then
      echo "Refusing to re-sign any part of the immutable credential broker." >&2
      exit 1
    fi
    if [[ "$task_nested_code" == *.appex ]]; then
      codesign_with_active_identity \
        "${task_codesign_keychain_args[@]}" \
        "${task_codesign_args[@]}" \
        --entitlements "$task_flutter_dir/macos/ShareExtension/ShareExtension.entitlements" \
        "$task_nested_code"
    else
      codesign_with_active_identity \
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

  codesign_with_active_identity \
    "${task_codesign_keychain_args[@]}" \
    "${task_codesign_args[@]}" \
    --identifier "app.omniagent.omniagent.computer-use-helper" \
    "$task_helper_app"

  codesign_with_active_identity \
    "${task_codesign_keychain_args[@]}" \
    "${task_codesign_args[@]}" \
    --identifier "app.omniagent.omniagent.command-runner-helper" \
    "$task_command_helper_app"
  codesign --verify --strict --verbose=2 "$task_command_helper_app"

  codesign_with_active_identity \
    "${task_codesign_keychain_args[@]}" \
    "${task_codesign_args[@]}" \
    --entitlements "$task_main_entitlements" \
    "$task_staged_app"
fi

task_host_requirement="$(asael_read_macos_designated_requirement "$task_staged_app")" || {
  echo "The replacement app has no readable designated requirement." >&2
  exit 1
}
if [[ -d "$task_installed_app" ]]; then
  task_installed_requirement="$(asael_read_macos_designated_requirement "$task_installed_app")" || {
    echo "The installed Asael app has no readable designated requirement." >&2
    exit 1
  }
  asael_guard_macos_signing_rotation \
    "$task_installed_requirement" \
    "$task_host_requirement" \
    "$task_signing_rotation_acknowledgement"
fi

task_host_entitlements="$task_stage_dir/host-entitlements.plist"
codesign -d --xml --entitlements "$task_host_entitlements" "$task_staged_app" 2>/dev/null
task_observed_apns_environment="$(
  /usr/libexec/PlistBuddy \
    -c 'Print :com.apple.developer.aps-environment' \
    "$task_host_entitlements" 2>/dev/null || true
)"
if [[ "$task_signing_mode" == "developer" ]]; then
  if [[ "$task_observed_apns_environment" != "production" ]]; then
    echo "The Apple-signed app is missing its production APNs entitlement." >&2
    exit 1
  fi
  # A restricted entitlement in the code signature is not sufficient: APNs
  # also requires an Apple-issued profile that binds the topic to this app.
  task_embedded_profile="$task_staged_app/Contents/embedded.provisionprofile"
  task_profile_plist="$task_stage_dir/embedded-provisioning-profile.plist"
  if [[ ! -f "$task_embedded_profile" ]]; then
    echo "The Apple-signed app has no embedded APNs provisioning profile." >&2
    exit 1
  fi
  security cms -D -i "$task_embedded_profile" -o "$task_profile_plist"
  task_profile_apns_environment="$(
    /usr/libexec/PlistBuddy \
      -c 'Print :Entitlements:com.apple.developer.aps-environment' \
      "$task_profile_plist" 2>/dev/null || true
  )"
  task_profile_application_identifier="$(
    /usr/libexec/PlistBuddy \
      -c 'Print :Entitlements:com.apple.application-identifier' \
      "$task_profile_plist" 2>/dev/null || true
  )"
  if [[ "$task_profile_apns_environment" != "production" || \
        "$task_profile_application_identifier" != *.app.omniagent.omniagent ]]; then
    echo "The embedded profile does not authorize production APNs for Asael." >&2
    exit 1
  fi
else
  if [[ -n "$task_observed_apns_environment" ]]; then
    echo "The owner-only package contains an unauthorized APNs entitlement." >&2
    exit 1
  fi
  echo "APNs delivery is unavailable in the owner-only self-signed package."
  echo "Use an Apple-issued identity and APNs provisioning profile for the live canary."
fi

task_observed_broker_cdhash="$(codesign -d -vvv "$task_credential_broker_app" 2>&1 | awk -F= '/^CDHash=/{value=$2} END{print value}')"
if [[ "$task_observed_broker_cdhash" != "$task_expected_broker_cdhash" || \
      "$(credential_broker_bundle_digest "$task_credential_broker_app")" != "$task_expected_broker_bundle_digest" ]]; then
  echo "The credential broker CDHash or bundle digest changed during packaging." >&2
  exit 1
fi
if [[ "$task_host_requirement" != "$task_expected_broker_requirement" ]]; then
  echo "The app and frozen credential broker do not share the recorded designated requirement." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$task_staged_app"

rm -f "$task_dmg"
if command -v diskutil >/dev/null 2>&1 && diskutil help image create from >/dev/null 2>&1; then
  diskutil image create from \
    --volumeName "Asael" \
    --format UDZO \
    "$task_dmg_source_dir" \
    "$task_dmg"
else
  hdiutil create \
    -volname "Asael" \
    -srcfolder "$task_dmg_source_dir" \
    -format UDZO \
    -ov \
    "$task_dmg"
fi

if [[ "$task_signing_mode" == "developer" && -n "$task_signing_identity" ]]; then
  codesign_with_active_identity --force --timestamp --sign "$task_signing_identity" "$task_dmg"
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
