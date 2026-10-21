#!/usr/bin/env bash
set -euo pipefail

# Only the changed Share transport and existing owner/ack boundary. Put compiler
# output and synthetic fixtures beside this external checkout, never in ~/Library.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
flutter_dir="$(cd -- "$script_dir/.." && pwd)"
test_root="${ASAEL_SHARE_TEST_OUTPUT:-$flutter_dir/build/shared-capture-tests}"
mkdir -p "$test_root/tmp" "$test_root/module-cache"
export TMPDIR="$test_root/tmp/"
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
xcrun swiftc -parse-as-library -Onone -D SHARED_CAPTURE_HANDOFF_TESTS \
  -sdk "$sdk_path" -target "$(uname -m)-apple-macos12.0" \
  -module-cache-path "$test_root/module-cache" \
  "$flutter_dir/macos/SharedCapture/SharedCaptureHandoff.swift" \
  "$flutter_dir/macos/Runner/DesktopWatchIntentStore.swift" \
  "$flutter_dir/macos/Runner/DesktopSharedCaptureReceipts.swift" \
  "$flutter_dir/macos/RunnerTests/SharedCaptureHandoffTests.swift" \
  -o "$test_root/shared-capture-tests"
"$test_root/shared-capture-tests"
xcrun swiftc -typecheck -sdk "$sdk_path" -target "$(uname -m)-apple-macos12.0" \
  -module-cache-path "$test_root/module-cache" \
  "$flutter_dir/macos/SharedCapture/SharedCaptureHandoff.swift" \
  "$flutter_dir/macos/ShareExtension/ShareViewController.swift"
