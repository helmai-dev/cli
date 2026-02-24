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

# Parse the JSON manifest with grep/sed (no python3 dependency)
target_key="${platform}-${arch}"

if [[ "$desired_version" == "latest" ]]; then
  resolved_version="$(grep -o '"latest"[[:space:]]*:[[:space:]]*"[^"]*"' "$manifest_path" | sed 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
else
  resolved_version="$desired_version"
fi

if [[ -z "$resolved_version" ]]; then
  echo "Failed to resolve version from manifest."
  exit 1
fi

# Extract the artifact URL and SHA for our target
artifact_block="$(sed -n "/${target_key}/,/}/p" "$manifest_path" | head -4)"
artifact_url="$(echo "$artifact_block" | grep '"url"' | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
artifact_sha="$(echo "$artifact_block" | grep '"sha256"' | sed 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"

if [[ -z "$artifact_url" ]]; then
  echo "Artifact not found for target: $target_key"
  exit 1
fi

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
  unzip -qo "$archive_path" -d "$tmp_dir"
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
    echo ""
    echo "Helm needs elevated permissions to install to $install_dir"
    echo ""
    sudo mkdir -p "$install_dir"
    sudo cp "$tmp_dir/$HELM_BIN_NAME" "$install_dir/$HELM_BIN_NAME"
    sudo chmod 0755 "$install_dir/$HELM_BIN_NAME"
  fi

  # macOS: Bun-compiled binaries have an embedded linker signature that becomes
  # invalid after download/copy. Strip and re-sign the INSTALLED binary so
  # Gatekeeper allows execution. Must happen after cp, not before.
  if [[ "$platform" == "darwin" ]]; then
    target="$install_dir/$HELM_BIN_NAME"
    if [[ -w "$target" ]]; then
      xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
      codesign --remove-signature "$target" 2>/dev/null || true
      codesign --force --sign - "$target" 2>/dev/null || true
    else
      sudo xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
      sudo codesign --remove-signature "$target" 2>/dev/null || true
      sudo codesign --force --sign - "$target" 2>/dev/null || true
    fi
  fi
fi

echo "Installed $HELM_BIN_NAME v$resolved_version to $install_dir/$HELM_BIN_NAME"
if [[ "$platform" == "windows" ]] && [[ ":$PATH:" != *":$install_dir:"* ]]; then
  echo "Tip: add $install_dir to PATH to run helm from anywhere."
fi

if [[ "${HELM_UPDATE_ONLY:-}" == "1" ]]; then
  echo ""
else
  echo ""
  echo "Running initial setup..."
  HELM_INSTALL_SOURCE=curl "$install_dir/$HELM_BIN_NAME" init
  echo ""
fi
