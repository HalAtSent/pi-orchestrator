# Run Evidence Schema

This document defines the normative schema surface for persisted run evidence.

Unlike [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md), this file is a schema contract. It should be reviewed like an API and storage specification.

Future-facing schema and evidence hardening that is not yet enforced belongs in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md), not in this file's required fields.

## Scope

This schema is authoritative for the persisted evidence surfaces used by the harness and for the narrower reviewer-facing assessment rules applied to terminal states:

- top-level persisted artifacts:
  - `persisted_run_record`
  - `build_session`
- embedded evidence shapes:
  - `run_journal`
  - `run_journal.contractRuns[]`
  - `validation_artifact`
  - `build_session.approval`
- terminal-state reviewability requirements for:
  - `success`
  - `blocked`
  - `failed`
  - `repair_required`
- operator-readable rendering requirements for approval, status, blocked, and terminal summaries

Lifecycle planning artifacts such as `proposal_set`, `project_blueprint`, `execution_program`, and `audit_report` remain validated by their own constructors. This document references them only where they are embedded in persisted evidence.

A persisted artifact can be structurally valid without yet being reviewable for terminal success. In current code, placeholder validation entries preserve lineage and fail closed on fabricated capture claims, but they do not by themselves prove reviewable success.

Current v1 persists a first-class `reviewability` object on `persisted_run_record`, embedded `run_journal`, and `build_session.execution`.

Current v1 still does not persist a first-class `providerModelEvidenceRequired` field. Provider/model requirements remain a narrow machine inference surface plus reviewer context.

## Normative Terms

- Required: must be present and valid.
- Optional: may be omitted; if present, it must validate.
- Reviewable requirement: required only when claiming that a terminal state is reviewable after the fact; it is not automatically a persistence-time rejection unless current code explicitly enforces it.
- Rendering requirement: required in operator-facing output shape, but not necessarily a first-class persisted field.
- Derived render field: operator-facing text or headings assembled from persisted evidence, formatter logic, or both.

Required means required in the persisted artifact shape, not merely "usually useful." Omitted required fields make the artifact non-conformant. Reviewable requirements are narrower: they describe what must be present before a terminal artifact should be treated as reviewable.

## Schema Grounding

The authoritative schema identifier for a top-level persisted artifact is the pair:

- `artifactType`
- `formatVersion`

Embedded objects do not yet carry independent `formatVersion` fields. Their schema identifier is the named shape in this document plus the containing path.

| Schema id | Grounding | Persistence target |
| --- | --- | --- |
| `persisted_run_record@v1` | `artifactType = persisted_run_record`, `formatVersion = 1` | `.pi/runs/<programId>.json` |
| `run_journal@v1` | `persisted_run_record.runJournal` with `artifactType = run_journal` | embedded in persisted run records |
| `build_session@v1` | `artifactType = build_session`, `formatVersion = 1` | `.pi/build-sessions/<buildId>.json` |
| `validation_artifact@v1` | entries in `validationArtifacts[]` arrays | embedded |
| `build_approval_evidence@v1` | `build_session.approval` plus `build_session.buildId` | embedded |

Current implementation grounding:

- `persisted_run_record@v1` is materialized and normalized by `src/run-store.js`
- `run_journal@v1` core shape is validated by `src/project-contracts.js`; embedded persistence fields are then normalized by `src/run-store.js`
- `build_session@v1` is materialized and normalized by `src/build-session-store.js`
- `validation_artifact@v1` is normalized by `src/run-evidence.js`

Validation layers are intentionally separate:

| Layer | Current code surface | What it currently decides |
| --- | --- | --- |
| core journal validation | `src/project-contracts.js` via `createRunJournal()` / `validateRunJournal()` | required `run_journal` and `contractRuns[]` shape, enums, non-empty strings, and normalization of `stopReasonCode` / `validationOutcome` |
| persisted run envelope normalization | `src/run-store.js` via `normalizePersistedRunRecord()` | top-level persistence envelope, equality between top-level summary fields and embedded `runJournal`, and normalization/backfilling of embedded `run_journal` fields such as `artifactType`, `sourceArtifactIds`, `lineageDepth`, `actionClasses`, `policyProfile`, and `validationArtifacts` |
| persisted build-session envelope normalization | `src/build-session-store.js` via `normalizePersistedBuildSessionRecord()` | top-level build-session envelope plus normalization/backfilling of `approval` and `execution` summary fields, including derived `stopReasonCode`, `validationOutcome`, `actionClasses`, and `validationArtifacts` |

These layers should not be read as one combined validator surface. A journal can pass `src/project-contracts.js` validation before the stores add or normalize persistence-only fields, and the stores may backfill legacy or omitted envelope fields that the core validator does not know about.

Current loader behavior:

