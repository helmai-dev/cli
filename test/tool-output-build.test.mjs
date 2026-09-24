import test from "node:test";
import assert from "node:assert/strict";

import { ruby } from "../dist/lib/tool-output/detectors/ruby.js";
import { dotnet } from "../dist/lib/tool-output/detectors/dotnet.js";
import { jvm } from "../dist/lib/tool-output/detectors/jvm.js";
import { docker } from "../dist/lib/tool-output/detectors/docker.js";
import { terraform } from "../dist/lib/tool-output/detectors/terraform.js";
import { packageManager } from "../dist/lib/tool-output/detectors/package-manager.js";
import { buildGenericSummary } from "../dist/lib/tool-output/helpers.js";

function parse(summary) {
  assert.ok(summary, "expected a summary");
  return JSON.parse(summary.text);
}

// ---------------------------------------------------------------------------
// Ruby: RSpec / Minitest / RuboCop
// ---------------------------------------------------------------------------

const RSPEC_PASS = `Randomized with seed 12345

Calculator
  adds numbers
  subtracts numbers
  handles negatives

Finished in 0.01234 seconds (files took 0.45678 seconds to load)
3 examples, 0 failures
`;

const RSPEC_FAIL = `Randomized with seed 12345

Calculator
  adds numbers
  subtracts numbers (FAILED - 1)

Failures:

  1) Calculator subtracts numbers
     Failure/Error: expect(calc.sub(3, 2)).to eq(2)

       expected: 2
            got: 1
     # ./spec/calculator_spec.rb:12:in \`block (2 levels) in <top (required)>'

Finished in 0.0142 seconds (files took 0.33 seconds to load)
2 examples, 1 failure
`;

const MINITEST_FAIL = `Run options: --seed 1234

# Running:

F...

Finished in 0.002345s, 1705.7569 runs/s, 2558.6353 assertions/s.

  1) Failure:
CalculatorTest#test_subtract [test/calculator_test.rb:12]:
Expected: 2
  Actual: 1

4 runs, 6 assertions, 1 failures, 0 errors, 0 skips
`;

const RUBOCOP_FAIL = `Inspecting 3 files
..C

Offenses:

app/models/user.rb:12:5: C: Style/FrozenStringLiteralComment: Missing frozen string literal comment.
app/models/user.rb:20:1: W: Layout/TrailingWhitespace: Trailing whitespace detected.
lib/tasks/foo.rake:3:1: E: Lint/Syntax: unexpected token tIDENTIFIER

3 files inspected, 3 offenses detected
`;

test("ruby detector summarizes a passing RSpec run", () => {
  const summary = ruby.summarize(RSPEC_PASS);
  const data = parse(summary);
  assert.equal(summary.tool, "rspec");
  assert.equal(data.result, "passed");
  assert.equal(data.tests, 3);
  assert.equal(data.passed, 3);
  assert.equal(data.failures, undefined);
});

test("ruby detector preserves the failing RSpec example and spec location", () => {
  const data = parse(ruby.summarize(RSPEC_FAIL));
  assert.equal(data.tool, "rspec");
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 1);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /Calculator subtracts numbers/);
  assert.match(data.failures[0], /expect\(calc\.sub\(3, 2\)\)\.to eq\(2\)/);
  assert.match(data.failures[0], /calculator_spec\.rb:12/);
});

test("ruby detector handles Minitest runs and failure headers", () => {
  const data = parse(ruby.summarize(MINITEST_FAIL));
  assert.equal(data.tool, "minitest");
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 3);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /CalculatorTest#test_subtract/);
  assert.match(data.failures[0], /calculator_test\.rb:12/);
});

test("ruby detector parses RuboCop offenses with cop names", () => {
  const data = parse(ruby.summarize(RUBOCOP_FAIL));
  assert.equal(data.tool, "rubocop");
  assert.equal(data.errors, 1);
  assert.equal(data.warnings, 2);
  assert.equal(data.items.length, 3);
  assert.deepEqual(data.items[0], {
    file: "app/models/user.rb",
    line: 12,
    col: 5,
    code: "Style/FrozenStringLiteralComment",
    message: "Missing frozen string literal comment.",
  });
  assert.equal(data.items[2].code, "Lint/Syntax");
});

