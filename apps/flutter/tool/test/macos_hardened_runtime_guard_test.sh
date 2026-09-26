#!/usr/bin/env bash
set -euo pipefail

# Exercises lib/macos_hardened_runtime_guard.sh against real ad-hoc signatures
# of copied system executables, checks the repository entitlement files it
# enforces, and checks that the release packager runs it on every process it
# signs before creating the DMG. Requires macOS codesign, lipo, and plutil.

task_test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_tool_dir="$(cd "$task_test_dir/.." && pwd)"
task_macos_dir="$(cd "$task_tool_dir/../macos" && pwd)"
task_guard="$task_tool_dir/lib/macos_hardened_runtime_guard.sh"
task_build_script="$task_tool_dir/build_macos_private_release.sh"
task_local_entitlements="$task_macos_dir/Runner/LocalRelease.entitlements"
task_release_entitlements="$task_macos_dir/Runner/Release.entitlements"
task_share_entitlements="$task_macos_dir/ShareExtension/ShareExtension.entitlements"
task_plist_buddy="/usr/libexec/PlistBuddy"
task_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/asael-hardened-runtime.XXXXXX")"
trap 'rm -rf "$task_work_dir"' EXIT
task_failures=0

task_pass() {
  echo "ok - $1"
}

task_fail() {
  echo "FAIL - $1" >&2
  task_failures=$((task_failures + 1))
}

# Creates an unsigned app bundle around a copy of /usr/bin/true, which is a
# universal binary.
task_make_app() {
  local task_name="$1"
  local task_app="$task_work_dir/$task_name.app"
  mkdir -p "$task_app/Contents/MacOS"
  cp /usr/bin/true "$task_app/Contents/MacOS/$task_name"
  cat >"$task_app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>$task_name</string>
	<key>CFBundleIdentifier</key>
	<string>app.omniagent.omniagent.guard-test.$task_name</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
</dict>
</plist>
PLIST
  printf '%s\n' "$task_app"
}

# Creates an executable-free resource bundle, like a plugin privacy bundle.
# codesign cannot sign a bundle named exactly Resources.bundle.
task_make_resource_bundle() {
  local task_bundle="$task_work_dir/$1.bundle"
  mkdir -p "$task_bundle/Contents/Resources"
  printf 'resource\n' >"$task_bundle/Contents/Resources/data.txt"
  cat >"$task_bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>app.omniagent.omniagent.guard-test.$1</string>
	<key>CFBundlePackageType</key>
	<string>BNDL</string>
</dict>
</plist>
PLIST
  printf '%s\n' "$task_bundle"
}

task_sign() {
  local task_path="$1"
  shift
  codesign --force --sign - "$@" "$task_path" >/dev/null 2>&1
}

# Copies an entitlement file and applies PlistBuddy commands to the copy.
task_derive_entitlements() {
  local task_source="$1"
  local task_name="$2"
  local task_derived="$task_work_dir/$task_name.entitlements"
  local task_command=""
  shift 2
  cp "$task_source" "$task_derived"
  for task_command in "$@"; do
    "$task_plist_buddy" -c "$task_command" "$task_derived" >/dev/null
  done
  printf '%s\n' "$task_derived"
}

# Runs the guard the way the packager does: sourced into a strict shell.
task_run_guard() {
  bash -c 'set -euo pipefail; source "$1"; shift; asael_verify_macos_hardened_runtime "$@"; echo verified' \
    guard "$task_guard" "$@"
}

task_expect_accepted() {
  local task_case="$1"
  local task_output=""
  shift
  if task_output="$(task_run_guard "$@" 2>&1)" && [[ "$task_output" == "verified" ]]; then
    task_pass "$task_case"
  else
    task_fail "$task_case: $task_output"
  fi
}

task_expect_refused() {
  local task_case="$1"
  local task_message="$2"
  local task_output=""
  shift 2
  if task_output="$(task_run_guard "$@" 2>&1)"; then
    task_fail "$task_case: the guard accepted it"
  elif [[ "$task_output" != *"$task_message"* ]]; then
    task_fail "$task_case: expected \"$task_message\", got: $task_output"
  else
    task_pass "$task_case"
  fi
}

task_expect_entitlement() {
  local task_case="$1"
  local task_file="$2"
  local task_key="$3"
  if [[ "$("$task_plist_buddy" -c "Print :$task_key" "$task_file" 2>/dev/null)" == "true" ]]; then
    task_pass "$task_case"
  else
    task_fail "$task_case: $task_file does not set $task_key"
  fi
}

echo "==> hardened runtime guard"