- top-level `artifactType` and `formatVersion` are always materialized on save
- load paths fail closed when a present top-level `artifactType` or `formatVersion` disagrees with the expected v1 envelope
- missing legacy envelope fields are backfilled during normalization rather than rejected
- embedded `run_journal.artifactType` is enforced when present and backfilled when absent

## Closed Enums

### Program Run Status

- `running`
- `success`
- `blocked`
- `failed`
- `repair_required`

### Build Session Status

- `awaiting_approval`
- `approved`
- `running`
- `success`
- `blocked`
- `failed`
- `repair_required`

### Contract Run Status

- `success`
- `blocked`
- `failed`
- `repair_required`

### Validation Outcome

- `pass`
- `fail`
- `blocked`
- `not_run`

### Stop Reason Code

- `approval_required`
- `invalid_input`
- `invalid_artifact`
- `invalid_worker_output`
- `scope_violation`
- `protected_path_violation`
- `policy_denied`
- `runtime_unavailable`
- `execution_error`
- `validation_failed`
- `dependency_cycle`
- `missing_dependency`
- `terminal_resume_rejected`
- `unknown`

### Action Class

- `read_repo`
- `read_protected`
- `write_allowed`
- `write_forbidden`
- `write_protected`
- `execute_local_command`
- `install_dependency`
- `mutate_git_state`
- `access_network`
- `access_connector`
- `access_secret`
- `irreversible_side_effect`
- `recursive_delegate`

Current implementation note:

- this is the closed vocabulary used by persisted artifacts and approval bindings
- membership in this enum does not by itself mean the repository has a detector-backed live gate for that class
- current pre-execution derivation is narrower than the full enum and is limited to classes with concrete detector-backed stored-plan signals
- current post-run `actionClasses` normalization is conservative evidence, not a full policy-trace of every action that may have occurred

### Validation Artifact Status

- `captured`
- `not_captured`

### Reviewability Status

- `reviewable`
- `not_reviewable`
- `unknown`

### Reviewability Reason

- `non_terminal_status`
- `validation_artifacts_not_captured`
- `missing_stop_reason`
- `missing_stop_reason_code`
- `provider_model_evidence_missing`
- `provider_model_evidence_requirement_unknown`

### Policy Profile

`policyProfile` is not independently enumerated here. Valid values come only from [POLICY-PROFILES.md](./POLICY-PROFILES.md).

## Top-Level Envelope Rules

Only top-level persisted artifacts require the full persistence envelope:

- `artifactType`
- `formatVersion`
- `repositoryRoot`
- `createdAt`
- `updatedAt`

Embedded shapes do not currently carry independent persistence envelopes unless explicitly stated below.

## Null and Placeholder Policy

- Required string fields must be non-empty strings unless this document explicitly allows `null`.
- Omitted and `null` are not equivalent for required fields.
- Required array fields must be present. They may be empty only where this document explicitly permits it.
- `validationArtifacts[]` may contain placeholder entries with `status = not_captured`. Those placeholders preserve shape and lineage, but they do not satisfy reviewable-completion requirements when actual validation evidence is required.
- current normalization fails closed on contradictory capture claims by downgrading them to `status = not_captured` placeholders instead of inventing captured evidence
- missing or `null` `policyProfile` values are currently normalized to the resolved default profile before persistence

## Artifact Shapes

### `persisted_run_record@v1`

Purpose: canonical on-disk record for a program run and its persisted execution-evidence state.

Required fields:

- `artifactType = persisted_run_record`
- `formatVersion = 1`
- `repositoryRoot`
- `programId`
- `sourceArtifactIds`
- `lineageDepth`
- `program`
- `runJournal`
- `completedContractIds`
- `pendingContractIds`
- `lastStatus`
- `stopReason`
- `stopReasonCode`
- `validationOutcome`
- `actionClasses`
- `policyProfile`
- `validationArtifacts`
- `reviewability`
- `reviewability`
- `createdAt`
- `updatedAt`

Optional fields:

- none

Current field provenance:

- `program` and embedded `runJournal` are the primary stored payloads. The top-level summary fields mirror the normalized embedded journal and are not an independent source of truth.
- `stopReasonCode` is authoritative only as the persisted normalized value. When omitted or null, current code derives it with `normalizeStopReasonCode()` from `status` plus substring heuristics over `stopReason`.
- `validationOutcome` is authoritative only as the persisted normalized value. When omitted, current code derives it from `status`.
- `actionClasses` is authoritative only as the persisted normalized output. Current code validates any supplied array against the enum, then recomputes the stored value from `runJournal.contractRuns[].evidence[]` role markers plus limited `stopReasonCode` mappings.
- `validationArtifacts`, `reviewability`, `policyProfile`, `sourceArtifactIds`, `lineageDepth`, and embedded `runJournal.artifactType` may be backfilled or normalized during persistence even when absent in the input object.

Required invariants:

