---
status: context
owner: engineering
last_verified: 2026-05-15
authority_sources:
  - ../../AGENTS.md
  - ../KERNEL-INVARIANTS.md
  - ../WORK-ORDER-SCHEMA.md
  - ../EVIDENCE-PACK-SCHEMA.md
  - ../IMPLEMENTATION-SEQUENCE.md
  - ../../README.md
  - ../../src/kernel/work-order.js
  - ../../src/kernel/work-order-fingerprint.js
  - ../../src/kernel/path-safety.js
  - ../../src/kernel/artifact-store.js
  - ../../test/work-order-schema.test.js
  - ../../test/work-order-fingerprint.test.js
  - ../../test/path-safety.test.js
  - ../../test/artifact-store.test.js
verify_with:
  - git diff --check
---

# Known Traps

Use this page to avoid repeat mistakes. It is context, not an independent source
of product authority.

## Stale Confidence

Do not treat target docs, wiki prose, prompts, or worker narration as proof of
current harness enforcement.

If a rule is not enforced by code and tests, describe it as target behavior.

## Oversized Work Orders

Do not broaden a Work Order beyond the named invariant. Split when the task
mixes independent surfaces or grows past the narrowness defaults in `AGENTS.md`.
`docs/llm/conventions.md` may mirror those triggers as orientation, but it is
not the normative source.

## Surface Mixing

Avoid mixing Work Order, Evidence Pack, CLI, fixture, fingerprinting, and
path-safety changes unless explicitly requested.

## Approval Binding Traps

Classification: `repo-confirmed`.

- Do not sort or de-duplicate `approval.approvedActionClasses` into passing.
  It must already exactly match the canonical requested command action-class
  set.
- Do not reimplement canonicalization in approval fingerprint validation. Use
  `fingerprintWorkOrder()`.
- Do not add `canonicalFingerprint` to validator output unless a Work Order
  explicitly changes the result shape.

## Fingerprint Traps

Classification: `repo-confirmed`.

- Canonical JSON must preserve own `__proto__` keys from parsed JSON.
- Integer-like object keys must serialize lexicographically, not in JavaScript
  array-index order.
- `canonicalJson()` still serializes `extensions`; only
  `fingerprintWorkOrder()` ignores undeclared top-level `extensions`.
- Do not add generic presentation-field exclusions without explicit schema/code
  authority and tests.

## Path-Safety Traps

Classification: `repo-confirmed`.

- Drive-qualified path checks must take precedence over generic scheme-like
  checks so drive forms use `absolute_path`.
- URL-like and drive-qualified forms must be rejected even after leading `./`
  removal and when embedded as path segments.
- Keep lexical helpers and filesystem-backed containment helpers separate.
  `normalizeRepoRelativePath()` and `repoPathCovers()` are lexical;
  existing-path containment, realpath coverage, and new-file parent containment
  inspect the filesystem.
- Do not widen the limited validator containment checks into full scope
  authorization, runtime write enforcement, or observed worker path enforcement
  unless the Work Order names that single invariant.
- Use `repoPathCovers()` for lexical scope-path coverage instead of ad hoc
  prefix checks. It requires normalized inputs, and only trailing-slash scope
  paths cover descendants.
- Protected-path detection is wired only to reject protected entries in Work
  Order `scope.allowed` and `scope.allowedNewFiles`; do not reject protected
  `scope.forbidden` entries, which are valid denial metadata.
- Do not treat `scope.allowed` as an exception to `scope.forbidden`. Valid
  forbidden files or directories invalidate covered allowed entries, but an
  allowed parent may still contain a forbidden child.
- Do not treat `scope.allowedNewFiles` as an exception to `scope.forbidden`.
  For `scope.newFiles: "allowed"` or `"listed_only"`, valid forbidden files or
  directories still block covered listed new-file entries lexically, and valid
  forbidden scopes also block existing new-file parents by realpath. This is
  validator coverage only, not runtime worker path enforcement.
- Do not describe all root-containment or symlink/realpath behavior as either
  absent or complete. Current validator checks cover existing `scope.allowed`
  containment, existing-path realpath forbidden coverage, and
  `scope.allowedNewFiles` parent containment in the allowed/listed-only paths.
- Do not describe case-ambiguity handling as entirely absent or complete.
  Existing `scope.allowed` paths reject case-mismatched spellings when they
  resolve, and allowed/listed `scope.allowedNewFiles` parent containment rejects
  case-variant parent spellings. Broader runtime case policy remains target
  behavior.

## Artifact Store Traps

Classification: `repo-confirmed`.

- `ensureRunStoreDirectory()` is the current artifact-store primitive. It
  creates or validates `.pi/runs/<runId>` only; Work Order load validation,
  Evidence Pack validation, run journals, worker execution, runtime
  authorization, and artifact JSON serialization remain separate backlog
  surfaces unless a Work Order explicitly names them.
- Treat the current storage-safety guarantee as detected and path-based, not
  atomic no-outside-mkdir protection. The current helper can detect bad storage
  shapes, test-visible parent swaps before the relevant `mkdirSync()`, and
  final containment failures, but it is not an fd-anchored or no-follow
  primitive.
- If a Work Order claims no outside mkdir attempt may happen, require
  filesystem-call instrumentation in `test/artifact-store.test.js`; a clean
  final filesystem state is not enough proof.

## Backlog As Defect

Do not report later implementation-sequence backlog as a current defect unless
the changed artifact explicitly claims or depends on that behavior now.

## Wiki Authority Drift

Do not create product behavior, architecture, or policy by implication from
wiki prose.

A wiki page may be used as authority only when it declares
`status: authoritative` and cites the source authority it derives from.

## Generated Or Private Surfaces

Do not edit generated, ignored, private, or unrelated files.

Do not access, expose, copy, or modify secrets, credentials, production data, or
private keys.
