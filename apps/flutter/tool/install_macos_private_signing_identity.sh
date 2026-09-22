#!/usr/bin/env bash
set -euo pipefail

task_identity="${ASAEL_MACOS_LOCAL_SIGNING_IDENTITY:-Asael Private Code Signing}"
task_signing_dir="${ASAEL_MACOS_LOCAL_SIGNING_DIR:-${HOME}/Library/Application Support/Asael/signing}"
task_keychain="${ASAEL_MACOS_LOCAL_SIGNING_KEYCHAIN:-$task_signing_dir/asael-private-signing.keychain-db}"
task_password_file="${ASAEL_MACOS_LOCAL_SIGNING_PASSWORD_FILE:-$task_signing_dir/asael-private-signing.password}"

for task_command in openssl security codesign; do
  if ! command -v "$task_command" >/dev/null 2>&1; then
    echo "$task_command is required to create the private signing identity." >&2
    exit 1
  fi
done

mkdir -p "$task_signing_dir"
chmod 700 "$task_signing_dir"
task_install_lock="$task_signing_dir/.install.lock"
task_stage_dir=""
task_stage_password_file=""
task_created_keychain=0
task_created_password_file=0
task_install_committed=0

cleanup_private_signing_install() {
  local task_status=$?
  local task_lock_target=""
  trap - EXIT
  set +e
  if [[ "$task_install_committed" -ne 1 ]]; then
    # Delete only state whose ownership is positively established. If a
    # signal lands after keychain creation but before the success flag, leave
    # the exact-path partial artifact for manual recovery rather than risk
    # deleting a racing keychain. The password hard-link is inode-verified.
    if [[ "$task_created_keychain" -eq 1 ]]; then
      security delete-keychain "$task_keychain" >/dev/null 2>&1 || rm -f "$task_keychain"
    fi
    if [[ "$task_created_password_file" -eq 1 || \
          ( -n "$task_stage_password_file" && \
            -f "$task_password_file" && \
            -f "$task_stage_password_file" && \
            "$task_password_file" -ef "$task_stage_password_file" ) ]]; then
      rm -f "$task_password_file"
    fi
  fi
  # Remove the owned lock before its target so builders never observe a
  # broken symlink as an unlocked window during rollback.
  if [[ -L "$task_install_lock" && -n "$task_stage_dir" ]]; then
    task_lock_target="$(readlink "$task_install_lock" 2>/dev/null || true)"
    if [[ "$task_lock_target" == "$task_stage_dir" ]]; then
      unlink "$task_install_lock"
    fi
  fi
  if [[ -n "$task_stage_dir" && -d "$task_stage_dir" ]]; then
    rm -rf "$task_stage_dir"
  fi
  exit "$task_status"
}
trap cleanup_private_signing_install EXIT

task_stage_dir="$task_signing_dir/.install.$(openssl rand -hex 16)"
mkdir -m 700 "$task_stage_dir"
task_stage_password_file="$task_stage_dir/asael-private-signing.password"
# A symlink is an atomic, no-clobber lock with a verifiable owner token. A
# stale/broken lock remains visible to both installers and builders.
if ! ln -s "$task_stage_dir" "$task_install_lock" 2>/dev/null; then
  echo "Another private signing identity installation or validation is already in progress." >&2
  exit 1
fi

if [[ -f "$task_keychain" && -f "$task_password_file" ]]; then
  task_existing_canary="$task_stage_dir/signing-canary"
  task_password="$(<"$task_password_file")"
  security lock-keychain "$task_keychain"
  if ! security unlock-keychain -p "$task_password" "$task_keychain"; then
    unset task_password
    echo "The persisted password cannot cold-unlock the existing signing keychain." >&2
    echo "The existing identity was not changed or regenerated." >&2
    exit 1
  fi
  unset task_password
  if ! security find-certificate -c "$task_identity" "$task_keychain" >/dev/null 2>&1; then
    security lock-keychain "$task_keychain" >/dev/null 2>&1 || true
    echo "The existing signing keychain does not contain $task_identity." >&2
    exit 1
  fi
  cp /bin/echo "$task_existing_canary"
  if codesign \
      --force \
      --keychain "$task_keychain" \
      --sign "$task_identity" \
      "$task_existing_canary" && \
      codesign --verify --strict "$task_existing_canary"; then
    # Intentionally leave the dedicated keychain cold; release packaging
    # performs a just-in-time unlock immediately before each signature.
    security lock-keychain "$task_keychain"
    echo "Private macOS signing identity is already installed: $task_identity"
    exit 0
  fi
  security lock-keychain "$task_keychain" >/dev/null 2>&1 || true
  echo "The signing certificate is present, but its private key failed the cold signing canary." >&2
  echo "The existing identity was not changed or regenerated." >&2
  exit 1
fi

if [[ -e "$task_keychain" || -e "$task_password_file" ]]; then
  echo "A partial private signing setup already exists. Nothing was overwritten." >&2
  exit 1
fi

task_password="$(openssl rand -hex 32)"
printf '%s\n' "$task_password" > "$task_stage_password_file"
chmod 600 "$task_stage_password_file"

openssl req \
  -x509 \
  -newkey rsa:3072 \
  -nodes \
  -keyout "$task_stage_dir/private-key.pem" \
  -out "$task_stage_dir/certificate.pem" \
  -days 3650 \
  -subj "/CN=$task_identity/O=Asael" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  >/dev/null 2>&1

openssl pkcs12 \
  -legacy \
  -export \
  -inkey "$task_stage_dir/private-key.pem" \
  -in "$task_stage_dir/certificate.pem" \
  -out "$task_stage_dir/identity.p12" \
  -passout "pass:$task_password" \
  >/dev/null 2>&1

# Create the keychain at its permanent path. A legacy keychain must not be
# moved after Security has opened it because the daemon can retain the old
# path and later lose access to its private key.
security create-keychain -p "$task_password" "$task_keychain"
task_created_keychain=1
chmod 600 "$task_keychain"
security unlock-keychain -p "$task_password" "$task_keychain"
security import \
  "$task_stage_dir/identity.p12" \
  -k "$task_keychain" \
  -P "$task_password" \
  -T /usr/bin/codesign \
  >/dev/null
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$task_password" \
  "$task_keychain" \
  >/dev/null 2>&1

# Prove a genuinely cold installation using the generated password and the
# permanent keychain path. The canary exercises private-key access after the
# keychain has been locked; a certificate-only check is not sufficient.
security lock-keychain "$task_keychain"
unset task_password
task_password="$(<"$task_stage_password_file")"
security unlock-keychain -p "$task_password" "$task_keychain"
unset task_password
if ! security find-certificate -c "$task_identity" "$task_keychain" >/dev/null 2>&1; then
  echo "The installed keychain does not expose the expected signing certificate." >&2
  exit 1
fi
cp /bin/echo "$task_stage_dir/signing-canary"
codesign \
  --force \
  --keychain "$task_keychain" \
  --sign "$task_identity" \
  "$task_stage_dir/signing-canary"
codesign --verify --strict "$task_stage_dir/signing-canary"
security lock-keychain "$task_keychain"

# Publish readiness only after the cold canary succeeds. A hard link is an
# atomic, no-clobber publication because staging lives beside the final file.
# Builders also reject the install lock, closing the link/commit signal window.
ln "$task_stage_password_file" "$task_password_file"
task_created_password_file=1
task_install_committed=1
echo "Private macOS signing identity installed: $task_identity"
echo "The private key remains in Asael's dedicated user-only keychain."
