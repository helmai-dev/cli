import test from "node:test";
import assert from "node:assert/strict";

import { phpunit } from "../dist/lib/tool-output/detectors/phpunit.js";
import { jest } from "../dist/lib/tool-output/detectors/jest.js";
import { pytest } from "../dist/lib/tool-output/detectors/pytest.js";
import { cargoTest } from "../dist/lib/tool-output/detectors/cargo-test.js";
import { goTest } from "../dist/lib/tool-output/detectors/go-test.js";
import { detectors } from "../dist/lib/tool-output/detectors/index.js";
import { summarizeToolOutput } from "../dist/lib/tool-output/registry.js";
import {
  buildTestSummary,
  parseDurationMs,
} from "../dist/lib/tool-output/helpers.js";

function parse(summary) {
  assert.ok(summary, "expected a summary");
  return JSON.parse(summary.text);
}

// ---------------------------------------------------------------------------
// PHPUnit / Pest
// ---------------------------------------------------------------------------

const PHPUNIT_PASS = `PHPUnit 11.0.0 by Sebastian Bergmann and contributors.

Runtime:       PHP 8.2.15
Configuration: /app/phpunit.xml

...                                                                 3 / 3 (100%)

Time: 00:00.123, Memory: 10.00 MB

Tests: 3 passed (8 assertions)
`;

const PHPUNIT_FAIL = `PHPUnit 11.0.0 by Sebastian Bergmann and contributors.

Runtime:       PHP 8.2.15
Configuration: /app/phpunit.xml

.F.                                                                 3 / 3 (100%)

There was 1 failure:

1) Tests\\Feature\\CheckoutTest::test_it_charges_the_card
Expected response status code [200] but received 500.
Failed asserting that false is true.

/app/tests/Feature/CheckoutTest.php:42

FAILURES!
Tests: 1 failed, 2 passed (6 assertions)
Time: 00:00.234, Memory: 12.00 MB
`;

const PEST_FAIL = `   FAIL  Tests\\Feature\\CartTest
  ✕ it rejects an empty cart
  → Expected the cart to be empty.

  at tests/Feature/CartTest.php:31

   PASS  Tests\\Feature\\CartTest
  ✓ it accepts a full cart

  Tests:    1 failed, 1 passed (3 assertions)
  Duration: 0.24s
`;

test("phpunit detector summarizes passing PHPUnit output", () => {
  const summary = phpunit.summarize(PHPUNIT_PASS);
  const data = parse(summary);
  assert.equal(summary.tool, "phpunit");
  assert.equal(data.tool, "phpunit");
  assert.equal(data.result, "passed");
  assert.equal(data.tests, 3);
  assert.equal(data.passed, 3);
  assert.equal(data.failed, undefined);
  assert.equal(data.duration_ms, 123);
  assert.equal(data.failures, undefined);
});

test("phpunit detector preserves failing PHPUnit test identity", () => {
  const data = parse(phpunit.summarize(PHPUNIT_FAIL));
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /CheckoutTest::test_it_charges_the_card/);
  assert.match(data.failures[0], /Expected response status code \[200\]/);
  assert.match(data.failures[0], /CheckoutTest\.php:42/);
});

test("phpunit detector handles Pest ✕/→ failures", () => {
  const data = parse(phpunit.summarize(PEST_FAIL));
  assert.equal(data.tool, "phpunit");
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 1);
  assert.equal(data.failed, 1);
  assert.equal(data.duration_ms, 240);
  assert.match(data.failures[0], /it rejects an empty cart/);
  assert.match(data.failures[0], /Expected the cart to be empty/);
  assert.match(data.failures[0], /CartTest\.php:31/);
});

// ---------------------------------------------------------------------------
// Jest / Vitest
// ---------------------------------------------------------------------------

const JEST_PASS = `PASS src/math.test.js
  Math
    ✓ adds numbers (5 ms)
    ✓ subtracts numbers (1 ms)

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
Time:        1.234 s
Ran all test suites.
`;

const JEST_FAIL = `FAIL src/cart.test.js
  Cart
    ✕ rejects an empty cart (12 ms)

  ● Cart › rejects an empty cart

    expect(received).toBe(expected)

    Expected: 2
    Received: 1

      10 |   expect(cart.total()).toBe(2);
         |                          ^
    at Object.<anonymous> (/app/src/cart.test.js:10:26)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Snapshots:   0 total
Time:        0.842 s
Ran all test suites.
`;

