#!/usr/bin/env bash
set -euo pipefail

HELM_RELEASES_URL="https://github.com/helmai-dev/cli/releases/latest/download/releases.json"
HELM_INSTALL_DIR_DEFAULT=""
HELM_BIN_NAME="helm"

desired_version="latest"
install_dir="${HELM_INSTALL_DIR:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      desired_version="${2:-latest}"
      shift 2
      ;;
    --dir)
      install_dir="${2:-$HELM_INSTALL_DIR_DEFAULT}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$platform" in
  darwin*) platform="darwin" ;;
  linux*) platform="linux" ;;
  msys*|mingw*|cygwin*) platform="windows" ;;
  *)
    echo "Unsupported platform: $platform"
    exit 1
    ;;
esac

case "$arch" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
esac

if [[ -z "$install_dir" ]]; then
  if [[ "$platform" == "windows" ]]; then
    install_root="${HOME:-${USERPROFILE:-}}"
    if [[ -z "$install_root" ]]; then
      echo "Unable to determine home directory for Windows install."
      echo "Set HELM_INSTALL_DIR or pass --dir."
      exit 1
    fi
    install_dir="$install_root/bin"
  else
    install_dir="/usr/local/bin"
  fi
fi

if [[ "$platform" == "windows" ]]; then
  HELM_BIN_NAME="helm.exe"
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

manifest_path="$tmp_dir/releases.json"
curl -fsSL "$HELM_RELEASES_URL" -o "$manifest_path"

python3 - "$manifest_path" "$desired_version" "$platform" "$arch" <<'PY' > "$tmp_dir/selection.txt"
import json
import sys

manifest_path, desired_version, platform, arch = sys.argv[1:]
with open(manifest_path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)

resolved = data.get('latest') if desired_version == 'latest' else desired_version
release = data.get('versions', {}).get(resolved)
if not release:
    raise SystemExit(f"Release not found for version: {resolved}")

target_key = f"{platform}-{arch}"
artifact = release.get('artifacts', {}).get(target_key)
if not artifact:
    raise SystemExit(f"Artifact not found for target: {target_key}")

print(resolved)
print(artifact['url'])
print(artifact['sha256'])
PY

read -r resolved_version < "$tmp_dir/selection.txt"
read -r artifact_url < <(sed -n '2p' "$tmp_dir/selection.txt")
read -r artifact_sha < <(sed -n '3p' "$tmp_dir/selection.txt")

archive_path="$tmp_dir/helm.tar.gz"
archive_type="tar.gz"

if [[ "$artifact_url" == *.zip ]]; then
  archive_path="$tmp_dir/helm.zip"
  archive_type="zip"
fi

curl -fsSL "$artifact_url" -o "$archive_path"

calculated_sha="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
if [[ "$calculated_sha" != "$artifact_sha" ]]; then
  echo "Checksum verification failed"
  echo "Expected: $artifact_sha"
  echo "Actual:   $calculated_sha"
  exit 1
fi

if [[ "$archive_type" == "zip" ]]; then
  python3 - "$archive_path" "$tmp_dir" <<'PY'
import sys
import zipfile

archive_path, output_dir = sys.argv[1:]
with zipfile.ZipFile(archive_path, 'r') as archive:
    archive.extractall(output_dir)
PY
else
  tar -xzf "$archive_path" -C "$tmp_dir"
fi

if [[ "$platform" == "windows" ]]; then
  if [[ ! -d "$install_dir" ]]; then
    mkdir -p "$install_dir" 2>/dev/null || {
      echo "Unable to create $install_dir."
      echo "Use --dir to choose a writable install directory."
      exit 1
    }
  fi

  if [[ ! -w "$install_dir" ]]; then
    echo "Unable to write to $install_dir."
    echo "Use --dir to choose a writable install directory."
    exit 1
  fi

  cp "$tmp_dir/$HELM_BIN_NAME" "$install_dir/$HELM_BIN_NAME"
else
  if [[ ! -d "$install_dir" ]]; then
    mkdir -p "$install_dir" 2>/dev/null || true
  fi

  if [[ -w "$install_dir" ]]; then
    cp "$tmp_dir/$HELM_BIN_NAME" "$install_dir/$HELM_BIN_NAME"
    chmod 0755 "$install_dir/$HELM_BIN_NAME"
  else
    echo "Installing to $install_dir requires elevated permissions."
    sudo mkdir -p "$install_dir"
    sudo cp "$tmp_dir/$HELM_BIN_NAME" "$install_dir/$HELM_BIN_NAME"
    sudo chmod 0755 "$install_dir/$HELM_BIN_NAME"
  fi
fi

echo "Installed $HELM_BIN_NAME v$resolved_version to $install_dir/$HELM_BIN_NAME"
if [[ "$platform" == "windows" ]] && [[ ":$PATH:" != *":$install_dir:"* ]]; then
  echo "Tip: add $install_dir to PATH to run helm from anywhere."
fi

echo ""
echo "Running initial setup..."
HELM_INSTALL_SOURCE=curl "$install_dir/$HELM_BIN_NAME" init
