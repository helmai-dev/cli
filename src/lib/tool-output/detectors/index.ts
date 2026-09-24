/**
 * Detector registry. Order matters only for ties: the registry keeps the
 * smallest summary, so a broader detector cannot win over a more specific one
 * that produces a tighter result.
 */

import type { ToolOutputDetector } from "../types.js";
import { phpunit } from "./phpunit.js";
import { jest } from "./jest.js";
import { pytest } from "./pytest.js";
import { cargoTest } from "./cargo-test.js";
import { goTest } from "./go-test.js";
import { typescript } from "./typescript.js";
import { eslint } from "./eslint.js";
import { ruff } from "./ruff.js";
import { phpstan } from "./phpstan.js";
import { golangci } from "./golangci.js";
import { ruby } from "./ruby.js";
import { dotnet } from "./dotnet.js";
import { jvm } from "./jvm.js";
import { docker } from "./docker.js";
import { terraform } from "./terraform.js";
import { packageManager } from "./package-manager.js";

export const detectors: ToolOutputDetector[] = [
  phpunit,
  jest,
  pytest,
  cargoTest,
  goTest,
  typescript,
  eslint,
  ruff,
  phpstan,
  golangci,
  ruby,
  dotnet,
  jvm,
  docker,
  terraform,
  packageManager,
];