- `program.id` must equal `programId`.
- `runJournal.programId` must equal `programId`.
- `completedContractIds` must equal `runJournal.completedContractIds`.
- `pendingContractIds` must equal `runJournal.pendingContractIds`.
- `lastStatus` must equal `runJournal.status`.
- `stopReason` must equal `runJournal.stopReason`.
- `stopReasonCode` must equal `runJournal.stopReasonCode`.
- `validationOutcome` must equal `runJournal.validationOutcome`.
- `reviewability` must equal `runJournal.reviewability`.
- `sourceArtifactIds` must identify the embedded `execution_program` and `run_journal`, directly or by normalized reference.
- `policyProfile` must be the resolved active profile id, including when selected by default.

Null policy:

- `stopReason` and `stopReasonCode` must both be `null` only when `lastStatus` is `running` or `success`.
- `stopReason` and `stopReasonCode` are both required and non-null when `lastStatus` is `blocked`, `failed`, or `repair_required`.

Validation target:

- Persisted run files must validate as `persisted_run_record@v1`.
- Validation of this artifact includes validation of embedded `program`, `runJournal`, and all `validationArtifacts[]` entries.
- Current limitation: a persisted run can validate structurally with placeholder-only `validationArtifacts[]`. That state is persisted success, but `reviewability.status` remains `not_reviewable`.

### `run_journal@v1`

Purpose: canonical persisted review surface for execution progress and terminal state.

Current persistence rule:

- `run_journal` is currently an embedded persisted shape, not a separately versioned file.
- The authoritative persisted shape is the normalized embedded object inside `persisted_run_record.runJournal`.

Required fields:

- `artifactType = run_journal`
- `programId`
- `status`
- `stopReason`
- `stopReasonCode`
- `validationOutcome`
- `contractRuns`
- `completedContractIds`
- `pendingContractIds`
- `sourceArtifactIds`
- `lineageDepth`
- `actionClasses`
- `policyProfile`
- `validationArtifacts`

Optional fields:

- none

Current field provenance:

- `status`, `stopReason`, `contractRuns`, `completedContractIds`, and `pendingContractIds` are the core stored fields validated by `src/project-contracts.js`.
- `contractRuns[].changedSurface` is normalized per contract run and defaults to `capture = not_captured` for legacy records that omit it.
- `stopReasonCode` is stored in the persisted journal, but when it is omitted or null current code infers it from `status` plus substring heuristics over `stopReason`. It is therefore a normalized classification, not always an original event type emitted directly by the executor.
- `validationOutcome` is stored in the persisted journal, but when omitted current code derives it from `status`.
- `actionClasses` is recomputed by current persistence normalization from `contractRuns[].evidence[]` role markers, explicit command-evidence markers, and selected `stopReasonCode` mappings. The stored array is conservative derived evidence, not a first-class complete action log.
- `policyProfile`, `validationArtifacts`, `reviewability`, `sourceArtifactIds`, `lineageDepth`, and `artifactType` are normalized or backfilled at persistence time.

Required invariants:

- `completedContractIds` must contain exactly the contracts whose terminal run entry has `status = success`.
- `pendingContractIds` must preserve execution-program ordering for contracts not yet completed.
- `status = success` requires `pendingContractIds = []`.
- `status = running` requires `stopReason = null` and `stopReasonCode = null`.
- `status = repair_required` is terminal by status alone. No separate `isTerminal` field is defined or needed.
- `status = blocked`, `failed`, and `repair_required` are terminal for normal execution, but a later resume refusal may still return a separate `blocked` artifact rather than continuing the original run.
- `policyProfile` must be the resolved active profile id.
- `reviewability` is a machine-derived summary from persisted execution evidence; it is normalized from status, stop reasons, validation-artifact capture state, and machine-checkable provider/model signals when present.

Current `actionClasses` semantics:

- `run_journal.actionClasses` is currently normalized from contract-run evidence strings plus selected `stopReasonCode` mappings
- current role-based inference primarily surfaces `read_repo`
- explicit command-evidence markers can additionally surface `install_dependency` and `mutate_git_state`
- current stop-reason-code inference can additionally surface `write_forbidden` and `write_protected`
- this is intentionally conservative and may omit target-policy classes that exist in the enum but do not yet have first-class runtime detectors
- therefore `run_journal.actionClasses` should be read as current evidence about observed or normalized behavior, not as a complete policy audit trail

Null policy:

- `stopReason` and `stopReasonCode` must both be `null` only when `status` is `running` or `success`.
- `stopReason` and `stopReasonCode` are both required and non-null when `status` is `blocked`, `failed`, or `repair_required`.

#### `run_journal.contractRuns[]`

Purpose: per-contract execution evidence inside a run journal.

Required fields:

- `contractId`
- `status`
- `summary`
- `evidence`
- `openQuestions`
- `changedSurface`
- `validationOutcome`

