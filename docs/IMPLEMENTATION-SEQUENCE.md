# Implementation Sequence

Status: rebuild sequencing guidance.

This document translates the rebuild docs into an implementation order. It does
not replace the schema docs or invariants. If there is a conflict, prefer:

1. [KERNEL-INVARIANTS.md](./KERNEL-INVARIANTS.md)
2. [WORK-ORDER-SCHEMA.md](./WORK-ORDER-SCHEMA.md)
3. [EVIDENCE-PACK-SCHEMA.md](./EVIDENCE-PACK-SCHEMA.md)
4. [REBUILD-GUIDE.md](./REBUILD-GUIDE.md)
5. this sequencing document

The purpose is to keep early rebuild work from drifting back into broad
orchestration, template generation, or operator UX before the kernel is real.

## Initial Rebuild Defaults

Use these defaults for the first implementation pass unless a later committed
doc changes them.

- Supported Work Order schema version: `1`
- Supported Evidence Pack schema version: `1`
- Initial policy profile set: `default` only
- Protected-path overrides: none
- Canonical fingerprint algorithm: canonical JSON encoded as UTF-8, hashed with
  SHA-256, rendered as `sha256:<hex>`
- Canonical JSON object keys: sorted lexicographically at every object level
- Presentation-only fields may be excluded from the policy fingerprint only
  after code declares and tests that exclusion
- Initial action classes: `read_repository`, `write_repository`,
  `execute_local_command`
- Initial change classes: `product_behavior`, `contract_schema`, `refactor`,
  `test_only`, `documentation`, `infrastructure_tooling`,
  `migration_data_change`
- Initial autonomy levels: `assist`, `scoped_edit`, `bounded_patch`,
  `supervised_agent`, `autonomous_run`
- Initial review depths: `low`, `medium`, `high`
- New action classes require a detector, owner, tests, and review meaning before
  they become policy vocabulary
- Runtime artifacts live under ignored `.pi/runs/`
- Early rebuild WIP limit: do not add model-backed workers, template UX, or
  `/build` surfaces before earlier kernel acceptance gates are met

## First Commit Target

The first implementation commit should contain schema validation and invariant
tests only.

Build:

- Work Order schema validation
- Evidence Pack schema validation
- canonical JSON and fingerprint calculation
- fail-closed load helpers for persisted artifacts
- focused invariant tests for missing fields, enum drift, malformed paths,
  unknown policy profiles, bad approval bindings, readiness status, change
  class, patch budget, autonomy level, model/tool route, and counterexample
  review declarations

Do not build:

- agents
- templates
- `/build`
- rich summaries
- process-backed workers
- repair loops
- lifecycle planning

Acceptance gate:

- invalid Work Orders fail before any worker path can run
- invalid Evidence Packs fail on load
- canonical fingerprint output is stable across object key order
- unknown policy profile blocks
- approval fingerprint mismatch blocks
- non-ready Work Orders block
- missing change class, patch budget, autonomy level, or model/tool route blocks
- missing observability or rollback/recovery fields blocks when required by risk
  or change class

## Pass 2: Scope And Path Safety

Build the path and scope boundary before building a worker.

Build:

- repo-relative path normalization
- absolute path rejection for repo-relative fields
- `..` traversal rejection
- URL-like path rejection
- root-containment checks
- symlink and realpath escape checks for existing paths
- protected-path enforcement
- `scope.allowed`, `scope.forbidden`, `scope.newFiles`, and
  `scope.allowedNewFiles` authorization

Acceptance gate:

- forbidden paths override allowed paths
- protected paths cannot enter write scope
- listed-only new files must exactly match `allowedNewFiles`
- ambiguous symlink, realpath, or case behavior blocks
- observed worker paths cannot widen planned scope

## Pass 3: Artifact Store And Run Journal

Make persisted truth real before model-backed execution exists.

Build:

- ignored `.pi/runs/` storage
- Work Order load and validation
- Evidence Pack write and load validation
- run journal state machine
- terminal state rules
- stop reasons for `success`, `blocked`, `failed`, and `repair_required`

Acceptance gate:

- persisted artifacts validate on write and on load
- invalid stored artifacts fail closed
- terminal journals cannot resume
- stop reasons are typed, not inferred from formatter text

## Pass 4: Minimal Harness Loop

