---
status: context
owner: engineering
last_verified: 2026-05-06
authority_sources:
  - ../../AGENTS.md
  - ../../package.json
  - ../../test/work-order-schema.test.js
  - ../../test/work-order-fingerprint.test.js
  - ../../test/path-safety.test.js
  - ../../test/work-order-cli.test.js
  - ../../test/work-order-fixtures.test.js
verify_with:
  - npm test
  - git diff --check
---

# Testing

When changing behavior, add or update focused tests unless there is a clear
reason not to.

## Expectations

- Prefer behavior-focused tests over implementation-detail tests.
- Include regression tests for bug fixes.
- For validators and contracts, cover accepted-invalid and rejected-valid cases
  where practical.
- Cover malformed inputs, path safety, approval/fingerprint binding, and
  fail-closed behavior when those surfaces are in scope.
- Do not update fixtures blindly. Explain the behavior or contract change.
- Run the focused test first, then `npm test` when code behavior changes.

## Current Test Surface

Classification: `repo-confirmed`.

| Surface | Focused command | Covers |
| --- | --- | --- |
| Work Order validator | `node --test test/work-order-schema.test.js` | Result shape, schema fields, executable derivation, summary copy, approval bindings, write-scope lexical validation, and limited repository-root containment. |
| Fingerprint primitive | `node --test test/work-order-fingerprint.test.js` | Canonical JSON, action-class set canonicalization, volatile approval fields, undeclared `extensions`, `__proto__`, integer-like keys, fingerprint format. |
| Path safety primitive | `node --test test/path-safety.test.js` | Lexical repo-relative normalization, protected-path detection, normalized path coverage, existing-path realpath containment, realpath coverage, and new-file parent containment primitives. |
| CLI wrapper | `node --test test/work-order-cli.test.js` | `pi validate-work-order`, JSON stdout, exit codes, large piped output flush. |
| Work Order fixtures | `node --test test/work-order-fixtures.test.js` | Valid lifecycle fixtures plus missing-context and unknown-policy negative fixtures. |

## Documentation-Only Changes

For documentation-only changes, tests are usually not required. Run patch sanity
checks and state that no runtime behavior changed.

Recommended checks:

```bash
git diff --check
```

If the patch includes untracked files, also use the untracked-aware check in
`docs/llm/commands.md` or stage the intended files and run:

```bash
git diff --cached --check
```

## Reporting

Do not claim verification unless a command was actually run or a concrete
manual verification method was performed.

If tests are not added or not run, explain why and list the residual risk.
