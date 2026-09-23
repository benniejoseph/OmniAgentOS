#!/usr/bin/env bash

asael_read_macos_designated_requirement() {
  local task_app_path="$1"
  local task_requirement_output=""
  local task_requirement=""

  if ! task_requirement_output="$(codesign -d -r- "$task_app_path" 2>&1)"; then
    return 1
  fi
  task_requirement="$(
    printf '%s\n' "$task_requirement_output" |
      sed -n 's/^designated => //p'
  )"
  if [[ -z "$task_requirement" ]]; then
    return 1
  fi
  printf '%s\n' "$task_requirement"
}

asael_guard_macos_signing_rotation() {
  local task_installed_requirement="$1"
  local task_replacement_requirement="$2"
  local task_rotation_acknowledgement="${3:-}"

  if [[ -z "$task_installed_requirement" || -z "$task_replacement_requirement" ]]; then
    echo "Cannot verify the installed and replacement macOS signing requirements." >&2
    return 1
  fi
  if [[ "$task_installed_requirement" == "$task_replacement_requirement" ]]; then
    return 0
  fi
  if [[ "$task_rotation_acknowledgement" != "1" ]]; then
    echo "The installed Asael app and replacement build have different designated requirements." >&2
    echo "Packaging stopped to protect the existing macOS Accessibility and Screen Recording grants." >&2
    echo "For an intentional signing rotation, rerun with ASAEL_MACOS_ACKNOWLEDGE_SIGNING_ROTATION=1." >&2
    return 1
  fi

  cat <<'GUIDANCE'
Signing rotation acknowledged for app.omniagent.omniagent.
After installing the replacement build:
1. Fully quit Asael.
2. Run: tccutil reset Accessibility app.omniagent.omniagent
3. Run: tccutil reset ScreenCapture app.omniagent.omniagent
4. Relaunch Asael and choose Grant macOS access.
GUIDANCE
}