task_local_host="$(task_make_app LocalHost)"
task_sign "$task_local_host" --options runtime --entitlements "$task_local_entitlements"
task_expect_accepted "the owner-only host with its exact entitlements" \
  "$task_local_host" "$task_local_entitlements" disabled
task_expect_refused "the library-validation exception outside the owner-only host" \
  "disables library validation" "$task_local_host" "$task_local_entitlements"
task_expect_refused "an unknown library-validation policy" \
  "Library validation must be required or disabled" "$task_local_host" "$task_local_entitlements" relaxed
task_expect_refused "an unreadable expected entitlement file" \
  "Cannot read the expected entitlements" "$task_local_host" "$task_work_dir/missing.entitlements" disabled

task_developer_host="$(task_make_app DeveloperHost)"
task_sign "$task_developer_host" --options runtime --entitlements "$task_release_entitlements"
task_expect_accepted "the Apple-signed host keeps library validation" \
  "$task_developer_host" "$task_release_entitlements"

task_share_extension="$(task_make_app ShareExtension)"
task_sign "$task_share_extension" --options runtime --entitlements "$task_share_entitlements"
task_expect_accepted "the Share Extension keeps library validation" \
  "$task_share_extension" "$task_share_entitlements"
task_expect_refused "entitlements on code that must carry none" \
  "is signed with unexpected entitlements" "$task_share_extension"

task_helper="$(task_make_app Helper)"
task_sign "$task_helper" --options runtime
task_expect_accepted "a helper with no entitlements" "$task_helper"

task_resources="$(task_make_resource_bundle PrivacyResources)"
task_sign "$task_resources" --options runtime
task_expect_accepted "a resource bundle" "$task_resources"

task_unhardened_host="$(task_make_app UnhardenedHost)"
task_sign "$task_unhardened_host" --entitlements "$task_local_entitlements"
task_expect_refused "a host without the hardened runtime" \
  "is not signed with the hardened runtime" "$task_unhardened_host" "$task_local_entitlements" disabled

task_unhardened_resources="$(task_make_resource_bundle UnhardenedPrivacyResources)"
task_sign "$task_unhardened_resources"
task_expect_refused "a resource bundle without the hardened runtime" \
  "is not signed with the hardened runtime" "$task_unhardened_resources"

# codesign displays only the native slice of a universal binary unless asked
# for another, so build one whose second slice lacks the hardened runtime.
read -r -a task_system_architectures <<<"$(lipo -archs /usr/bin/true 2>/dev/null)"
if [[ "${#task_system_architectures[@]}" -ge 2 ]]; then
  task_mixed_dir="$task_work_dir/mixed"
  mkdir -p "$task_mixed_dir"
  task_hardened_slice="$task_mixed_dir/${task_system_architectures[0]}"
  task_plain_slice="$task_mixed_dir/${task_system_architectures[1]}"
  lipo /usr/bin/true -thin "${task_system_architectures[0]}" -output "$task_hardened_slice" 2>/dev/null
  lipo /usr/bin/true -thin "${task_system_architectures[1]}" -output "$task_plain_slice" 2>/dev/null
  task_sign "$task_hardened_slice" --options runtime
  task_sign "$task_plain_slice"
  lipo -create "$task_hardened_slice" "$task_plain_slice" -output "$task_mixed_dir/mixed" 2>/dev/null
  task_expect_refused "a universal binary with one unhardened slice" \
    "(${task_system_architectures[1]}) is not signed with the hardened runtime" "$task_mixed_dir/mixed"
else
  task_fail "a universal binary with one unhardened slice: /usr/bin/true has fewer than two architectures"
fi

task_unsigned="$task_work_dir/unsigned"
cp /usr/bin/true "$task_unsigned"
codesign --remove-signature "$task_unsigned"
task_expect_refused "unsigned code" "Cannot read the code signature" "$task_unsigned"
task_expect_refused "a missing path" "Cannot read the code signature" "$task_work_dir/Missing.app"

task_debuggable_entitlements="$task_work_dir/debuggable.entitlements"
"$task_plist_buddy" -c "Add :com.apple.security.get-task-allow bool true" "$task_debuggable_entitlements" >/dev/null
task_debuggable_helper="$(task_make_app DebuggableHelper)"
task_sign "$task_debuggable_helper" --options runtime --entitlements "$task_debuggable_entitlements"
task_expect_refused "a helper that allows debugger attachment" \
  "carries com.apple.security.get-task-allow" "$task_debuggable_helper"

