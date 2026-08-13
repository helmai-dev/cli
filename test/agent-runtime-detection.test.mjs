import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandAvailable } from "../dist/lib/agent-runtime-detection.js";

test("runtime detection checks executability without launching agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-runtime-test-"));
  const executable = path.join(root, "example-agent");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(commandAvailable("example-agent", root, "darwin"), true);
  assert.equal(commandAvailable("missing-agent", root, "darwin"), false);
});
