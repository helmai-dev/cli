# Homebrew formula for the Helm CLI (not Kubernetes Helm).
# Tap this repo, then install the qualified name:
#   brew tap helmai-dev/cli https://github.com/helmai-dev/cli
#   brew install helmai-dev/cli/helm
#
# The binary includes `helm proxy` and `helm wrap claude|codex`.
# Checksums are not pinned so `releases/latest` can move after a curl release.

class Helm < Formula
  desc "Laptop intercept between Claude Code / Codex and model providers"
  homepage "https://tryhelm.ai"
  version "1.3.18"
  license "MIT"

  livecheck do
    url "https://github.com/helmai-dev/cli/releases/latest"
    regex(%r{href=.*?/tag/v?(\d+(?:\.\d+)+)}i)
  end

  on_macos do
    on_arm do
      url "https://github.com/helmai-dev/cli/releases/latest/download/helm-darwin-arm64.tar.gz"
      sha256 :no_check
    end
    on_intel do
      url "https://github.com/helmai-dev/cli/releases/latest/download/helm-darwin-x64.tar.gz"
      sha256 :no_check
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/helmai-dev/cli/releases/latest/download/helm-linux-arm64.tar.gz"
      sha256 :no_check
    end
    on_intel do
      url "https://github.com/helmai-dev/cli/releases/latest/download/helm-linux-x64.tar.gz"
      sha256 :no_check
    end
  end

  def install
    bin.install "helm"
  end

  test do
    help = shell_output("#{bin}/helm --help")
    assert_match(/\bproxy\b/, help)
    assert_match(/\bwrap\b/, help)
    assert_match(/\bunwrap\b/, help)
    wrap_help = shell_output("#{bin}/helm wrap --help")
    assert_match(/claude/, wrap_help)
    assert_match(/codex/, wrap_help)
  end

  def caveats
    <<~EOS
      helm wrap claude and helm wrap codex point laptop Claude Code / Codex
      at a loopback proxy on this machine. Prompts stay on-device.

      This does not intercept Cursor cloud VMs.

      If homebrew-core helm (Kubernetes) is already linked, install with:
        brew install helmai-dev/cli/helm
    EOS
  end
end