// ---------------------------------------------------------------------------
// .NET: dotnet test / dotnet build
// ---------------------------------------------------------------------------

const DOTNET_TEST_PASS = `Determining projects to restore...
  Restored /app/Demo.Tests/Demo.Tests.csproj (in 1.2 sec).

  Demo.Tests -> /app/Demo.Tests/bin/Debug/net8.0/Demo.Tests.dll

Test run for /app/Demo.Tests/bin/Debug/net8.0/Demo.Tests.dll (.NETCoreApp,Version=v8.0)
Microsoft (R) Test Execution Command Line Tool Version 17.8.0
Starting test execution, please wait...
A total of 1 test files matched the specified pattern.

Passed!  - Failed:     0, Passed:     3, Skipped:     1, Total:     4, Duration: 123 ms - Demo.Tests.dll (net8.0)
`;

const DOTNET_BUILD_FAIL = `MSBuild version 17.8.3+195e7f5a3 for .NET
  Determining projects to restore...
  Restored /app/Demo/Demo.csproj (in 1.1 sec).
/app/Program.cs(12,5): error CS0103: The name 'foo' does not exist in the current context [/app/Demo/Demo.csproj]
/app/Program.cs(20,9): error CS0029: Cannot implicitly convert type 'string' to 'int' [/app/Demo/Demo.csproj]
/app/Demo/Demo.csproj(0,0): error MSB4025: The project file could not be loaded. [/app/Demo/Demo.csproj]

Build FAILED.
    0 Warning(s)
    2 Error(s)
`;

test("dotnet detector summarizes a passing dotnet test run", () => {
  const data = parse(dotnet.summarize(DOTNET_TEST_PASS));
  assert.equal(data.tool, "dotnet-test");
  assert.equal(data.result, "passed");
  assert.equal(data.passed, 3);
  assert.equal(data.skipped, 1);
  assert.equal(data.failed, undefined);
});

test("dotnet detector preserves CS/MSB build error identity", () => {
  const data = parse(dotnet.summarize(DOTNET_BUILD_FAIL));
  assert.equal(data.tool, "dotnet");
  assert.equal(data.errors, 3);
  assert.equal(data.items.length, 3);
  assert.deepEqual(data.items[0], {
    file: "/app/Program.cs",
    line: 12,
    col: 5,
    code: "CS0103",
    message: "The name 'foo' does not exist in the current context",
  });
  assert.equal(data.items[2].code, "MSB4025");
});

const DOTNET_TEST_FAIL = `Test run for /app/Demo.Tests/bin/Debug/net8.0/Demo.Tests.dll (.NETCoreApp,Version=v8.0)

Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 45 ms - Demo.Tests.dll (net8.0)

Failed Demo.Tests.CalculatorTests.Adds [1 ms]
  Error Message:
   Assert.Equal() Failure: Values differ
Expected: 4
Actual:   3
  Stack Trace:
     at Demo.Tests.CalculatorTests.Adds() in /app/tests/CalculatorTests.cs:line 12
`;

test("dotnet detector preserves failing dotnet test identity", () => {
  const data = parse(dotnet.summarize(DOTNET_TEST_FAIL));
  assert.equal(data.tool, "dotnet-test");
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /Demo\.Tests\.CalculatorTests\.Adds/);
  assert.match(data.failures[0], /CalculatorTests\.cs:12/);
});

// ---------------------------------------------------------------------------
// JVM: Gradle / Maven / javac
// ---------------------------------------------------------------------------

const GRADLE_PASS = `> Task :compileJava
> Task :processResources
> Task :classes
> Task :compileTestJava
> Task :test

BUILD SUCCESSFUL in 4s
6 actionable tasks: 6 executed
`;

const MAVEN_FAIL = `[INFO] Scanning for projects...
[INFO] Building demo 1.0-SNAPSHOT
[INFO] --- surefire:3.2.5:test (default-test) @ demo ---
[INFO] Running com.example.CartTest
[ERROR] testEmpty(com.example.CartTest)  Time elapsed: 0.05 s  <<< FAILURE!
org.opentest4j.AssertionFailedError: expected: <2> but was: <1>
\tat com.example.CartTest.testEmpty(CartTest.java:12)
[INFO]
[ERROR] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test
[INFO] BUILD FAILURE
`;

