#!/usr/bin/env bash
set -euo pipefail

HELM_RELEASES_URL="https://github.com/helmai-dev/cli/releases/latest/download/releases.json"
HELM_INSTALL_DIR_DEFAULT=""
HELM_BIN_NAME="${HELM_BIN_NAME:-helm}"

desired_version="latest"
install_dir="${HELM_INSTALL_DIR:-}"
force_install="${HELM_FORCE_INSTALL:-0}"
user_set_dir=0
if [[ -n "${HELM_INSTALL_DIR:-}" ]]; then
  user_set_dir=1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      desired_version="${2:-latest}"
      shift 2
      ;;
    --dir)
      install_dir="${2:-$HELM_INSTALL_DIR_DEFAULT}"
      user_set_dir=1
      shift 2
      ;;
    --bin-name)
      HELM_BIN_NAME="${2:-helm}"
      shift 2
      ;;
    --force)
      force_install=1
      shift
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

# The published artifact is always named `helm`; HELM_BIN_NAME only controls
# what we call it once installed, so --bin-name cannot break the download.
HELM_ARTIFACT_NAME="helm"
if [[ "$platform" == "windows" ]]; then
  HELM_ARTIFACT_NAME="helm.exe"
  [[ "$HELM_BIN_NAME" == *.exe ]] || HELM_BIN_NAME="$HELM_BIN_NAME.exe"
fi

is_kubernetes_helm() {
  local ver="${1:-}"
  [[ "$ver" == *"version.BuildInfo"* || "$ver" == *"Kubernetes"* ]]
}

# Our CLI prints a bare semver (commander). Kubernetes Helm prints a Go
# BuildInfo struct. Only treat the former as safe to replace on PATH.
is_our_helm() {
  local ver="${1:-}"
  if is_kubernetes_helm "$ver"; then
    return 1
  fi
  [[ "$ver" =~ [0-9]+\.[0-9]+ ]]
}

# Kubernetes Helm also installs a binary called `helm`, and it is on a great
# many developer machines. Overwriting it would break their cluster tooling
# with no warning, so refuse and explain rather than clobber. Identify the
# incumbent by its version output: Kubernetes Helm prints a Go
# `version.BuildInfo{...}` struct, ours prints a bare semver.
existing_bin="$(command -v "$HELM_BIN_NAME" 2>/dev/null || true)"
existing_version=""
if [[ -n "$existing_bin" ]]; then
  existing_version="$("$existing_bin" --version 2>&1 || true)"
fi
if [[ -n "$existing_bin" && "$force_install" != "1" ]]; then
  if is_kubernetes_helm "$existing_version"; then
    echo ""
    echo "Kubernetes Helm is already installed as '$HELM_BIN_NAME':"
    echo "  $existing_bin"
    echo ""
    echo "Installing here would overwrite it. Pick one:"
    echo ""
    echo "  # install the Helm CLI under a different name (recommended)"
    echo "  curl -fsSL https://tryhelm.ai/install | bash -s -- --bin-name helmcode"
    echo ""
    echo "  # or install somewhere else and put it earlier in PATH yourself"
    echo "  curl -fsSL https://tryhelm.ai/install | bash -s -- --dir \"$HOME/.helm/bin\""
    echo ""
    echo "  # or replace Kubernetes Helm on purpose"
    echo "  curl -fsSL https://tryhelm.ai/install | bash -s -- --force"
    echo ""
    exit 1
  fi
fi

# Homebrew on Apple Silicon puts /opt/homebrew/bin ahead of /usr/local/bin.
# If PATH already runs our CLI, install onto that directory so `helm wrap`
# is not a second hidden binary.
if [[ "$user_set_dir" != "1" && -n "$existing_bin" ]] && is_our_helm "$existing_version"; then
  install_dir="$(cd "$(dirname "$existing_bin")" && pwd)"
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