Optional fields:

- none

Required invariants:

- `contractId` must identify a contract in the linked execution program.
- `summary` must be a non-empty string.
- `evidence[]` is the canonical current location for string-keyed execution facts that are not yet promoted to first-class fields.
- `openQuestions[]` is the canonical current location for remediation guidance or operator next actions when a contract run blocks or requires repair.
- `changedSurface.capture` must be one of `complete`, `partial`, or `not_captured`.
- `changedSurface.paths[]` must contain repo-relative normalized paths when present.
- `changedSurface.capture = not_captured` requires `changedSurface.paths = []`.

Reviewer guidance for narrative fields:

- Current code does not machine-decide whether `summary`, `stopReason`, or `openQuestions[]` are specific enough for a human reviewer.
- Reviewers should expect a contract-run `summary` to identify the observed outcome specifically enough to explain why the contract succeeded, blocked, failed, or required repair.
- If `run_journal.status = blocked`, reviewers should be able to find the blocked boundary or missing precondition in either the blocking `contractRuns[]` entry or the top-level `stopReason`.
- If `run_journal.status = blocked`, reviewers should expect remediation guidance in the blocking `contractRuns[]` entry's `openQuestions[]` when there is a blocking contract run. For top-level blocked refusals such as terminal resume rejection, the top-level `stopReason` may carry the operator next action instead.
- If `run_journal.status = failed`, reviewers should be able to find the executor failure, failing command, or failing validation surface in the failing `contractRuns[]` entry or the top-level `stopReason`.
- If `run_journal.status = repair_required`, reviewers should be able to find the review or verification source of the repair requirement in at least one `contractRuns[]` entry or `validationArtifacts[]` entry.
- If `run_journal.status = repair_required`, reviewers should expect `stopReason` to say that repair is required after the in-run repair budget was exhausted or unavailable.

Current implemented special case:

- If a resume attempt targets a persisted terminal run, current implementation returns a fresh `blocked` refusal artifact with `stopReasonCode = terminal_resume_rejected`; that refusal does not continue the original run.

Provider and model evidence:

- Current v1 grounding for provider/model evidence is the key-value string surface in `contractRuns[].evidence[]`.
- `src/process-worker-backend.js` currently emits:
  - `requested_provider`
  - `requested_model`
  - `selected_provider`
  - `selected_model`
- Current v1 grounding for exact changed-path capture is `contractRuns[].changedSurface`, derived by the contract executor from successful implementer runs that satisfy both conditions:
  - typed worker-result metadata is present (`result.changedSurfaceObservation.capture = complete`)
  - the run carries trusted changed-surface provenance attested by backend routing (`run.provenance.changedSurfaceObservationTrusted = true`)
  - trusted provenance attestation is module-private to `src/auto-backend-runner.js`; there is no generic public marker helper for arbitrary runners
- Current limitation: persisted-artifact validators do not infer whether every success path was model-backed, and the schema has no authoritative field that records whether provider/model evidence was required for a given run.
- Current limitation: exact changed-path capture is not universal across all runners. When a run path cannot provide trustworthy changed-path observation, `changedSurface.capture` remains `not_captured` and operator summaries must fall back to planned scope with an explicit caveat.
- Therefore provider/model entries remain process-backend evidence conventions and review aids, not universal persisted-schema conformance gates in v1. `result.changedSurfaceObservation` is syntax-validated as runner metadata, but promotion into persisted `contractRuns[].changedSurface` requires trusted run provenance as described above.

### `build_session@v1`

Purpose: canonical operator-facing persisted record for intake, lifecycle artifacts, approval state, and linked execution state.

Required fields:

- `artifactType = build_session`
- `formatVersion = 1`
- `repositoryRoot`
- `buildId`
- `programId`
- `planFingerprint`
- `sourceArtifactIds`
- `lineageDepth`
- `intake`
- `lifecycle`
- `approval`
- `execution`
- `createdAt`
- `updatedAt`

Optional fields:

- none

Required nested fields:

- `intake.goal`
- `lifecycle.proposalSet`
- `lifecycle.blueprint`
- `lifecycle.executionProgram`
- `lifecycle.auditReport`
- `approval.approved`
- `approval.approvedAt`
- `approval.programId`
- `approval.planFingerprint`
- `approval.actionClasses`
- `approval.policyProfile`
- `execution.status`
- `execution.stopReason`
- `execution.stopReasonCode`
- `execution.validationOutcome`
- `execution.actionClasses`
- `execution.policyProfile`
- `execution.validationArtifacts`
- `execution.reviewability`
- `execution.programId`
- `execution.completedContracts`
- `execution.pendingContracts`
- `execution.updatedAt`

Current field provenance:

