import test from "node:test";
import assert from "node:assert/strict";

import { typescript } from "../dist/lib/tool-output/detectors/typescript.js";
import { eslint } from "../dist/lib/tool-output/detectors/eslint.js";
import { ruff } from "../dist/lib/tool-output/detectors/ruff.js";
import { phpstan } from "../dist/lib/tool-output/detectors/phpstan.js";
import { golangci } from "../dist/lib/tool-output/detectors/golangci.js";
import {
  buildDiagnosticSummary,
  parseFileLineCol,
} from "../dist/lib/tool-output/diagnostics.js";

function parse(summary) {
  assert.ok(summary, "expected a summary");
  return JSON.parse(summary.text);
}

// ---------------------------------------------------------------------------
// TypeScript / vue-tsc
// ---------------------------------------------------------------------------

const TSC_OUT = `> tsc --noEmit

src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/app.ts(20,1): error TS2304: Cannot find name 'foo'.
src/util.ts(3,7): error TS2835: Relative import paths need explicit file extensions.

Found 3 errors in 2 files.
`;

const VUE_TSC_OUT = `$ vue-tsc --noEmit
src/components/Cart.vue(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/lib/total.ts(40,11): error TS2345: Argument of type 'null' is not assignable to parameter of type 'number'.
src/lib/total.ts(88,3): warning TS6133: 'unused' is declared but its value is never read.

Found 2 errors in 2 files.
`;

test("typescript detector parses tsc file(line,col) diagnostics", () => {
  const summary = typescript.summarize(TSC_OUT);
  const data = parse(summary);
  assert.equal(summary.tool, "tsc");
  assert.equal(data.tool, "tsc");
  assert.equal(data.errors, 3);
  assert.equal(data.warnings, undefined);
  assert.equal(data.items.length, 3);
  assert.deepEqual(data.items[0], {
    file: "src/app.ts",
    line: 12,
    col: 5,
    code: "TS2322",
    message: "Type 'string' is not assignable to type 'number'.",
  });
  assert.equal(data.items[2].code, "TS2835");
});

test("typescript detector labels vue-tsc and keeps warnings", () => {
  const data = parse(typescript.summarize(VUE_TSC_OUT));
  assert.equal(data.tool, "vue-tsc");
  assert.equal(data.errors, 2);
  assert.equal(data.warnings, 1);
  assert.equal(data.items[0].file, "src/components/Cart.vue");
  assert.equal(data.items[2].code, "TS6133");
});

// ---------------------------------------------------------------------------
// ESLint stylish
// ---------------------------------------------------------------------------

const ESLINT_OUT = `> eslint src --ext .ts

/Users/dev/project/src/app.ts
  12:5  error  'foo' is defined but never used      no-unused-vars
  18:9  warning  Missing semicolon                  semi

/Users/dev/project/src/util.ts
  3:1  error  'bar' is not defined                  no-undef

✖ 3 problems (2 errors, 1 warning)
`;

test("eslint detector preserves file, rule, and message per finding", () => {
  const data = parse(eslint.summarize(ESLINT_OUT));
  assert.equal(data.tool, "eslint");
  assert.equal(data.errors, 2);
  assert.equal(data.warnings, 1);
  assert.equal(data.items.length, 3);
  assert.deepEqual(data.items[0], {
    file: "/Users/dev/project/src/app.ts",
    line: 12,
    col: 5,
    code: "no-unused-vars",
    message: "'foo' is defined but never used",
  });
  assert.equal(data.items[2].file, "/Users/dev/project/src/util.ts");
  assert.equal(data.items[2].code, "no-undef");
});

// ---------------------------------------------------------------------------
// Ruff / flake8
// ---------------------------------------------------------------------------

const RUFF_OUT = `$ ruff check .
src/app.py:12:5: F401 [*] \`os\` imported but unused
src/app.py:20:1: E501 Line too long (95 > 88 characters)
src/models/user.py:3:8: F841 Local variable \`x\` is assigned to but never used

Found 3 errors.
[*] 1 fixable with the \`--fix\` option.
`;

const FLAKE8_OUT = `$ flake8 src
src/app.py:12:5: E302 expected 2 blank lines, found 1
src/util.py:4:80: E501 line too long (92 > 79 characters)
src/util.py:9:1: W291 trailing whitespace
`;

test("ruff detector parses code-shaped rows and the Found footer", () => {
  const data = parse(ruff.summarize(RUFF_OUT));
  assert.equal(data.tool, "ruff");
  assert.equal(data.errors, 3);
  assert.equal(data.items.length, 3);
  assert.deepEqual(data.items[0], {
    file: "src/app.py",
    line: 12,
    col: 5,
    code: "F401",
    message: "[*] `os` imported but unused",
  });
  assert.equal(data.items[2].code, "F841");
});

test("ruff detector labels code-only flake8 output and counts W codes", () => {
  const data = parse(ruff.summarize(FLAKE8_OUT));
  assert.equal(data.tool, "flake8");
  assert.equal(data.errors, 2);
  assert.equal(data.warnings, 1);
  assert.equal(data.items.length, 3);
  assert.equal(data.items[2].code, "W291");
});

// ---------------------------------------------------------------------------
// PHPStan / Psalm
// ---------------------------------------------------------------------------

const PHPSTAN_TABLE_OUT = `Note: Using configuration file /app/phpstan.neon.

 ------ ---------------------------------------------------------------------
  Line   src/Service/OrderService.php
 ------ ---------------------------------------------------------------------
  23     Parameter #1 $id of method OrderService::find() expects int, string given.
  57     Call to an undefined method OrderService::refund().
 ------ ---------------------------------------------------------------------

 [ERROR] Found 2 errors
`;

