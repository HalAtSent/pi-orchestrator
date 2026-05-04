---
status: context
owner: engineering
last_verified: 2026-05-04
authority_sources:
  - ../../AGENTS.md
  - ../../package.json
  - ../../src/cli/pi.js
  - ../../test/work-order-cli.test.js
verify_with:
  - npm test
  - git diff --check
---

# Commands

Use existing npm tooling. This package is ESM and currently has no configured
alternate package manager, linter, formatter, type checker, build,
integration-test, e2e-test, database, or local app server.

## Install

Install dependencies only when needed:

```bash
npm install
```

## Focused Test

```bash
node --test test/<name>.test.js
```

Current focused test targets:

```bash
node --test test/work-order-schema.test.js
node --test test/work-order-fingerprint.test.js
node --test test/path-safety.test.js
node --test test/work-order-cli.test.js
node --test test/work-order-fixtures.test.js
```

## Full Test Suite

```bash
npm test
```

## CLI Smoke Check

```bash
node src/cli/pi.js validate-work-order test/fixtures/work-orders/valid-active.json
```

The package also exposes a `pi` bin in `package.json`; direct `node` execution
is the most explicit local smoke check.

## Patch Sanity

For unstaged tracked changes:

```bash
git diff --check
```

For staged changes, including new files staged for review:

```bash
git diff --cached --check
```

If the intended patch includes untracked files that are not staged, do not claim
patch sanity from `git diff --check` alone. Either stage the intended new files
and run the cached check above, or run an untracked-aware check:

```bash
git ls-files --others --exclude-standard -z | while IFS= read -r -d '' file; do
  output=$(git diff --no-index --check -- /dev/null "$file" 2>&1 || true)
  if [ -n "$output" ]; then
    printf '%s\n' "$output"
    exit 1
  fi
done
```

If a broader check is unavailable, too broad, or blocked by environment setup,
state that explicitly in the final response.
