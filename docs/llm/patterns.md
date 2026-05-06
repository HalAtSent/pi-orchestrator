---
status: context
owner: engineering
last_verified: 2026-05-06
authority_sources:
  - ../../AGENTS.md
  - ../KERNEL-INVARIANTS.md
  - ../WORK-ORDER-SCHEMA.md
  - ../EVIDENCE-PACK-SCHEMA.md
  - ../REBUILD-GUIDE.md
  - ../CODING-QUALITY-HARNESS.md
  - ../../src/kernel/work-order.js
  - ../../src/kernel/work-order-fingerprint.js
  - ../../src/kernel/path-safety.js
  - ../../test/work-order-schema.test.js
  - ../../test/work-order-fingerprint.test.js
  - ../../test/path-safety.test.js
verify_with:
  - git diff --check
---

# Patterns

This page summarizes recurring harness patterns. It is explanatory context; the
source docs and implementation own the contract.

## Core Flow

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

Planning surfaces may produce Work Orders. They do not own kernel policy or
bypass validation.

## Kernel Ownership

`src/kernel/` owns deterministic policy primitives:

- validation
- fingerprinting
- path safety
- scope checks
- fail-closed load behavior

`src/cli/pi.js` should call kernel APIs and render results. It should not
duplicate policy logic.

## Current Validation Result Pattern

Classification: `repo-confirmed`.

`validateWorkOrder()` returns:

- `success`
- `status`: `valid` or `invalid`
- `executable`
- `summary`
- `hardFailures`
- `warnings`
- `errors`

`hardFailures` and `errors` are compatibility-equivalent in current tests.
`warnings` is currently always `[]`; warning policy is not implemented.
`summary` is a non-authoritative copy of selected Work Order fields.

## Current Approval Binding Pattern

Classification: `repo-confirmed`.

- Required approvals bind approved action classes to the canonical requested
  verification command action-class set.
- The requested set is flattened, de-duplicated, and sorted.
- `approval.approvedActionClasses` must already equal the canonical array; it
  is not sorted into passing.
- Required approvals also bind `approval.approvedFingerprint` to
  `fingerprintWorkOrder(workOrder)`.
- Malformed approval timestamps and fingerprints keep their field-level
  failures.

## Current Fingerprint Pattern

Classification: `repo-confirmed`.

- `canonicalJson()` sorts object keys lexicographically and serializes directly
  so integer-like keys stay lexicographic.
- Own JSON `__proto__` keys are preserved as binding data.
- Only declared action-class arrays are order-insensitive sets:
  `verification.commands[].actionClasses`, `execution.modelToolRoute.tools`,
  and `approval.approvedActionClasses`.
- Other arrays remain order-sensitive.
- `fingerprintWorkOrder()` hashes UTF-8 canonical JSON with SHA-256 and renders
  `sha256:<64 lowercase hex>`.
- Volatile approval record fields and undeclared top-level `extensions` do not
  affect Work Order fingerprints.

## Current Path-Safety Pattern

Classification: `repo-confirmed`.

- `normalizeRepoRelativePath()` is lexical, structured-result based, and does
  not inspect the filesystem.
- Work Order write-scope validation uses the normalizer for `scope.allowed`,
  `scope.forbidden`, and `scope.allowedNewFiles` only.
- The validator does not mutate or persist normalized paths.
- `scope.allowed` entries must not be covered by valid normalized
  `scope.forbidden` entries. This is one-way: an allowed parent may still
  contain a forbidden child.
- `scope.allowedNewFiles` entries must remain exact file paths. When
  `scope.newFiles` is `allowed` or `listed_only`, each normalized new-file path
  must be covered by a normalized `scope.allowed` entry; containment is skipped
  when `scope.newFiles` is `forbidden`.
- When `scope.newFiles` is `allowed` or `listed_only`, valid normalized
  `scope.forbidden` entries also deny covered `scope.allowedNewFiles` entries.
  Invalid forbidden entries produce their own path errors and are not reused for
  coverage.
- `context.files[].path` and `verification.commands[].cwd` are intentionally
  still on the older validator path helper; `cwd: "."` remains valid.
- `isProtectedRepoPath()` rejects an initial protected-path subset in Work
  Order `scope.allowed` and `scope.allowedNewFiles` after lexical
  normalization.
- `repoPathCovers()` compares already-normalized repo-relative paths. Exact
  matches cover, trailing-slash scope paths cover descendants, and invalid or
  unnormalized inputs fail closed with `invalid_input`.
- `scope.forbidden` may still list protected paths as denial metadata. This is
  not full runtime scope authorization or observed worker path enforcement.

## Artifact Separation

Work Order and Evidence Pack contracts are separate surfaces unless explicitly
coupled by the task.

Every Evidence Pack must reference one canonical Work Order identity and
fingerprint, but Work Order validation and Evidence Pack validation should not
be bundled into one implementation slice unless the task explicitly requires it.

## Fail-Closed Defaults

Fail closed on:

- invalid input
- invalid worker output
- runtime context drift
- persisted state drift
- unknown policy profile
- unsupported or unsafe paths
- missing evidence when the run claims proof

## Role Boundaries

- Explorer, reviewer, and verifier roles are read-only.
- Write-capable workers require explicit allowlists.
- Forbidden paths override allowed paths.
- Worker output, model/tool routing, and autonomy declarations cannot widen
  scope, action classes, approval, role capability, or repair authority.

## Truthful Evidence

Verification evidence must distinguish commands actually run from commands only
planned. Changed-surface evidence must distinguish observed paths from planned
scope.

Classification: `documented-target`; no Evidence Pack runtime exists yet.