const PSALM_OUT = `$ psalm --output-format=console
ERROR: InvalidReturnType - src/Service/UserService.php:42:15 - The declared return type 'string' for UserService::name is incorrect
ERROR: PossiblyUndefinedMethod - src/Service/UserService.php:88:9 - Method UserService::save does not exist

2 errors found
`;

test("phpstan detector parses the Line/table format", () => {
  const data = parse(phpstan.summarize(PHPSTAN_TABLE_OUT));
  assert.equal(data.tool, "phpstan");
  assert.equal(data.errors, 2);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items[0], {
    file: "src/Service/OrderService.php",
    line: 23,
    message: "Parameter #1 $id of method OrderService::find() expects int, string given.",
  });
  assert.equal(data.items[1].line, 57);
});

test("phpstan detector recognizes Psalm ERROR rows", () => {
  const data = parse(phpstan.summarize(PSALM_OUT));
  assert.equal(data.tool, "phpstan");
  assert.equal(data.errors, 2);
  assert.equal(data.items[0].code, "InvalidReturnType");
  assert.equal(data.items[0].file, "src/Service/UserService.php");
  assert.equal(data.items[0].line, 42);
  assert.equal(data.items[0].col, 15);
});

// ---------------------------------------------------------------------------
// golangci-lint / go vet
// ---------------------------------------------------------------------------

const GOLANGCI_OUT = `$ golangci-lint run
cmd/server/main.go:42:9: Error return value of \`db.Close\` is not checked (errcheck)
internal/cart/cart.go:15:2: undefined: helper (typecheck)
internal/cart/cart.go:88:11: \`fmt.Sprintf\` can be replaced with \`strconv.Itoa\` (perfsprint)

3 issues found
`;

const GO_VET_OUT = `# example.com/demo/cart
./cart.go:12:34: fmt.Printf format %d has arg s of wrong type string
./cart.go:20:2: unreachable code

exit status 1
`;

test("golangci detector keeps the linter name as the finding code", () => {
  const data = parse(golangci.summarize(GOLANGCI_OUT));
  assert.equal(data.tool, "golangci-lint");
  assert.equal(data.errors, 3);
  assert.equal(data.items.length, 3);
  assert.deepEqual(data.items[0], {
    file: "cmd/server/main.go",
    line: 42,
    col: 9,
    code: "errcheck",
    message: "Error return value of `db.Close` is not checked",
  });
  assert.equal(data.items[1].code, "typecheck");
});

test("golangci detector recognizes go vet output", () => {
  const data = parse(golangci.summarize(GO_VET_OUT));
  assert.equal(data.tool, "go-vet");
  assert.equal(data.errors, 2);
  assert.equal(data.items[0].file, "./cart.go");
  assert.equal(data.items[0].line, 12);
  assert.equal(data.items[0].col, 34);
});

// ---------------------------------------------------------------------------
// Conservative null + shared helper
// ---------------------------------------------------------------------------

const PROSE = [
  "Here is a long note about deployment strategy and rollbacks. ".repeat(20),
  "The team agreed to revisit the caching layer next quarter. ".repeat(10),
].join("\n");

test("diagnostic detectors ignore unrelated prose", () => {
  assert.ok(PROSE.length > 400);
  for (const detector of [typescript, eslint, ruff, phpstan, golangci]) {
    assert.equal(detector.summarize(PROSE), null, `expected ${detector.id} to abstain`);
  }
});

test("buildDiagnosticSummary dedupes identical findings", () => {
  const item = { file: "a.ts", line: 1, col: 2, code: "TS1", message: "boom" };
  const data = JSON.parse(
    buildDiagnosticSummary({ tool: "tsc", errors: 2, items: [item, { ...item }] }).text,
  );
  assert.equal(data.items.length, 1);
  assert.equal(data.errors, 2);
});

test("buildDiagnosticSummary caps items and reports the truncation count", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    file: `src/f${i}.ts`,
    line: i + 1,
    col: 1,
    code: "TS2322",
    message: `Error number ${i}`,
  }));
  const data = JSON.parse(buildDiagnosticSummary({ tool: "tsc", errors: 30, items }).text);
  assert.equal(data.items.length, 25);
  assert.equal(data.items_truncated, 5);
  assert.equal(data.errors, 30);
  assert.equal(data.items[0].file, "src/f0.ts");
  assert.equal(data.items[0].message, "Error number 0");
  assert.equal(data.items[24].message, "Error number 24");
});

test("buildDiagnosticSummary omits zero and empty fields", () => {
  const data = JSON.parse(buildDiagnosticSummary({ tool: "eslint" }).text);
  assert.deepEqual(data, { tool: "eslint" });
});

test("parseFileLineCol handles colon and drive-letter forms", () => {
  assert.deepEqual(parseFileLineCol("src/app.py:12:5: F401 unused"), {
    file: "src/app.py",
    line: 12,
    col: 5,
  });
  assert.deepEqual(parseFileLineCol("src/app.py:12: message"), {
    file: "src/app.py",
    line: 12,
  });
  assert.deepEqual(parseFileLineCol("C:\\proj\\app.py:9:1: E1 message"), {
    file: "C:\\proj\\app.py",
    line: 9,
    col: 1,
  });
  assert.equal(parseFileLineCol("no location here"), null);
});