- `approval.actionClasses` is an authoritative stored approval-scope field, but it is derived prospectively from the current stored `lifecycle.executionProgram` rather than captured from post-run behavior.
- `execution.status`, `execution.stopReason`, `execution.stopReasonCode`, `execution.validationOutcome`, `execution.actionClasses`, `execution.validationArtifacts`, and `execution.reviewability` are normalized execution-summary fields. They are first materialized by `src/build-session-store.js` and may later be synchronized from the linked `run_journal`.
- `execution.stopReasonCode` is therefore not an original event field on its own; before run-journal sync it is derived from `execution.status` and `execution.stopReason`, and after sync it mirrors the linked normalized `run_journal.stopReasonCode`.
- `execution.actionClasses` is therefore not the same surface as `approval.actionClasses`; before run-journal sync it is a limited normalized summary, and after sync it mirrors the linked normalized run-journal evidence surface.

Required invariants:

- top-level `programId` must equal `lifecycle.executionProgram.id`
- top-level `planFingerprint` must equal the fingerprint derived from the stored `lifecycle.executionProgram` content
- `approval.programId` must equal top-level `programId`
- `approval.planFingerprint` must equal top-level `planFingerprint`
- `approval.actionClasses` must equal the pre-execution action-class set derived from the current stored `lifecycle.executionProgram`
- if `execution.programId` is non-null, it must equal top-level `programId`
- `execution.policyProfile` must be the resolved active profile id once execution is approved or running
- synchronized build-session execution state must not contradict the linked `run_journal`
- `sourceArtifactIds` must identify the embedded lifecycle artifacts by normalized reference
- `execution.status = approved` means approval was recorded for the current stored scope; execution may still fail closed to `blocked` before any linked `run_journal` starts if pre-execution approval validation fails or throws

Null policy:

- `approval.approvedAt` must be `null` only when `approval.approved = false`.
- `execution.programId` may be `null` before execution starts.
- `execution.stopReason` and `execution.stopReasonCode` must both be `null` only when `execution.status` is `awaiting_approval`, `approved`, `running`, or `success`.
- `execution.stopReason` and `execution.stopReasonCode` are both required and non-null when `execution.status` is `blocked`, `failed`, or `repair_required`.

Current build-session reviewability note:

- `build_session` is the authoritative persisted location for operator approval state and lifecycle lineage.
- `build_session.execution` is the authoritative persisted location for build-scoped execution summary before and after run-journal synchronization.
- `build_session.execution.reviewability` now persists a narrow machine summary (`reviewable`, `not_reviewable`, or `unknown`) plus explicit reason codes.
- this summary does not replace deeper reviewer assessment of narrative evidence quality.
- there is still no standalone persisted `providerModelEvidenceRequired` field.
- Reviewers need the linked `run_journal` and its `contractRuns[]` evidence for detailed after-the-fact assessment; `build_session.execution` is only a synchronized summary surface.

Current action-class note:

- `approval.actionClasses` is prospective scope derived from the current stored execution program before execution starts
- in current code that derivation is limited to concrete detector-backed stored-plan signals (for example workflow packet command surfaces plus explicit contract verification-command signals), not the full action-class vocabulary
- `execution.actionClasses` is derived after the fact from run-journal evidence normalization and is therefore a different surface from `approval.actionClasses`

### `build_approval_evidence@v1`

Purpose: approval evidence required by [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md) for build-scoped execution.

Current persistence rule:

- Approval evidence is currently embedded in `build_session`.
- There is not yet a standalone persisted `approval_record` artifact in this repository.

Current authoritative fields:

- `build_session.approval.approved`
- `build_session.approval.approvedAt`
- `build_session.approval.programId`
- `build_session.planFingerprint`
- `build_session.approval.planFingerprint`
- `build_session.approval.actionClasses`
- `build_session.approval.policyProfile`
- `build_session.buildId`

Required invariants:

- if `approval.approved = true`, `approval.approvedAt` must be present
- approval evidence must bind to one persisted `buildId`
- approval evidence must bind to one concrete `programId` through `approval.programId`
- approval evidence must bind to one concrete `planFingerprint` through `build_session.planFingerprint` and `approval.planFingerprint`
- approval evidence must expose the approved action-class set through `approval.actionClasses`
- approval evidence must expose the active policy profile through `approval.policyProfile`

Current semantics:

- `build_session.approval` records the current approval target even before approval is granted; `approval.approved` and `approval.approvedAt` say whether that stored scope is active
- `approval.actionClasses` is a prospective pre-execution set derived from the current stored execution program, not post-run inferred evidence
- current derivation of that prospective set includes `read_repo`, `write_allowed`, and `execute_local_command`, and can additionally include `install_dependency` / `mutate_git_state` when concrete install or git-mutation command signals are present in stored-plan command surfaces
- current approval-scope enforcement is a pre-execution gate against the current stored `programId`, `planFingerprint`, and derived action-class set; this repository does not yet implement mid-run step-level reapproval
- approval can be recorded first and then transition to `execution.status = blocked` before start if that pre-execution gate rejects the current stored scope

