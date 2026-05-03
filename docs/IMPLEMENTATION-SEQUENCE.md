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
- Initial artifact states: `planned`, `active`, `completed`
- Initial autonomy levels: `assist`, `scoped_edit`, `bounded_patch`,
  `supervised_agent`, `autonomous_run`
- Initial review depths: `low`, `medium`, `high`
- New action classes require a detector, owner, tests, and review meaning before
  they become policy vocabulary
- Runtime artifacts live under ignored `.pi/runs/`
- Early rebuild WIP limit: do not add model-backed workers, template UX, or
  `/build` surfaces before earlier kernel acceptance gates are met
- `pi-orchestrator` harness implementation Work Orders default to `micro`
  narrowness: one invariant, one implementation file, one test file, and no docs
  unless correcting a contradiction
- Default harness audit budget: expected audit passes `1`, maximum audit passes
  `2`; a third audit means the Work Order was probably too broad

## First Implementation Phase Target

The first implementation phase should contain schema validation and invariant
tests only. This is a phase target, not permission to bundle every listed item
into one Work Order.

Build:

- Work Order schema validation
- Evidence Pack schema validation
- canonical JSON and Work Order fingerprint calculation
- fail-closed load helpers for persisted artifacts
- focused invariant tests for missing fields, enum drift, malformed paths,
  unknown policy profiles, approval action-class binding, approval fingerprint
  binding, artifact state, readiness status, change class, patch budget,
  autonomy level, model/tool route, and counterexample review declarations

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
- approval action-class mismatch blocks
- approval fingerprint mismatch blocks
- non-active or non-ready Work Orders block
- missing change class, patch budget, autonomy level, or model/tool route blocks
- missing observability or rollback/recovery fields blocks when required by risk
  or change class

## Harness Work Order Discipline

Harness implementation Work Orders must be small enough that a failed audit
identifies either a bug in the named invariant or an out-of-scope follow-up.

Default pattern:

```text
One Work Order = one enforceable invariant, one code surface, one test surface.
```

Required operating rules:

- Write or update tests for the single named invariant first.
- Implement only enough code to satisfy those tests.
- Run the focused test.
- Run full `npm test`.
- Stop.
- Do not opportunistically fix adjacent validator behavior unless it blocks the
  named invariant.

Split triggers are hard stop conditions:

- CLI and validator logic in the same Work Order.
- Evidence Pack and Work Order logic in the same Work Order.
- Schema fields and policy interactions in the same Work Order.
- Fixtures and new validator behavior in the same Work Order.
- Canonical fingerprinting and validation behavior in the same Work Order,
  unless the pass explicitly depends on a completed prior fingerprint pass.
- Path normalization and protected-path policy in the same Work Order.
- More than three acceptance criteria.
- More than two repair or audit passes.

For validator work, one Work Order should introduce at most one failure-code
family.

## Pass 1A: State Validation Only

Enforce artifact state enum: `planned`, `active`, or `completed`.

Build:

- `state` field schema validation
- focused tests for missing, unsupported, and valid `active` state

Do not build:

- executable derivation
- `hardFailures` or `warnings` reshape
- CLI
- fixtures
- canonical fingerprint changes
- Evidence Pack behavior

Acceptance gate:

- missing `state` hard-fails at `$.state`
- unsupported `state` hard-fails at `$.state`
- valid `active` state preserves existing valid Work Order behavior

## Pass 1B: Executable Derivation Only

Compute `executable` from artifact state, readiness, and hard failures.

Build:

- `executable` derivation
- focused tests for active, planned, completed, blocked, and draft cases

Do not build:

- validation error vocabulary changes
- warning rules
- CLI
- fixture suite

Acceptance gate:

- `active` plus `ready` plus valid validation state returns `executable: true`
- `planned` plus `ready` plus valid validation state returns `executable: false`
- `completed` plus `ready` plus valid validation state returns `executable: false`
- blocked or draft readiness returns `executable: false`

## Pass 1C: Hard Failure Result Shape Only

Expose existing validation errors as `hardFailures`.

Build:

- validation result `hardFailures`
- validation result `warnings`
- compatibility alias for existing error output if needed

Do not build:

- warning rules
- new validation policy
- CLI

Acceptance gate:

- `hardFailures` exists
- `warnings` exists and is empty
- `status` is `valid` or `invalid`
- existing errors remain available through a compatibility alias if consumers
  need it

## Pass 1D: Minimal Validation Summary Only

Expose summary fields already present in the Work Order.

Build:

- `summary.changeClass`
- `summary.riskLevel`
- `summary.autonomyLevel`
- `summary.reviewDepth`
- `summary.patchBudget`
- `summary.verificationCommands`
- `summary.counterexampleReviewRequired`

Do not build:

- inferred policy
- warning rules
- CLI

Acceptance gate:

- summary fields are copied from validated Work Order fields
- missing source fields are represented by existing hard failures, not inferred
  defaults
- summary output does not claim policy enforcement that code has not implemented

