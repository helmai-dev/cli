import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installSh = path.join(repoRoot, "install.sh");

function pathWithoutNamedBin(basePath, binName) {
  return basePath
    .split(path.delimiter)
    .filter((dir) => dir && !existsSync(path.join(dir, binName)))
    .join(path.delimiter);
}

function writeExecutable(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "helm-install-sh-"));
  const payloadDir = path.join(root, "payload");
  mkdirSync(payloadDir);
  writeExecutable(path.join(payloadDir, "helm"), "#!/bin/sh\necho 1.3.9\n");

  const archive = path.join(root, "helm.tar.gz");
  execFileSync("tar", ["-czf", archive, "helm"], { cwd: payloadDir });
  const sha = execFileSync("shasum", ["-a", "256", archive], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)[0];

  const artifactUrl = "https://example.test/helm.tar.gz";
  const artifacts = Object.fromEntries(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"].map((key) => [
      key,
      { url: artifactUrl, sha256: sha },
    ]),
  );
  const manifestPath = path.join(root, "releases.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      latest: "1.3.9",
      versions: {
        "1.3.9": {
          published_at: "2026-08-18T00:00:00Z",
          artifacts,
        },
      },
    }),
  );

  const fakeBin = path.join(root, "fake-bin");
  mkdirSync(fakeBin);
  writeExecutable(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) out="\${2:-}"; shift 2 ;;
    -fsSL|-f|-s|-S|-L|--fail|--silent|--show-error|--location) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ -z "$out" || -z "$url" ]]; then
  echo "fake curl: expected curl -fsSL <url> -o <path>" >&2
  exit 1
fi
if [[ "$url" == *releases.json* ]]; then
  cp ${JSON.stringify(manifestPath)} "$out"
else
  cp ${JSON.stringify(archive)} "$out"
