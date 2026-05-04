# Pi Orchestrator Rebuild Workspace

This repository is being rebuilt as a Work Order based coding-quality harness
for scoped execution, independent review, verification, and truthful Evidence
Packs.

The previous implementation state is available at the Git tag
`pre-rebuild-harness`. Do not delete or move that tag; it is the recovery point
for old runtime code, tests, examples, skills, and stale documentation.

## Current State

The current working tree is being rebuilt from a broad Pi and project-lifecycle
orchestrator into a coding-quality harness.

The repository is no longer placeholder-only. Current source and tests implement
the first kernel surfaces for Work Order validation, CLI validation output,
fingerprinting, path-safety primitives, and Work Order fixtures.

Current behavior is authoritative only when backed by source code and tests in
this working tree. Rebuild docs describe target behavior where code and tests do
not yet enforce it.

Target flow:

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

## Implemented Kernel Surfaces

Implemented and covered by current tests:

- `src/kernel/work-order.js` exports `validateWorkOrder(workOrder)`.
  - Validates the current Work Order shape, including schema version, kind,
    state, repository root, policy profile, readiness, change, scope, context,
    acceptance, verification, execution, risk, operational readiness, approval,
    and repair fields.
  - Returns a structured result with `success`, `status`, `executable`,
    `summary`, `hardFailures`, `warnings`, and `errors`.
  - Derives `executable` only for valid, active, ready Work Orders.
  - Checks approval action-class binding and approval fingerprint binding when
    approval is required.
  - Performs lexical repo-relative path validation for write-scope fields.
- `src/cli/pi.js` implements `pi validate-work-order <file>`.
  - Reads a Work Order JSON file, prints the validator result as JSON, and uses
    validator success for exit-code mapping.
- `src/kernel/work-order-fingerprint.js` exports canonical JSON and Work Order
  fingerprint primitives.
  - Fingerprints use `sha256:<64 lowercase hex>`.
  - Declared action-class arrays are canonicalized as sets.
  - Volatile approval record fields and undeclared top-level `extensions` do not
    affect Work Order fingerprints.
- `src/kernel/path-safety.js` exports lexical path-safety primitives.
  - `normalizeRepoRelativePath(pathValue)` normalizes or rejects repo-relative
    path syntax.
  - `isProtectedRepoPath(pathValue)` detects protected directory and
    secret-like path patterns.
  - These primitives do not inspect the filesystem.
- `test/fixtures/work-orders/` contains valid lifecycle fixtures and negative
  Work Order fixtures.

Primary verification command:

```bash
npm test
```

CLI smoke check:

```bash
node src/cli/pi.js validate-work-order test/fixtures/work-orders/valid-active.json
```

## Target-Only Or Not Yet Implemented

The broader harness remains target/backlog behavior unless current source and
tests say otherwise. In particular, the current runtime does not yet implement:

- Evidence Pack validation.
- Artifact persistence or an artifact store.
- Run journals.
- Worker execution.
- Bounded repair loops.
- Model-backed workers.
- `/build` surfaces.
- Full scope authorization.
- Protected-path enforcement inside validation or execution.
- Root containment, symlink escape checks, realpath escape checks, or observed
  worker path enforcement.

## Active Rebuild Docs

The current target design authority for the rebuild is, in order:

- [docs/KERNEL-INVARIANTS.md](./docs/KERNEL-INVARIANTS.md)
- [docs/WORK-ORDER-SCHEMA.md](./docs/WORK-ORDER-SCHEMA.md)
- [docs/EVIDENCE-PACK-SCHEMA.md](./docs/EVIDENCE-PACK-SCHEMA.md)
- [docs/REBUILD-GUIDE.md](./docs/REBUILD-GUIDE.md)
- [docs/CODING-QUALITY-HARNESS.md](./docs/CODING-QUALITY-HARNESS.md)
- [docs/IMPLEMENTATION-SEQUENCE.md](./docs/IMPLEMENTATION-SEQUENCE.md)

These documents define the intended design, but only executable code and tests
enforce harness behavior.

[docs/PURGE-MANIFEST.md](./docs/PURGE-MANIFEST.md) is retained as the audit
record for the aggressive purge that reset this branch. It is not current
design authority for the rebuilt runtime.

## Agent Context

[docs/llm/](./docs/llm/) contains agent-readable context for navigating the
repo. It may compress, map, and explain repo knowledge, but it does not create
product behavior or policy by itself and must not override current source,
tests, schemas, specs, ADRs, or rebuild docs.

## Rebuild Direction

The rebuilt harness should start from a precise Work Order, enforce scoped
execution boundaries, use isolated worker roles, perform independent review,
run bounded repair, capture verification evidence, and emit a truthful Evidence
Pack.

The target rebuild docs discuss readiness, context-pack provenance, change
class, patch budget, review depth, autonomy level, model/tool routing,
counterexample review, human review, observability, rollback/recovery, accepted
debt, and agent scorecard data as review controls. This README does not claim
those controls are fully enforced unless the current source and tests enforce
them.

Planning surfaces may produce Work Orders later. They do not belong inside the
execution kernel.

## Repository Shape

Current retained shell:

```text
README.md
PURPOSE.txt
.gitignore
package.json
docs/
src/
test/
```

Current implemented files include:

```text
src/cli/pi.js
src/kernel/path-safety.js
src/kernel/work-order.js
src/kernel/work-order-fingerprint.js
test/fixtures/work-orders/invalid-missing-context.json
test/fixtures/work-orders/invalid-unknown-policy-profile.json
test/fixtures/work-orders/valid-active.json
test/fixtures/work-orders/valid-completed.json
test/fixtures/work-orders/valid-planned.json
test/path-safety.test.js
test/work-order-cli.test.js
test/work-order-fingerprint.test.js
test/work-order-fixtures.test.js
test/work-order-schema.test.js
```