## Pass 1E: CLI Wrapper Only

Render the existing validation result through `pi validate-work-order <file>`.

Build:

- CLI command wrapper
- JSON output for the existing validation result
- exit code mapping

Do not build:

- fixture suite
- new validator rules
- worker execution

Acceptance gate:

- valid file exits `0`
- invalid file exits nonzero
- JSON output contains `status`, `executable`, `hardFailures`, `warnings`, and
  `summary`
- CLI does not claim unimplemented policy enforcement

## Pass 1F: Fixture Suite Skeleton Only

Create the validator fixture structure and the first valid fixtures.

Build:

- fixture directory structure
- valid active fixture
- planned fixture
- completed fixture

Do not build:

- all negative fixtures
- model behavior evaluation
- worker execution
- new validator behavior

Acceptance gate:

- fixture directory exists
- valid active fixture validates and is executable
- planned fixture is valid but non-executable
- completed fixture is valid but non-executable

## Pass 1G+: One Negative Validator Fixture Per Work Order

After the fixture skeleton exists, add one negative fixture family per Work
Order.

Candidate fixture families:

- missing authority
- ambiguous product behavior
- out-of-scope write attempt
- forbidden path write attempt
- patch budget exceeded
- verification command fails
- agent needs uncited behavior
- repair would require scope widening
- counterexample reviewer finds unresolved issue

Acceptance gate:

- each Work Order adds one fixture family only
- fixture assertions cover validation `status`, `executable`, hard failures,
  warnings, and stop conditions for that family
- fixture Work Orders do not assert role quality, model behavior, worker output,
  or Evidence Pack content

The following approval-binding passes stay in the first implementation phase but
remain separate Work Orders. Canonical fingerprinting must land before any pass
that validates approval against that fingerprint.

## Pass 1H: Canonical JSON And Work Order Fingerprint Only

Implement canonical JSON and the Work Order fingerprint as a reusable primitive
for later approval checks.

Build:

- canonical JSON serialization for Work Order fingerprint input
- Work Order fingerprint calculation using `sha256:<hex>`
- deterministic handling for sorted object keys, declared order-insensitive
  arrays, and declared presentation-only exclusions
- focused tests for stable output across object key order and declared
  order-insensitive action-class order

Do not build:

- approval action-class binding
- approval fingerprint binding
- new validation failure-code families beyond fingerprint input errors
- readiness, state, or executable semantics changes
- Evidence Pack behavior
- CLI output changes
- path safety enforcement, protected-path enforcement, realpath checks, symlink
  checks, or full scope authorization

Acceptance gate:

- canonical JSON output is stable across object key order
- Work Order fingerprint output is deterministic and rendered as `sha256:<hex>`
- fingerprint calculation is exposed for later passes without deciding approval
  validity

## Pass 1I: Approval Action-Class Binding Only

Bind approval to exactly the requested command authority.

Build:

- canonical requested command action-class set derivation from Work Order
  commands
- de-duplication and lexicographic sorting for the requested command
  action-class set
- comparison of `approval.approvedActionClasses` to the canonical requested
  command action-class set
- focused tests for exact, reordered requested, duplicated requested, missing
  approved, extra approved, and non-canonical approved action-class lists

Do not build:

- approval fingerprint comparison
- canonical JSON or fingerprint algorithm changes
- new command execution or Evidence Pack command observation behavior
- derived-command approval behavior
- readiness, state, or executable semantics changes
- path safety enforcement, protected-path enforcement, realpath checks, symlink
  checks, or full scope authorization

Acceptance gate:

- `approval.approvedActionClasses` exactly equals the de-duplicated, sorted
  requested command action-class set
- missing, extra, duplicated, or differently ordered approved action classes
  hard-fail
- reordered or duplicated requested command action classes produce the same
  expected approved action-class set

## Pass 1J: Approval Fingerprint Binding Only

Bind approval to the canonical Work Order fingerprint produced by Pass 1H.

Build:

- approval fingerprint comparison
- comparison of `approval.approvedFingerprint` to the canonical Work Order
  fingerprint
- focused tests for exact, missing, stale, malformed, and changed-Work-Order
  fingerprint cases

Do not build:

- canonical JSON or fingerprint algorithm changes
- approval action-class binding changes
- readiness, state, or executable semantics changes
- Evidence Pack behavior
- CLI output changes
- path safety enforcement, protected-path enforcement, realpath checks, symlink
  checks, or full scope authorization

Acceptance gate:

- `approval.approvedFingerprint` exactly equals the canonical Work Order
  fingerprint
- missing, stale, or malformed approval fingerprints hard-fail and block
  execution
- changing a binding Work Order field changes the fingerprint and makes prior
  approval stale
- comparison uses the canonical fingerprint primitive from Pass 1H rather than
  reimplementing canonicalization in this pass

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
- validate artifact state, readiness, policy, change class, patch budget,
  autonomy, model/tool route, and scope
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

Add user-facing command UX beyond the kernel validation CLI last.

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
