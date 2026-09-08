#!/usr/bin/env bash
set -euo pipefail

task_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
task_flutter_dir="$(cd "$task_script_dir/.." && pwd)"
task_keychain_service="${ASAEL_ANDROID_KEYCHAIN_SERVICE:-Asael Android Upload Keystore}"
task_keystore_path="${ASAEL_ANDROID_KEYSTORE_PATH:-$HOME/Library/Application Support/Asael/signing/asael-upload-keystore.jks}"
task_android_sdk_root="${ASAEL_ANDROID_SDK_ROOT:-$HOME/.asael/android-sdk}"

if [[ ! -f "$task_keystore_path" ]]; then
  echo "Android upload keystore not found: $task_keystore_path" >&2
  exit 1
fi

task_keystore_password="${ASAEL_ANDROID_KEYSTORE_PASSWORD:-$(security find-generic-password -s "$task_keychain_service" -w)}"
export ASAEL_ANDROID_KEYSTORE_PATH="$task_keystore_path"
export ASAEL_ANDROID_KEYSTORE_PASSWORD="$task_keystore_password"
export ASAEL_ANDROID_KEY_ALIAS="${ASAEL_ANDROID_KEY_ALIAS:-asael-upload}"
export ASAEL_ANDROID_KEY_PASSWORD="${ASAEL_ANDROID_KEY_PASSWORD:-$task_keystore_password}"

if [[ -d "$task_android_sdk_root" ]]; then
  export ANDROID_HOME="$task_android_sdk_root"
  export ANDROID_SDK_ROOT="$task_android_sdk_root"
fi

cd "$task_flutter_dir"
flutter build appbundle --release "$@"