const JAVAC_FAIL = `src/main/java/com/example/App.java:12: error: cannot find symbol
    System.out.println(foo);
                       ^
  symbol:   variable foo
  location: class com.example.App
src/main/java/com/example/Util.java:4: warning: [deprecation] Date is deprecated
`;

test("jvm detector summarizes a successful Gradle build", () => {
  const data = parse(jvm.summarize(GRADLE_PASS));
  assert.equal(data.tool, "gradle");
  assert.equal(data.result, "passed");
  assert.equal(data.failed, undefined);
});

test("jvm detector preserves Maven test failure identity", () => {
  const data = parse(jvm.summarize(MAVEN_FAIL));
  assert.equal(data.tool, "maven");
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 1);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /com\.example\.CartTest\.testEmpty/);
  assert.match(data.failures[0], /CartTest\.java:12/);
});

test("jvm detector parses javac/kotlinc compile errors", () => {
  const data = parse(jvm.summarize(JAVAC_FAIL));
  assert.equal(data.tool, "javac");
  assert.equal(data.errors, 1);
  assert.equal(data.warnings, 1);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items[0], {
    file: "src/main/java/com/example/App.java",
    line: 12,
    message: "cannot find symbol",
  });
  assert.equal(data.items[1].message, "[deprecation] Date is deprecated");
});

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

const DOCKER_PASS = `[+] Building 12.3s (8/8) FINISHED
 => [internal] load build definition from Dockerfile
 => => transferring dockerfile: 512B
 => [1/4] FROM docker.io/library/node:20
 => => resolve docker.io/library/node:20
 => [2/4] WORKDIR /app
 => [3/4] COPY package*.json ./
 => [4/4] RUN npm ci
 => exporting to image
 => => naming to docker.io/library/demo:latest
Successfully built a1b2c3d4e5f6
Successfully tagged demo:latest
`;

const DOCKER_FAIL = `[+] Building 3.4s (5/6)
 => [internal] load build definition from Dockerfile
 => [1/3] FROM docker.io/library/node:20
 => [2/3] COPY . .
 => ERROR [3/3] RUN npm run build
------
 > [3/3] RUN npm run build:
0.123 > demo@1.0.0 build
0.123 > tsc && vite build
0.234 sh: vite: not found
------
ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 127
`;

test("docker detector summarizes a successful build's step count", () => {
  const data = parse(docker.summarize(DOCKER_PASS));
  assert.equal(data.tool, "docker");
  assert.equal(data.result, "passed");
  assert.equal(data.steps, 8);
  assert.equal(data.completed, 8);
  assert.equal(data.errors, undefined);
});

test("docker detector keeps build error lines verbatim", () => {
  const data = parse(docker.summarize(DOCKER_FAIL));
  assert.equal(data.tool, "docker");
  assert.equal(data.result, "failed");
  assert.equal(data.steps, 6);
  assert.equal(data.completed, 5);
  assert.ok(data.errors.length >= 2);
  assert.ok(data.errors.some((line) => /failed to solve/.test(line)));
  assert.ok(data.errors.some((line) => /ERROR \[3\/3\]/.test(line)));
});

// ---------------------------------------------------------------------------
// Terraform
// ---------------------------------------------------------------------------

const TERRAFORM_PASS = `Terraform will perform the following actions:

  # aws_instance.web will be created
  + resource "aws_instance" "web" {
      + ami           = "ami-12345678"
      + instance_type = "t3.micro"
    }

  # aws_security_group.web will be created
  + resource "aws_security_group" "web" {
      + name = "web-sg"
    }

Plan: 2 to add, 0 to change, 0 to destroy.
`;

const TERRAFORM_FAIL = `Terraform will perform the following actions:

  # aws_instance.web will be created
  + resource "aws_instance" "web" {
      + ami = "ami-12345678"
    }

Error: Reference to undeclared resource

  on main.tf line 12, in resource "aws_instance" "web":
  12:   ami = data.aws_ami.ubuntu.id

A managed resource "data.aws_ami.ubuntu" "ubuntu" has not been declared.
`;

test("terraform detector summarizes a plan's resource counts", () => {
  const data = parse(terraform.summarize(TERRAFORM_PASS));
  assert.equal(data.tool, "terraform");
  assert.equal(data.result, "passed");
  assert.equal(data.to_add, 2);
  assert.equal(data.errors, undefined);
});

