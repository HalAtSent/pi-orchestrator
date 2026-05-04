---
status: context
owner: engineering
last_verified: 2026-05-04
authority_sources:
  - ../../AGENTS.md
  - ../KERNEL-INVARIANTS.md
  - ../../src/kernel/work-order.js
  - ../../src/kernel/work-order-fingerprint.js
  - ../../src/kernel/path-safety.js
  - ../../src/cli/pi.js
  - ../../test/work-order-schema.test.js
  - ../../test/work-order-fingerprint.test.js
  - ../../test/path-safety.test.js
  - ../../test/work-order-cli.test.js
  - ../../test/work-order-fixtures.test.js
verify_with:
  - git diff --check
---

# Repo Map

This page maps major surfaces. It is orientation, not product authority.

## Source

- `src/kernel/` - validation, fingerprinting, path-safety, and kernel policy
  primitives.
- `src/cli/pi.js` - CLI entrypoint for harness commands. It should call kernel
  APIs and render results, not duplicate policy logic.

### Current Kernel Files

Classification: `repo-confirmed`.

- `src/kernel/work-order.js`
  - Exports `validateWorkOrder(workOrder)`.
  - Implements current Work Order schema validation, result shape, executable
    derivation, summary copy, approval action-class binding, approval
    fingerprint binding, write-scope lexical path validation, and protected
    path rejection for `scope.allowed` and `scope.allowedNewFiles`.
  - Does not implement Evidence Pack validation, worker execution, artifact
    persistence, run journals, runtime protected-path write enforcement, full
    scope authorization, root containment, symlink/realpath checks, or
    normalized artifact persistence.
- `src/kernel/work-order-fingerprint.js`
  - Exports `canonicalJson(value)` and `fingerprintWorkOrder(workOrder)`.
  - Canonical JSON sorts object keys lexicographically, preserves own
    `__proto__` keys, emits integer-like keys lexicographically, canonicalizes
    declared action-class arrays as sets, and keeps other arrays
    order-sensitive.
  - `fingerprintWorkOrder()` ignores volatile approval record fields and
    undeclared top-level `extensions`.
- `src/kernel/path-safety.js`
  - Exports `normalizeRepoRelativePath(pathValue)`.
  - Exports `isProtectedRepoPath(pathValue)`.
  - Exports `repoPathCovers(scopePath, candidatePath)`.
  - Path primitives are lexical and do not inspect the filesystem.
- `src/cli/pi.js`
  - Implements `pi validate-work-order <file>`.
  - Prints machine-readable JSON to stdout and uses validator success for exit
    code mapping.

## Tests And Fixtures

- `test/` - Node.js `node:test` suite.
- `test/fixtures/work-orders/` - canonical valid and invalid Work Order
  fixtures.

### Current Test Files

Classification: `repo-confirmed`.

- `test/work-order-schema.test.js` - Work Order validator behavior.
- `test/work-order-fingerprint.test.js` - canonical JSON and fingerprint
  primitives.
- `test/path-safety.test.js` - lexical path normalization, protected path
  detection, and normalized path coverage primitives.
- `test/work-order-cli.test.js` - CLI wrapper behavior and stdout flushing.
- `test/work-order-fixtures.test.js` - static Work Order fixtures.

### Current Fixtures

Classification: `repo-confirmed`.

- Positive lifecycle fixtures:
  - `valid-active.json`
  - `valid-planned.json`
  - `valid-completed.json`
- Negative fixture families:
  - `invalid-missing-context.json`
  - `invalid-unknown-policy-profile.json`

## Rebuild Docs

- `docs/KERNEL-INVARIANTS.md` - highest-level rebuild invariant index.
- `docs/WORK-ORDER-SCHEMA.md` - target Work Order contract.
- `docs/EVIDENCE-PACK-SCHEMA.md` - target Evidence Pack contract.
- `docs/REBUILD-GUIDE.md` - rebuild architecture guidance.
- `docs/CODING-QUALITY-HARNESS.md` - harness overview and target flow.
- `docs/IMPLEMENTATION-SEQUENCE.md` - sequencing guidance for implementation
  slices.
- `docs/PURGE-MANIFEST.md` - purge audit record only, not current design
  authority.

## Agent Context

- `AGENTS.md` - bootloader and rules of engagement.
- `docs/llm/` - context wiki. It compresses, maps, and explains repo knowledge
  without silently creating authority.
- `docs/llm/context-packs/` - curated task-specific starting context.
- `docs/llm/decisions/` - deliberate decision records, when created.
- `docs/llm/scratch/` - temporary non-authority notes.

## Ignored Or Private Surfaces

Do not edit generated, ignored, private, or unrelated files unless explicitly
directed by the task.

- `.pi/`
- `node_modules/`
- `dist/`
- `build/`
- `coverage/`
- `.env*`