Additional approval-artifact hardening is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

### `validation_artifact@v1`

Purpose: canonical entry shape for validation, test, lint, build, policy, review, or other verification evidence referenced by persisted artifacts.

Valid embedding locations:

- `run_journal.validationArtifacts[]`
- `persisted_run_record.validationArtifacts[]`
- `build_session.execution.validationArtifacts[]`

Authoring convenience:

- current code may accept raw string entries before normalization
- persisted validation targets this object shape, not the raw string shorthand

Required fields:

- `artifactType`
- `status`

Conditionally required fields:

- if `status = captured`, `reference` is required and must be a non-empty string
- if `status = not_captured`, `reference` must be `null`
- if `status = not_captured`, `validationOutcome` is required

Optional fields:

- `validationOutcome` when `status = captured`

Required invariants:

- `artifactType` must currently be `validation_artifact`
- placeholder entries use `status = not_captured` and do not count as successful validation evidence by themselves

## Canonical Evidence Binding

The following evidence claims must bind to the named fields below.

| Evidence claim | Canonical fields |
| --- | --- |
| validated persisted run artifact | `persisted_run_record@v1` including `program`, `runJournal`, and `validationArtifacts[]` |
| validated build session artifact | `build_session@v1` including `approval`, `execution`, and lifecycle references |
| blocked boundary or missing precondition | `run_journal.stopReason`, `run_journal.stopReasonCode`, and the blocking `contractRuns[].summary` |
| terminal resume rejection | top-level `run_journal.status = blocked`, `run_journal.stopReasonCode = terminal_resume_rejected`, and refusal wording in `run_journal.stopReason` |
| remediation guidance or next action | blocking or repair-related `contractRuns[].openQuestions[]` |
| observed changed-path evidence | `run_journal.contractRuns[].changedSurface` where `capture = complete` or `partial`; when capture is unavailable, operator rendering may fall back to planned scope with explicit caveats |
| terminal repair-required state | `run_journal.status = repair_required`, supporting `validationArtifacts[]` or repair-related `contractRuns[]`, and terminal `stopReason` text |
| machine reviewability summary | `run_journal.reviewability`, mirrored by `persisted_run_record.reviewability` and `build_session.execution.reviewability` |
| provider/model evidence on success | process-backend `contractRuns[].evidence[]` convention using `requested_provider`, `requested_model`, `selected_provider`, and `selected_model` |
| approved plan identity | `build_session.planFingerprint` and `build_session.approval.planFingerprint` |
| approved action scope | `build_session.approval.actionClasses`, understood as the prospective plan-derived scope rather than post-run inferred evidence |
| active policy profile | `build_session.approval.policyProfile` for approval evidence; `policyProfile` on persisted execution-bearing artifacts |

## Operator-Readable Evidence Rendering

This section defines the operator-readable evidence model for approval, status, blocked, and terminal summaries. It sits alongside the persisted artifact schema, but it does not create a new required on-disk `operatorSummary` object in v1.

Current applicability:

- these requirements apply to operator-facing renderings such as `/build`, `/build-approve`, and `/build-status`
- they define the current operator-readable minimums enforced by live formatter coverage, not a new top-level persisted artifact shape
- current implementation assembles these summaries from persisted artifacts plus formatter logic in `src/operator-formatters.js`
- richer operator-summary coverage beyond the live formatter-backed minimum remains future hardening and is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md)

### Current Required Operator Summary Minimums

Current v1 still does not require `/build`, `/build-approve`, and `/build-status` to render the full richer operator-summary field set as dedicated output, but current formatter coverage now includes additional dedicated summary fields.

The current live minimum for operator-facing build summaries is the formatter-backed surface below. When the underlying build-session or linked run state exists, operator-facing output must render or truthfully answer:

- `goal`
- `approval_state`
- `plan_fingerprint`
- `approval_scope`
- `execution_status`
- `stop_reason`
- `changed_surfaces`
- `proof_collected`
- `unproven_claims`
- `reviewability`
- `approval_needed`
- `recovery_undo_notes`
- `next_action`

