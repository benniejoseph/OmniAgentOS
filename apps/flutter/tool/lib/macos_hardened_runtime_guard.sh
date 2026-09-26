#!/usr/bin/env bash

# Entitlements that reopen what the hardened runtime closes: debugger
# attachment, injected dyld libraries, and writable executable memory. No Asael
# process may carry them in any signing mode, even if an entitlement file
# lists them.
asael_macos_forbidden_runtime_entitlements=(
  com.apple.security.get-task-allow
  com.apple.security.cs.debugger
  com.apple.security.cs.allow-dyld-environment-variables
  com.apple.security.cs.allow-jit
  com.apple.security.cs.allow-unsigned-executable-memory
  com.apple.security.cs.disable-executable-page-protection
)
asael_macos_library_validation_exception="com.apple.security.cs.disable-library-validation"

asael_display_macos_code_slice() {
  local task_architecture="$1"
  shift
  if [[ -n "$task_architecture" ]]; then
    codesign -d -a "$task_architecture" "$@"
  else
    codesign -d "$@"
  fi
}

# Verifies every architecture slice of signed code. Each slice must carry the
# hardened runtime flag and exactly the entitlements in the expected file, or
# none when no file is given. A universal binary is checked slice by slice
# because codesign otherwise displays only the native slice. Library validation
# stays required unless the caller passes "disabled".
asael_verify_macos_hardened_runtime() {
  local task_code_path="$1"
  local task_expected_entitlements="${2:-}"
  local task_library_validation="${3:-required}"
  local task_expected=""
  local task_signature=""
  local task_architectures=""
  local task_architecture=""
  local task_label=""
  local task_flags=""
  local task_entitlements=""
  local task_forbidden=""
  local task_slices=()

  if [[ "$task_library_validation" != "required" && "$task_library_validation" != "disabled" ]]; then
    echo "Library validation must be required or disabled, not $task_library_validation." >&2
    return 1
  fi
  if [[ -n "$task_expected_entitlements" ]]; then
    if ! task_expected="$(plutil -convert xml1 -o - "$task_expected_entitlements" 2>/dev/null)"; then
      echo "Cannot read the expected entitlements $task_expected_entitlements." >&2
      return 1
    fi
  fi
  if ! task_signature="$(codesign -d --verbose=2 "$task_code_path" 2>&1)"; then
    echo "Cannot read the code signature of $task_code_path." >&2
    return 1
  fi
  task_architectures="$(
    printf '%s\n' "$task_signature" |
      sed -n 's/^Format=.*Mach-O universal (\(.*\))$/\1/p'
  )"
  if [[ -n "$task_architectures" ]]; then
    read -r -a task_slices <<<"$task_architectures"
  else
    task_slices=("")
  fi

  for task_architecture in "${task_slices[@]}"; do
    task_label="$task_code_path"
    if [[ -n "$task_architecture" ]]; then
      task_label="$task_code_path ($task_architecture)"
    fi
    if ! task_signature="$(
      asael_display_macos_code_slice "$task_architecture" --verbose=2 "$task_code_path" 2>&1
    )"; then
      echo "Cannot read the code signature of $task_label." >&2
      return 1
    fi
    task_flags="$(
      printf '%s\n' "$task_signature" |
        sed -n 's/^CodeDirectory .* flags=0x[0-9a-fA-F]*(\([^)]*\)).*$/\1/p'
    )"
    if [[ ",$task_flags," != *,runtime,* ]]; then
      echo "$task_label is not signed with the hardened runtime." >&2
      return 1
    fi

    if ! task_entitlements="$(
      asael_display_macos_code_slice "$task_architecture" --xml --entitlements - "$task_code_path" 2>/dev/null
    )"; then
      echo "Cannot read the entitlements of $task_label." >&2
      return 1
    fi
    if [[ -n "$task_entitlements" ]]; then
      if ! task_entitlements="$(printf '%s' "$task_entitlements" | plutil -convert xml1 -o - - 2>/dev/null)"; then
        echo "Cannot parse the entitlements of $task_label." >&2
        return 1
      fi
    fi
    for task_forbidden in "${asael_macos_forbidden_runtime_entitlements[@]}"; do
      if [[ "$task_entitlements" == *"<key>$task_forbidden</key>"* ]]; then
        echo "$task_label carries $task_forbidden, which defeats the hardened runtime." >&2
        return 1
      fi
    done
    if [[ "$task_library_validation" == "required" \
          && "$task_entitlements" == *"<key>$asael_macos_library_validation_exception</key>"* ]]; then
      echo "$task_label disables library validation, which only the owner-only host may do." >&2
      return 1
    fi
    if [[ "$task_entitlements" != "$task_expected" ]]; then
      echo "$task_label is signed with unexpected entitlements." >&2
      return 1
    fi
  done
}
