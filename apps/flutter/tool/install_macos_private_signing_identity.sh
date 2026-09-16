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

if [[ -f "$task_keychain" && -f "$task_password_file" ]]; then
  task_password="$(<"$task_password_file")"
  security unlock-keychain -p "$task_password" "$task_keychain"
  if security find-certificate -c "$task_identity" "$task_keychain" >/dev/null 2>&1; then
    echo "Private macOS signing identity is already installed: $task_identity"
    exit 0
  fi
  echo "The signing keychain exists but does not contain $task_identity." >&2
  exit 1
fi

if [[ -e "$task_keychain" || -e "$task_password_file" ]]; then
  echo "A partial private signing setup already exists. Nothing was overwritten." >&2
  exit 1
fi

mkdir -p "$task_signing_dir"
chmod 700 "$task_signing_dir"
task_stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/asael-private-signing.XXXXXX")"
trap 'rm -rf "$task_stage_dir"' EXIT
task_stage_keychain="$task_stage_dir/asael-private-signing.keychain-db"
task_stage_password_file="$task_stage_dir/asael-private-signing.password"
task_password="$(openssl rand -hex 32)"

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

security create-keychain -p "$task_password" "$task_stage_keychain"
security unlock-keychain -p "$task_password" "$task_stage_keychain"
security import \
  "$task_stage_dir/identity.p12" \
  -k "$task_stage_keychain" \
  -P "$task_password" \
  -T /usr/bin/codesign \
  >/dev/null
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$task_password" \
  "$task_stage_keychain" \
  >/dev/null 2>&1

cp /bin/echo "$task_stage_dir/signing-canary"
codesign \
  --force \
  --keychain "$task_stage_keychain" \
  --sign "$task_identity" \
  "$task_stage_dir/signing-canary"
codesign --verify --strict "$task_stage_dir/signing-canary"

printf '%s\n' "$task_password" > "$task_stage_password_file"
chmod 600 "$task_stage_password_file" "$task_stage_keychain"
mv "$task_stage_keychain" "$task_keychain"
mv "$task_stage_password_file" "$task_password_file"

security unlock-keychain -p "$task_password" "$task_keychain"
security find-certificate -c "$task_identity" -Z "$task_keychain"
echo "Private macOS signing identity installed: $task_identity"
echo "The private key remains in Asael's dedicated user-only keychain."