| Current operator field | Operator question answered | Current grounding | Live coverage today |
| --- | --- | --- | --- |
| `goal` | What was asked for? | `build_session.intake.goal` when a build session exists; otherwise the persisted `execution_program.goal` or `persisted_run_record.program.goal` | rendered today |
| `approval_state` | Is approval still pending or already recorded? | `build_session.approval.approved` and `build_session.approval.approvedAt` | rendered today |
| `plan_fingerprint` | Which saved plan is this summary talking about? | `build_session.planFingerprint` | rendered today |
| `approval_scope` | What approval scope is currently bound to that saved plan? | `build_session.approval.actionClasses` | rendered today |
| `execution_status` | What is the current run/build state? | `build_session.execution.status` or linked `run_journal.status` | rendered today |
| `stop_reason` | Why did execution stop, or why has it not advanced? | `build_session.execution.stopReason`, `run_journal.stopReason`, and linked terminal state | rendered today when applicable; otherwise `none` or equivalent truthful wording |
| `changed_surfaces` | What changed, and is that executed evidence or planned scope? | `run_journal.contractRuns[].changedSurface` when capture exists; when capture is partial or unavailable, formatter states that explicitly and falls back to planned scope from linked `contractId -> scopePaths` | rendered today |
| `proof_collected` | What evidence is actually persisted so far? | `run_journal.contractRuns[]`, `run_journal.contractRuns[].evidence[]`, and `build_session.execution.validationArtifacts[]` | rendered today |
| `unproven_claims` | What cannot be claimed as proven from current artifacts? | formatter classification over known evidence gaps, including partial or unavailable changed-path capture and `validationArtifacts[].status = not_captured` | rendered today |
| `reviewability` | What does the persisted machine check currently say about reviewability? | `build_session.execution.reviewability` or linked `run_journal.reviewability` | rendered today |
| `approval_needed` | Is fresh approval required before proceeding? | `build_session.approval.approved`, `build_session.execution.status`, and approval-related stop signals in execution summary | rendered today |
| `recovery_undo_notes` | What rollback or recovery guidance is recorded? | `run_journal.contractRuns[].openQuestions[]` when present; otherwise explicit weak-guidance wording grounded in execution state and stop reason | rendered today |
| `next_action` | What exact action should happen next? | formatter output such as `formatOperatorBuildNextAction()` or status-derived operator action grounded in persisted state | rendered today |

### Current Rendering Rules

- A rendering requirement in this section does not imply that the named field is already persisted as a first-class key in v1.
- Operator-readable summaries may be assembled from persisted artifacts, synchronized build-session fields, and formatter logic.
- When a current minimum field is grounded only indirectly, the summary must distinguish stored facts from formatter inference.
- When a current minimum field cannot be supported by persisted evidence, the summary must say `not captured`, `uncertain`, `not yet proven`, or equivalent truthful wording. It must not imply exact proof that current artifacts do not support.
- `approval_scope` must be described as the current stored plan-derived approval scope, not as a complete detector-backed runtime audit trail.
- `stop_reason` must not be rendered as a terminal execution claim unless the persisted execution state supports that claim.
- `next_action` should be one exact command or one exact human action when the current state makes that possible.

### Target Richer Summary Model (Future Hardening)

Current formatter coverage now includes dedicated labels for `Changed surfaces`, `Proof collected`, `Unproven claims`, `Approval needed`, and `Recovery / undo notes`.

The remaining richer operator-summary hardening below is preserved as a target formatter-coverage model for future hardening. It is not a current normative rendering requirement for `/build`, `/build-approve`, or `/build-status` in v1.

- `Requested outcome`
- `Actual outcome`
- `Next step`

