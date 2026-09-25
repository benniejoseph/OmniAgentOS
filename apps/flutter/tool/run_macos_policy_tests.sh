#!/usr/bin/env bash
set -euo pipefail

# Runs the standalone macOS helper policy suites and type-checks every helper's
# production entry point. Each suite is compiled together with its helper using
# the helper's testing flag, which drops the production @main. The suites
# assert with precondition and exit, so they are built unoptimized to keep
# every check live.

task_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_macos_dir="$(cd "$task_script_dir/../macos" && pwd)"

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 64
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun is required to run the macOS policy suites." >&2
  exit 1
fi

task_sdk="$(xcrun --sdk macosx --show-sdk-path)"
task_target="$(uname -m)-apple-macos14.0"
task_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/asael-policy-tests.XXXXXX")"
trap 'rm -rf "$task_build_dir"' EXIT

task_swiftc() {
  xcrun swiftc \
    -parse-as-library \
    -Onone \
    -sdk "$task_sdk" \
    -target "$task_target" \
    -module-cache-path "$task_build_dir/module-cache" \
    "$@"
}

# Framework sets mirror the helper builds in build_macos_private_release.sh and
# install_macos_credential_broker*.sh.
task_credential_broker_frameworks=(
  -framework CryptoKit -framework LocalAuthentication -framework Security
)
task_computer_use_frameworks=(
  -framework AppKit -framework ApplicationServices -framework Carbon
  -framework CoreGraphics -framework CryptoKit -framework ScreenCaptureKit
  -framework Security
)
task_command_runner_frameworks=(-framework CryptoKit -framework Security)

task_run_suite() {
  local task_name="$1"
  local task_flag="$2"
  shift 2
  echo "==> $task_name"
  task_swiftc -D "$task_flag" "$@" -o "$task_build_dir/$task_name"
  "$task_build_dir/$task_name"
}

task_run_suite CredentialBrokerPolicyTests ASAEL_CREDENTIAL_BROKER_TESTING \
  "${task_credential_broker_frameworks[@]}" \
  "$task_macos_dir/CredentialBroker/BrokerMain.swift" \
  "$task_macos_dir/CredentialBroker/CredentialBrokerPolicyTests.swift"

task_run_suite CredentialBrokerV2PolicyTests ASAEL_CREDENTIAL_BROKER_TESTING \
  "${task_credential_broker_frameworks[@]}" \
  "$task_macos_dir/CredentialBrokerV2/BrokerMain.swift" \
  "$task_macos_dir/CredentialBrokerV2/CredentialBrokerV2PolicyTests.swift"

task_run_suite FocusSafeSnapshotPolicyTests ASAEL_COMPUTER_USE_HELPER_TESTING \
  "${task_computer_use_frameworks[@]}" \
  "$task_macos_dir/ComputerUseHelper/HelperMain.swift" \
  "$task_macos_dir/ComputerUseHelperTests/FocusSafeSnapshotPolicyTests.swift"

# Release builds compile the helpers only inside the signed packaging script, so
# type-check each production entry point here to catch breakage before release.
echo "==> production helper entry points"
task_swiftc -typecheck "${task_credential_broker_frameworks[@]}" \
  "$task_macos_dir/CredentialBroker/BrokerMain.swift"
task_swiftc -typecheck "${task_credential_broker_frameworks[@]}" \
  "$task_macos_dir/CredentialBrokerV2/BrokerMain.swift"
task_swiftc -typecheck "${task_computer_use_frameworks[@]}" \
  "$task_macos_dir/ComputerUseHelper/HelperMain.swift"
task_swiftc -typecheck "${task_command_runner_frameworks[@]}" \
  "$task_macos_dir/CommandRunnerHelper/HelperMain.swift"

echo "All macOS policy suites passed."