const VITEST_PASS = ` ✓ test/math.test.ts (3 tests) 15ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  123ms
`;

const VITEST_FAIL = ` ❯ test/cart.test.ts (2 tests | 1 failed) 20ms
   × rejects an empty cart
     → expected 1 to be 2
 FAIL  test/cart.test.ts > rejects an empty cart
AssertionError: expected 1 to be 2
 ❯ test/cart.test.ts:10:26

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Duration  95ms
`;

test("jest detector summarizes passing Jest output", () => {
  const data = parse(jest.summarize(JEST_PASS));
  assert.equal(data.tool, "jest");
  assert.equal(data.result, "passed");
  assert.equal(data.tests, 2);
  assert.equal(data.passed, 2);
  assert.equal(data.duration_ms, 1234);
  assert.equal(data.failures, undefined);
});

test("jest detector preserves failing Jest test identity", () => {
  const data = parse(jest.summarize(JEST_FAIL));
  assert.equal(data.result, "failed");
  assert.equal(data.failed, 1);
  assert.match(data.failures[0], /Cart › rejects an empty cart/);
  assert.match(data.failures[0], /cart\.test\.js:10:26/);
});

test("jest detector recognizes and labels Vitest output", () => {
  const passing = parse(jest.summarize(VITEST_PASS));
  assert.equal(passing.tool, "vitest");
  assert.equal(passing.result, "passed");
  assert.equal(passing.tests, 3);
  assert.equal(passing.duration_ms, 123);

  const failing = parse(jest.summarize(VITEST_FAIL));
  assert.equal(failing.tool, "vitest");
  assert.equal(failing.result, "failed");
  assert.equal(failing.passed, 1);
  assert.equal(failing.failed, 1);
  assert.match(failing.failures[0], /rejects an empty cart/);
  assert.match(failing.failures[0], /cart\.test\.ts:10:26/);
});

// ---------------------------------------------------------------------------
// pytest
// ---------------------------------------------------------------------------

const PYTEST_PASS = `============================= test session starts ==============================
platform darwin -- Python 3.11.4, pytest-7.4.0, pluggy-1.0.0
collected 5 items

tests/test_math.py .....                                                 [100%]

============================== 5 passed in 0.34s ==============================
`;

const PYTEST_FAIL = `============================= test session starts ==============================
platform darwin -- Python 3.11.4, pytest-7.4.0, pluggy-1.0.0
collected 3 items

tests/test_cart.py .F.                                                   [100%]

=================================== FAILURES ===================================
_________________________________ test_empty ___________________________________

    def test_empty():
>       assert cart.total() == 2
E       assert 1 == 2

tests/test_cart.py:10: AssertionError
=========================== short test summary info ============================
FAILED tests/test_cart.py::test_empty - assert 1 == 2
========================= 1 failed, 2 passed in 0.21s =========================
`;

test("pytest detector summarizes passing output", () => {
  const data = parse(pytest.summarize(PYTEST_PASS));
  assert.equal(data.tool, "pytest");
  assert.equal(data.result, "passed");
  assert.equal(data.tests, 5);
  assert.equal(data.passed, 5);
  assert.equal(data.duration_ms, 340);
});

test("pytest detector preserves FAILED lines", () => {
  const data = parse(pytest.summarize(PYTEST_FAIL));
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /tests\/test_cart\.py::test_empty/);
  assert.match(data.failures[0], /assert 1 == 2/);
});

// ---------------------------------------------------------------------------
// cargo test
// ---------------------------------------------------------------------------

const CARGO_PASS = `   Compiling demo v0.1.0 (/app/demo)
    Finished test [unoptimized + debuginfo] target(s) in 0.42s
     Running unittests src/lib.rs (target/debug/deps/demo-abc123)

running 3 tests
test math::tests::adds ... ok
test math::tests::subtracts ... ok
test math::tests::multiplies ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;

const CARGO_FAIL = `running 2 tests
test math::tests::adds ... ok
test math::tests::rejects ... FAILED

failures:

---- math::tests::rejects stdout ----
thread 'math::tests::rejects' panicked at src/lib.rs:42:5:
assertion failed: \`(left == right)\`
  left: \`1\`,
 right: \`2\`
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

failures:
    math::tests::rejects

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
`;