That richer model belongs to formatter and operator-mode hardening, not current v1 enforced coverage. See [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

### Current Formatter Binding

Current implementation binds operator-readable summaries to persisted evidence as follows:

- `src/operator-formatters.js` already renders `requested_outcome` through `build_session.intake.goal`
- `formatOperatorBuildSessionStatus()` currently renders goal, approval state, plan fingerprint, approval scope, execution status, stop reason, changed surfaces, proof collected, unproven claims, reviewability, approval-needed guidance, recovery/undo notes, and next action grounded in `build_session` plus optional linked `run_journal`
- `formatOperatorApprovalCheckpoint()` currently renders approval checkpoint state and run status grounded in `build_session` plus linked execution state
- `formatOperatorBuildNextAction()` currently derives `next_step` from persisted status and resume policy
- current formatters do not yet render dedicated `requested outcome`, `actual outcome`, and `next step` labels as a fully normalized richer summary model across all operator command outputs

The current formatter binding above is the honest live surface. Additional summary-surface hardening beyond that implemented set is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Direct Evidence And Acceptable Inference

Current v1 relies on a mix of directly stored fields and normalized or reviewer-facing inference. The distinction is normative for reviewable terminal claims.

- Direct evidence is grounded in canonical persisted fields or references such as `run_journal.status`, `completedContractIds`, `contractRuns[]`, captured `validationArtifacts[]`, persisted `reviewability`, `build_session.approval.*`, `policyProfile`, `sourceArtifactIds`, and the linked lifecycle artifacts.
- Acceptable inference is limited to classification or summarization that current code already normalizes or that reviewers can derive from repository-local backend context, including conservative `actionClasses` and whether provider or model evidence should have existed for that run when machine status is `unknown`.
- Acceptable inference may explain or classify directly persisted evidence. It may not replace required direct evidence for a reviewable terminal claim.
- Placeholder `validationArtifacts[]` entries with `status = not_captured` are direct evidence that validation capture is incomplete. They are not direct evidence that validation passed.

## Persisted Reviewability Surface

Current v1 persists a narrow machine-decided reviewability summary:

- `run_journal.reviewability`
- `persisted_run_record.reviewability` (mirrors the embedded journal field)
- `build_session.execution.reviewability` (normalized execution summary, often synchronized from the linked run journal)

Current shape:

- `reviewability.status`: `reviewable` | `not_reviewable` | `unknown`
- `reviewability.reasons[]`: explicit reason codes from the closed enum above

Current derivation rules are intentionally narrow:

- non-terminal statuses are `not_reviewable` with `non_terminal_status`
- `success` requires captured validation evidence; placeholder-only validation capture yields `not_reviewable` with `validation_artifacts_not_captured`
- for `success` runs with successful contract entries:
  - if provider/model key-value signals are present but selected provider/model values are incomplete, status is `not_reviewable` with `provider_model_evidence_missing`
  - if provider/model requirement cannot be machine-decided from current signals, status is `unknown` with `provider_model_evidence_requirement_unknown`
- `blocked`, `failed`, and `repair_required` require both stop reason and stop reason code for machine reviewability; missing either yields `not_reviewable` with the corresponding reason code

Current limitation:

- there is still no first-class persisted `providerModelEvidenceRequired` field
- `reviewability.status = reviewable` means current machine-checkable gates pass; it does not claim that every narrative-quality or domain-specific reviewer judgment is fully automated

## Reviewer-Facing Terminal Assessment

Reviewers should still evaluate narrative sufficiency and technical adequacy beyond the narrow machine gates, including:

- whether stop reasons and summaries are specific enough to audit
- whether remediation guidance is actionable
- whether provider/model evidence should have existed given backend context when machine status is `unknown`
- whether the claim being made is stronger than what persisted evidence directly supports

## Lineage Requirements

Evidence is incomplete unless lineage can be reconstructed.

At minimum:

- `build_session.sourceArtifactIds` must identify the lifecycle artifacts used to create the session
- `persisted_run_record.sourceArtifactIds` must identify the linked `execution_program` and `run_journal`
- `run_journal.sourceArtifactIds` must identify its originating `execution_program`
- `lineageDepth` must be an integer `>= 0`
- resumed execution must preserve ancestry to the original `programId`

## Redaction and Retention

Current v1 behavior:

- no repository-wide redaction pass runs over `stopReason`, `contractRuns[].summary`, `contractRuns[].evidence[]`, `contractRuns[].openQuestions[]`, or `validationArtifacts[]` before persistence
- `src/process-worker-backend.js` currently copies truncated launcher `stdout` and `stderr`, plus launcher metadata and workspace paths, into worker `evidence[]`
- `src/program-runner.js` currently persists worker `summary`, `evidence`, `openQuestions`, and normalized `changedSurface` into `run_journal.contractRuns[]` without an additional redaction pass
- `src/auto-workflow.js` currently forwards prior worker `summary`, `changedFiles`, `commandsRun`, `evidence`, and `openQuestions`, plus repair-loop `reviewResult`, into later worker context objects
- current process-backed prompts do not interpolate that forwarded context into prompt text, but the forwarding boundary exists at the runner and adapter surface

Current review guidance:

- reviewers should treat persisted evidence as potentially containing raw tool or worker text unless a caller already redacted it
- secret-bearing material should be redacted or omitted before persistence when known
- evidence should prefer references, hashes, or summaries over raw secret-bearing payloads
- prompt content may be stored as hashes or references when raw content is sensitive
- retention or deletion policy may tighten storage, but may not erase artifacts required for terminal-state reviewability

Additional redaction hardening is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Current v1 Omissions

The following surfaces are intentionally not part of the current required persisted validation target:

- standalone `approval_record` artifact
- standalone `command_log_entry` artifact with structured command metadata
- standalone `diff_artifact` artifact with first-class changed-file ownership checks
- standalone `cost_record` artifact
- first-class structured provider/model selection fields that replace current evidence-string grounding
- first-class persisted `providerModelEvidenceRequired` or equivalent evidence-requirement field that replaces current partial inference
- first-class structured review findings separate from `validationArtifacts[]` and `contractRuns[].evidence[]`
- first-class persisted `operator_summary` or equivalent operator-readable evidence object with dedicated fields such as exact changed surfaces, unproven claims, approval class, recovery notes, and next step

See [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md) for the hardening plan for these omitted surfaces.

## Schema Completeness Rule

A behavior is not evidence-complete unless:

1. its inputs are representable in contract artifacts
2. its execution path can be reconstructed from persisted evidence
3. its persisted artifacts validate against the named shapes in this document
4. its approvals, scope, and lineage can be inspected after the fact