task_jit_entitlements="$(
  task_derive_entitlements "$task_local_entitlements" jit \
    "Add :com.apple.security.cs.allow-jit bool true"
)"
task_jit_host="$(task_make_app JitHost)"
task_sign "$task_jit_host" --options runtime --entitlements "$task_jit_entitlements"
task_expect_refused "a forbidden entitlement even when the expected file lists it" \
  "carries com.apple.security.cs.allow-jit" "$task_jit_host" "$task_jit_entitlements" disabled

task_extra_entitlements="$(
  task_derive_entitlements "$task_local_entitlements" extra \
    "Add :com.apple.security.network.server bool true"
)"
task_extra_host="$(task_make_app ExtraHost)"
task_sign "$task_extra_host" --options runtime --entitlements "$task_extra_entitlements"
task_expect_refused "an extra entitlement" \
  "is signed with unexpected entitlements" "$task_extra_host" "$task_local_entitlements" disabled

task_missing_entitlements="$(
  task_derive_entitlements "$task_local_entitlements" missing \
    "Delete :com.apple.security.device.audio-input"
)"
task_missing_host="$(task_make_app MissingHost)"
task_sign "$task_missing_host" --options runtime --entitlements "$task_missing_entitlements"
task_expect_refused "a missing entitlement" \
  "is signed with unexpected entitlements" "$task_missing_host" "$task_local_entitlements" disabled

task_changed_entitlements="$(
  task_derive_entitlements "$task_local_entitlements" changed \
    "Set :com.apple.security.application-groups:0 group.example.other"
)"
task_changed_host="$(task_make_app ChangedHost)"
task_sign "$task_changed_host" --options runtime --entitlements "$task_changed_entitlements"
task_expect_refused "a changed entitlement value" \
  "is signed with unexpected entitlements" "$task_changed_host" "$task_local_entitlements" disabled

echo "==> entitlement files"

# The hardened runtime silently denies the microphone without audio input, and
# library validation would refuse the self-signed host's own frameworks.
task_expect_entitlement "the owner-only host may use the microphone" \
  "$task_local_entitlements" com.apple.security.device.audio-input
task_expect_entitlement "the owner-only host may load its own frameworks" \
  "$task_local_entitlements" com.apple.security.cs.disable-library-validation
task_expect_entitlement "the Apple-signed host may use the microphone" \
  "$task_release_entitlements" com.apple.security.device.audio-input

echo "==> release packager"

task_packager_lines="$(sed 's/^[[:space:]]*//' "$task_build_script")"

task_packager_line_number() {
  awk -v task_needle="$1" '
    { sub(/^[[:space:]]+/, "") }
    $0 == task_needle { print NR; exit }
  ' "$task_build_script"
}

if grep -Fqx 'source "$task_script_dir/lib/macos_hardened_runtime_guard.sh"' <<<"$task_packager_lines"; then
  task_pass "the packager loads the guard"
else
  task_fail "the packager does not source lib/macos_hardened_runtime_guard.sh"
fi

task_base_codesign_args="$(
  awk '
    { sub(/^[[:space:]]+/, "") }
    $0 == "task_codesign_args=(" { inside = 1; next }
    inside && $0 == ")" { exit }
    inside { print }
  ' "$task_build_script"
)"
if grep -Fqx -- '--options runtime' <<<"$task_base_codesign_args"; then
  task_pass "every signing mode uses the hardened runtime"
else
  task_fail "the base codesign arguments do not include --options runtime"
fi

task_dmg_line="$(task_packager_line_number 'rm -f "$task_dmg"')"
for task_guard_call in \
  'asael_verify_macos_hardened_runtime "$task_nested_code" "$task_share_extension_entitlements"' \
  'asael_verify_macos_hardened_runtime "$task_nested_code"' \
  'asael_verify_macos_hardened_runtime "$task_helper_app"' \
  'asael_verify_macos_hardened_runtime "$task_command_helper_app"' \
  'asael_verify_macos_hardened_runtime "$task_staged_app" "$task_main_entitlements" "$task_host_library_validation"'
do
  task_guard_line="$(task_packager_line_number "$task_guard_call")"
  if [[ -n "$task_guard_line" && -n "$task_dmg_line" && "$task_guard_line" -lt "$task_dmg_line" ]]; then
    task_pass "the packager runs $task_guard_call before creating the DMG"
  else
    task_fail "the packager does not run $task_guard_call before creating the DMG"
  fi
done

if [[ "$task_failures" -ne 0 ]]; then
  echo "$task_failures hardened runtime guard check(s) failed." >&2
  exit 1
fi
echo "All hardened runtime guard checks passed."