test("terraform detector preserves the Error block and source location", () => {
  const data = parse(terraform.summarize(TERRAFORM_FAIL));
  assert.equal(data.tool, "terraform");
  assert.equal(data.result, "failed");
  assert.equal(data.errors.length, 1);
  assert.match(data.errors[0], /Reference to undeclared resource/);
  assert.match(data.errors[0], /main\.tf:12/);
});

// ---------------------------------------------------------------------------
// Package managers: npm / pnpm / bun
// ---------------------------------------------------------------------------

const NPM_PASS = `npm notice
npm notice New minor version of npm available! 10.5.0 -> 10.8.0
npm notice Changelog: https://github.com/npm/cli/releases/tag/v10.8.0
npm notice To update run: npm install -g npm@10.8.0
npm notice
added 245 packages, and audited 246 packages in 8s

79 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities
`;

const NPM_FAIL = `npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! demo@1.0.0 build: \`tsc && vite build\`
npm ERR! Exit status 1
npm ERR!
npm ERR! Failed at the demo@1.0.0 build script.
npm ERR! This is probably not a problem with npm. There is likely additional logging output above.

npm ERR! A complete log of this run can be found in: /Users/dev/.npm/_logs/2024-01-01T00_00_00_000Z-debug-0.log
`;

const NPM_DEPRECATIONS = `npm WARN deprecated har-validator@5.1.5: this library is no longer supported
npm WARN deprecated request@2.88.2: request has been deprecated, see https://github.com/request/request/issues/3142
added 120 packages, and audited 121 packages in 5s

5 packages are looking for funding
  run \`npm fund\` for details

found 3 vulnerabilities (1 moderate, 2 high)
`;

test("package-manager detector summarizes a passing npm install", () => {
  const data = parse(packageManager.summarize(NPM_PASS));
  assert.equal(data.tool, "npm");
  assert.equal(data.result, "passed");
  assert.equal(data.added, 245);
  assert.equal(data.audited, 246);
  assert.equal(data.errors, undefined);
});

test("package-manager detector keeps npm error lines verbatim", () => {
  const data = parse(packageManager.summarize(NPM_FAIL));
  assert.equal(data.tool, "npm");
  assert.equal(data.result, "failed");
  assert.ok(data.errors.length >= 5);
  assert.ok(data.errors.some((line) => /ELIFECYCLE/.test(line)));
});

test("package-manager detector keeps deprecations and vulnerability counts", () => {
  const data = parse(packageManager.summarize(NPM_DEPRECATIONS));
  assert.equal(data.tool, "npm");
  assert.equal(data.result, "passed");
  assert.equal(data.added, 120);
  assert.equal(data.vulnerabilities, 3);
  assert.equal(data.warnings.length, 2);
  assert.match(data.warnings[0], /har-validator/);
});

// ---------------------------------------------------------------------------
// Conservative null + generic helper
// ---------------------------------------------------------------------------

const PROSE = [
  "Here is a long note about deployment strategy and rollbacks. ".repeat(20),
  "The team agreed to revisit the caching layer next quarter. ".repeat(10),
].join("\n");

test("build/runtime detectors ignore unrelated prose", () => {
  assert.ok(PROSE.length > 400);
  for (const detector of [ruby, dotnet, jvm, docker, terraform, packageManager]) {
    assert.equal(detector.summarize(PROSE), null, `expected ${detector.id} to abstain`);
  }
});

test("buildGenericSummary keeps errors verbatim and caps each list", () => {
  const errors = Array.from({ length: 30 }, (_, i) => `error line ${i}`);
  const data = JSON.parse(
    buildGenericSummary({ tool: "docker", result: "failed", counts: { steps: 10 }, errors }).text,
  );
  assert.equal(data.tool, "docker");
  assert.equal(data.result, "failed");
  assert.equal(data.steps, 10);
  assert.equal(data.errors.length, 25);
  assert.equal(data.errors_truncated, 5);
  assert.equal(data.errors[0], "error line 0");
});

test("buildGenericSummary omits zero counts and empty fields", () => {
  const data = JSON.parse(buildGenericSummary({ tool: "terraform", counts: { added: 0 } }).text);
  assert.deepEqual(data, { tool: "terraform" });
});