fi
`,
  );

  return { root, fakeBin };
}

function runInstall({
  fixture,
  installDir,
  pathPrefix = [],
  extraEnv = {},
  args = [],
  passDir = true,
}) {
  const cleanPath = pathWithoutNamedBin(process.env.PATH ?? "", "helm");
  const pathEnv = [...pathPrefix, fixture.fakeBin, ...(passDir ? [installDir] : []), cleanPath].join(
    path.delimiter,
  );
  const argv = passDir ? [installSh, "--dir", installDir, ...args] : [installSh, ...args];
  return spawnSync("bash", argv, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: pathEnv,
      HELM_SKIP_SETUP: "1",
      HELM_UPDATE_ONLY: "1",
      HOME: fixture.root,
      ...extraEnv,
    },
  });
}

function combinedOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

test("our CLI already on PATH is replaced so wrap is not a second hidden binary", () => {
  const fixture = createFixture();
  try {
    const installDir = path.join(fixture.root, "usr-local-bin");
    const shadowDir = path.join(fixture.root, "opt-homebrew-bin");
    mkdirSync(installDir);
    const shadowBin = path.join(shadowDir, "helm");
    writeExecutable(shadowBin, "#!/bin/sh\necho 1.3.7\n");

    const result = runInstall({ fixture, installDir, pathPrefix: [shadowDir] });
    const output = combinedOutput(result);
    const installedBin = path.join(installDir, "helm");

    assert.equal(result.status, 0, output);
    assert.match(output, /Installed helm v1\.3\.9 to /);
    assert.match(output, /usr-local-bin\/helm/);
    assert.match(output, /Replaced earlier helm on PATH: .*opt-homebrew-bin\/helm/);
    assert.doesNotMatch(output, /will not show this install/i);
    assert.doesNotMatch(output, /Kubernetes Helm/);
    assert.equal(existsSync(installedBin), true);
    assert.equal(readFileSync(shadowBin, "utf8"), readFileSync(installedBin, "utf8"));
    assert.match(readFileSync(shadowBin, "utf8"), /echo 1\.3\.9/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("default install dir follows our CLI on PATH so Homebrew wins the copy", () => {
  const fixture = createFixture();
  try {
    const shadowDir = path.join(fixture.root, "opt-homebrew-bin");
    const shadowBin = path.join(shadowDir, "helm");
    writeExecutable(shadowBin, "#!/bin/sh\necho 1.3.7\n");

    const result = runInstall({
      fixture,
      installDir: path.join(fixture.root, "unused-usr-local-bin"),
      pathPrefix: [shadowDir],
      passDir: false,
    });
    const output = combinedOutput(result);

    assert.equal(result.status, 0, output);
    assert.match(output, /Installed helm v1\.3\.9 to .*opt-homebrew-bin\/helm/);
    assert.doesNotMatch(output, /will not show this install/i);
    assert.match(readFileSync(shadowBin, "utf8"), /echo 1\.3\.9/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Kubernetes Helm incumbent still refuses", () => {
  const fixture = createFixture();
  try {
    const installDir = path.join(fixture.root, "usr-local-bin");
    const k8sDir = path.join(fixture.root, "usr-bin");
    mkdirSync(installDir);
    writeExecutable(
      path.join(k8sDir, "helm"),
      '#!/bin/sh\necho \'version.BuildInfo{Version:"v3.14.0"}\'\n',
    );

    const result = runInstall({ fixture, installDir, pathPrefix: [k8sDir] });
    const output = combinedOutput(result);

    assert.equal(result.status, 1, output);
    assert.match(output, /Kubernetes Helm is already installed/);
    assert.match(output, /--bin-name/);
    assert.match(output, /--dir/);
    assert.match(output, /--force/);
    assert.equal(existsSync(path.join(installDir, "helm")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("no incumbent produces no PATH shadow warning", () => {
  const fixture = createFixture();
  try {
    const installDir = path.join(fixture.root, "usr-local-bin");
    mkdirSync(installDir);

    const result = runInstall({ fixture, installDir });
    const output = combinedOutput(result);

    assert.equal(result.status, 0, output);
    assert.match(output, /Installed helm v1\.3\.9 to /);
    assert.doesNotMatch(output, /will not show this install/i);
    assert.doesNotMatch(output, /different helm/i);
    assert.equal(existsSync(path.join(installDir, "helm")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("headless next steps name helm wrap claude and helm wrap codex", () => {
  const fixture = createFixture();
  try {
    const installDir = path.join(fixture.root, "usr-local-bin");
    mkdirSync(installDir);

    const result = runInstall({
      fixture,
      installDir,
      extraEnv: { HELM_SKIP_SETUP: "1", HELM_UPDATE_ONLY: "" },
    });
    const output = combinedOutput(result);

    assert.equal(result.status, 0, output);
    assert.match(output, /helm wrap claude/);
    assert.match(output, /helm wrap codex/);
    assert.doesNotMatch(output, /prompt cach/i);
    assert.doesNotMatch(output, /Cursor cloud/i);
    assert.doesNotMatch(output, /shared_context_savings_usd/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reinstall replaces via rename: new inode, no staged temp leftovers", () => {
  const fixture = createFixture();
  try {
    const installDir = path.join(fixture.root, "usr-local-bin");
    mkdirSync(installDir);
    const installedBin = path.join(installDir, "helm");
    writeExecutable(installedBin, "#!/bin/sh\necho 1.3.7\n");
    const before = statSync(installedBin).ino;

    const result = runInstall({ fixture, installDir });
    const output = combinedOutput(result);

    assert.equal(result.status, 0, output);
    // A rename swaps the inode; an in-place cp would truncate the running one
    // (ETXTBSY on Linux, and a killed live relay on macOS after re-signing).
    assert.notEqual(statSync(installedBin).ino, before);
    assert.match(readFileSync(installedBin, "utf8"), /echo 1\.3\.9/);
    const leftovers = readdirSync(installDir).filter((name) => name.includes(".tmp."));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Homebrew formula version matches package.json and requires proxy plus wrap", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const formula = readFileSync(path.join(repoRoot, "Formula/helm.rb"), "utf8");
  assert.match(formula, new RegExp(`version "${pkg.version}"`));
  assert.match(formula, /helm wrap claude/);
  assert.match(formula, /helm wrap codex/);
  assert.match(formula, /helm proxy/);
  assert.match(formula, /does not intercept Cursor cloud VMs/);
  assert.doesNotMatch(formula, /shared_context_savings_usd/);
  assert.doesNotMatch(formula, /prompt cach/i);
});