install_binary() {
  local dest="$1"
  local dest_dir
  dest_dir="$(dirname "$dest")"
  # Stage next to the destination so the final mv is an atomic rename on the
  # same filesystem. A plain cp onto the live path truncates the running inode:
  # ETXTBSY on Linux, and on macOS re-signing a binary that is currently
  # executing can kill the process (e.g. an active `helm relay`).
  local staged="$dest.tmp.$$"

  if [[ "$platform" == "windows" ]]; then
    if [[ ! -d "$dest_dir" ]]; then
      mkdir -p "$dest_dir" 2>/dev/null || {
        echo "Unable to create $dest_dir."
        echo "Use --dir to choose a writable install directory."
        return 1
      }
    fi
    if [[ ! -w "$dest_dir" ]]; then
      echo "Unable to write to $dest_dir."
      echo "Use --dir to choose a writable install directory."
      return 1
    fi
    cp "$tmp_dir/$HELM_ARTIFACT_NAME" "$dest"
    return 0
  fi

  if [[ ! -d "$dest_dir" ]]; then
    mkdir -p "$dest_dir" 2>/dev/null || true
  fi

  # macOS: Bun-compiled binaries have an embedded linker signature that becomes
  # invalid after download/copy, so the STAGED copy is stripped and re-signed
  # before it is renamed into place. The rename preserves file content, so the
  # signature stays valid and the live binary is never mutated in place.
  if [[ -d "$dest_dir" && -w "$dest_dir" && ( ! -e "$dest" || -w "$dest" ) ]]; then
    cp "$tmp_dir/$HELM_ARTIFACT_NAME" "$staged" || { rm -f "$staged"; return 1; }
    chmod 0755 "$staged"
    if [[ "$platform" == "darwin" ]]; then
      xattr -dr com.apple.quarantine "$staged" 2>/dev/null || true
      codesign --remove-signature "$staged" 2>/dev/null || true
      codesign --force --sign - "$staged" 2>/dev/null || true
    fi
    mv -f "$staged" "$dest" || { rm -f "$staged"; return 1; }
  else
    echo ""
    echo "Helm needs elevated permissions to install to $dest_dir"
    echo ""
    sudo mkdir -p "$dest_dir"
    sudo cp "$tmp_dir/$HELM_ARTIFACT_NAME" "$staged" || { sudo rm -f "$staged"; return 1; }
    sudo chmod 0755 "$staged"
    if [[ "$platform" == "darwin" ]]; then
      sudo xattr -dr com.apple.quarantine "$staged" 2>/dev/null || true
      sudo codesign --remove-signature "$staged" 2>/dev/null || true
      sudo codesign --force --sign - "$staged" 2>/dev/null || true
    fi
    sudo mv -f "$staged" "$dest" || { sudo rm -f "$staged"; return 1; }
  fi
}

if ! install_binary "$install_dir/$HELM_BIN_NAME"; then
  exit 1
fi

echo "Installed $HELM_BIN_NAME v$resolved_version to $install_dir/$HELM_BIN_NAME"

# A copy to $install_dir can still lose to an older helm earlier on PATH
# (Homebrew on macOS, an npm global, a leftover dev build). If that winner
# is our CLI, replace it so `helm wrap` is not a second hidden binary.
installed_bin="$install_dir/$HELM_BIN_NAME"
replaced_path_winner=0
hash -r 2>/dev/null || true
path_bin="$(command -v "$HELM_BIN_NAME" 2>/dev/null || true)"
if [[ -n "$path_bin" ]] && ! [[ "$path_bin" -ef "$installed_bin" ]]; then
  path_version="$("$path_bin" --version 2>&1 || true)"
  if is_our_helm "$path_version" && install_binary "$path_bin"; then
    echo "Replaced earlier $HELM_BIN_NAME on PATH: $path_bin"
    replaced_path_winner=1
    hash -r 2>/dev/null || true
    path_bin="$(command -v "$HELM_BIN_NAME" 2>/dev/null || true)"
  fi
fi

# Warn only when PATH still runs a different file we did not replace
# (typically Kubernetes Helm after --force, or an unwritable shadow).
if [[ -n "$path_bin" && "$replaced_path_winner" != "1" ]] && ! [[ "$path_bin" -ef "$installed_bin" ]]; then
  echo ""
  echo "Warning: a different $HELM_BIN_NAME is earlier on PATH."
  echo "  installed:     $installed_bin"
  echo "  PATH will run: $path_bin"
  echo ""
  echo "  $HELM_BIN_NAME --version will not show this install."
  echo ""
  echo "  Next steps:"
  echo "    # install onto a PATH directory that wins"
  echo "    curl -fsSL https://tryhelm.ai/install | bash -s -- --dir \"\$HOME/.local/bin\""
  echo ""
  echo "    # or remove/rename the shadowing binary"
  echo "    #   $path_bin"
  echo ""
  echo "    # or put $install_dir earlier in PATH"
fi

if [[ "$platform" == "windows" ]] && [[ ":$PATH:" != *":$install_dir:"* ]]; then
  echo "Tip: add $install_dir to PATH to run helm from anywhere."
fi

if [[ "${HELM_UPDATE_ONLY:-}" != "1" ]]; then
  # Chain straight into guided setup. Under `curl | bash` stdin is the pipe,
  # so re-attach the terminal explicitly; skip cleanly when headless.
  if [[ "${HELM_SKIP_SETUP:-}" != "1" ]] && [[ -e /dev/tty ]] && [[ -r /dev/tty ]]; then
    "$install_dir/$HELM_BIN_NAME" setup < /dev/tty || true
  else
    echo ""
    echo "Next steps:"
    echo "  helm wrap claude      point Claude Code at the local Helm proxy"
    echo "  helm wrap codex       point Codex at the local Helm proxy"
    echo "  helm setup            connect, wrap, context hooks, first scan"
    echo ""
  fi
fi