Build the smallest deterministic loop with a local or test worker adapter before
adding real model workers.

Build:

- load Work Order
- validate readiness, policy, change class, patch budget, autonomy, model/tool
  route, and scope
- preflight repository root
- execute one scoped write-capable step through an adapter interface
- capture changed surface from repository diff
- run declared verification commands
- emit Evidence Pack with run configuration and fast verification loop evidence

Acceptance gate:

- a scoped single-file edit can complete
- an out-of-scope write blocks or fails with evidence
- no-op success without changed-surface or other proof is not reviewable
- commands actually run are distinguished from commands planned but skipped
- patch budget overrun and autonomy drift affect reviewability
- observability, rollback/recovery, human review, and accepted debt evidence are
  represented in the emitted Evidence Pack

## Pass 5: Real Worker Backend

Add one real worker path only after the deterministic loop is testable.

Preferred first backend:

- process-backed worker
- isolated workspace
- allowlist apply
- changed-surface observation
- provider and model evidence
- explicit sandbox support or explicit sandbox limitation evidence

Acceptance gate:

- implementer writes only inside Work Order scope
- read-only workers fail on writes
- launcher failures become `blocked` or `failed` evidence
- stale or malformed worker output fails closed

## Pass 6: Role Packets, Review, And Repair

Add role isolation after the backend can enforce scope.

Build:

- explorer packet: read-only context gathering
- implementer packet: scoped patch
- reviewer packet: independent critique
- counterexample reviewer packet: structured attempt to disprove the patch when required
- verifier packet: read-only evidence check
- bounded repair packet

Acceptance gate:

- role prompts cannot change role permissions
- reviewer findings can trigger repair only inside original scope
- required counterexample review is recorded before reviewable success
- required human review is recorded before reviewable success
- repair loop count is enforced by code
- repair cannot widen scope, action classes, approval, or protected-path access
- unresolved blocking findings produce `repair_required` or `blocked`

## Pass 7: Execution Programs

Add multi-step sequencing over the kernel after single Work Orders are reliable.

Build:

- execution program schema
- ordered dependencies
- per-step Work Order execution
- program-level journal
- resume only for valid running journals

Acceptance gate:

- blocked step stops dependent steps
- completed, failed, blocked, or repair-required programs do not resume
- approval binding persists through every step
- each step still emits its own Evidence Pack

## Pass 7A: Agent Evaluation Fixtures

Add model/role/context regression fixtures after role packet behavior is typed
and before optimizing model-backed routes.

Build fixture Work Orders for:

- simple scoped edit
- out-of-scope write attempt
- missing authority
- ambiguous context
- context truncation
- patch budget overrun
- failed verification and bounded repair
- counterexample review required
- human review required
- rollback/recovery required
- reviewer finding that cannot be repaired in scope

Acceptance gate:

- fixtures assert expected status, reviewability, scope evidence, command
  evidence, and stop reasons
- fixtures compare role/model/context strategy by Evidence Pack properties, not
  by persuasive prose

## Pass 8: Template Fragment System

Add planning only after the execution kernel is stable.

Build:

- fragment schema
- project-fact extraction with source references
- deterministic fragment matching
- companion and incompatible fragment resolution
- template composition validation
- dry-plan output

Acceptance gate:

- unknown project archetypes block honestly
- known fragments compose deterministically
- fixture specs snapshot repo layout, scope, contract ids, and verification
  commands
- iOS SwiftUI fixtures produce Xcode and Swift paths, not Node or web paths

## Pass 9: Operator Surfaces And `/build`

Add user-facing command UX last.

Build:

- thin status rendering over typed artifacts
- approval prompt rendering from stored scope and action classes
- blocked-result guidance
- `/build` as a consumer of templates and the kernel

Acceptance gate:

- every operator command returns structured details first
- human text only renders persisted truth
- validation output and status rendering are agent-readable enough to feed a
  future Work Order producer without scraping prose
- deleting `/build` would not delete the execution kernel
- `/build` blocks on missing templates or unsafe ambiguity

## Stop Rules

Stop and repair the rebuild direction if any early pass starts depending on:

- prompt prose as policy
- worker narration as evidence
- templates before kernel validation
- `/build` before Work Order execution
- broad action-class vocabulary without detector-backed enforcement
- formatter text to determine status or reviewability
- agent judgment to authorize scope, approval, or repair widening