test("cargo test detector aggregates passing binaries", () => {
  const data = parse(cargoTest.summarize(CARGO_PASS));
  assert.equal(data.tool, "cargo-test");
  assert.equal(data.result, "passed");
  assert.equal(data.passed, 3);
  assert.equal(data.failed, undefined);
  assert.equal(data.duration_ms, 10);
});

test("cargo test detector preserves the failing test identity", () => {
  const data = parse(cargoTest.summarize(CARGO_FAIL));
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 1);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /math::tests::rejects/);
  assert.match(data.failures[0], /src\/lib\.rs:42:5/);
});

// ---------------------------------------------------------------------------
// go test
// ---------------------------------------------------------------------------

const GO_PASS = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
--- PASS: TestSub (0.00s)
PASS
ok  \texample.com/demo\t0.012s
`;

const GO_FAIL = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
    sub_test.go:12: got 1, want 2
--- FAIL: TestSub (0.00s)
FAIL
exit status 1
FAIL\texample.com/demo\t0.005s
`;

test("go test detector summarizes passing package output", () => {
  const data = parse(goTest.summarize(GO_PASS));
  assert.equal(data.tool, "go-test");
  assert.equal(data.result, "passed");
  assert.equal(data.passed, 2);
  assert.equal(data.failed, undefined);
  assert.equal(data.duration_ms, 12);
});

test("go test detector preserves failing test identity and detail", () => {
  const data = parse(goTest.summarize(GO_FAIL));
  assert.equal(data.result, "failed");
  assert.equal(data.passed, 1);
  assert.equal(data.failed, 1);
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0], /TestSub/);
  assert.match(data.failures[0], /sub_test\.go:12: got 1, want 2/);
});

// ---------------------------------------------------------------------------
// Registry / helpers
// ---------------------------------------------------------------------------

test("registry skips tiny output even when it looks like a test run", () => {
  assert.equal(summarizeToolOutput("Tests: 1 passed (1 assertion)"), null);
});

test("registry returns null for unrelated prose", () => {
  const prose = [
    "Here is a note about deployment. ".repeat(20),
    "The team agreed to revisit the caching layer next quarter. ".repeat(10),
  ].join("\n");
  assert.ok(prose.length > 400);
  assert.equal(summarizeToolOutput(prose), null);
});

test("registry does not mistake a generic log for go test output", () => {
  const log = Array.from({ length: 40 }, (_, i) => `ok chunk ${i} processed without error`).join(
    "\n",
  );
  assert.ok(log.length > 400);
  assert.equal(summarizeToolOutput(log), null);
});

test("registry picks a summary for real long output", () => {
  const summary = summarizeToolOutput(PYTEST_FAIL);
  assert.ok(summary);
  assert.ok(summary.text.length < PYTEST_FAIL.length);
  const data = JSON.parse(summary.text);
  assert.equal(data.tool, "pytest");
  assert.equal(data.result, "failed");
});

test("detectors list is ordered and complete", () => {
  assert.deepEqual(
    detectors.map((d) => d.id),
    [
      "phpunit",
      "jest",
      "pytest",
      "cargo-test",
      "go-test",
      "typescript",
      "eslint",
      "ruff",
      "phpstan",
      "golangci",
      "ruby",
      "dotnet",
      "jvm",
      "docker",
      "terraform",
      "package-manager",
    ],
  );
});

test("buildTestSummary caps failures and reports the truncation count", () => {
  const failures = Array.from({ length: 25 }, (_, i) => `test_${i}`);
  const summary = buildTestSummary({ tool: "pytest", passed: 1, failed: 25, failures });
  const data = JSON.parse(summary.text);
  assert.equal(data.failures.length, 20);
  assert.equal(data.failures_truncated, 5);
  assert.equal(data.failures[0], "test_0");
});

test("parseDurationMs handles colon and unit forms", () => {
  assert.equal(parseDurationMs("00:01.234"), 1234);
  assert.equal(parseDurationMs("1.5s"), 1500);
  assert.equal(parseDurationMs("250ms"), 250);
  assert.equal(parseDurationMs("2m"), 120000);
  assert.equal(parseDurationMs("nope"), null);
});
