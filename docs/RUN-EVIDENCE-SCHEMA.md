# Run Evidence Schema

This document defines the minimum evidence required for a run, build session, or terminal outcome to be reviewable.

Unlike [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md), this file is a schema surface. It should be reviewed like an API or storage contract.

## Scope

This schema defines:

- required artifact families
- canonical field names
- closed enums used by the evidence layer
- lineage requirements
- reviewability and completeness rules
- retention and redaction expectations

## Conformance Status

This is the v1 normative evidence schema for the repository.

The current code already records important portions of it:

- execution programs
- run journals
- persisted run records
- build sessions
- contract-level status entries
- stop reasons as strings

Other fields in this schema are target requirements that should be added over time. Missing required fields mean the run is not fully conformant, even if execution completed.

## Artifact Families

The evidence layer uses these artifact families:

| Artifact family | Purpose |
| --- | --- |
| `task_packet` | bounded worker input |
| `worker_result` | structured worker output |
| `proposal_set` | brainstorm artifact |
| `project_blueprint` | frozen project plan |
| `execution_program` | ordered milestone contracts |
| `audit_report` | lifecycle audit findings |
| `compiled_execution_plan` | bounded plan derived from a contract |
| `run_journal` | program execution state and contract outcomes |
| `persisted_run_record` | on-disk wrapper around program and journal |
| `build_session` | operator-shell state and linked lifecycle artifacts |
| `validation_artifact` | schema, test, lint, build, policy, or review outputs |
| `command_log_entry` | normalized command execution evidence |
| `diff_artifact` | changed-file evidence, ownership, and scope checks |
| `cost_record` | provider, model, token, and cost accounting |

## Canonical Fields

The following field names are the canonical evidence keys going forward.

### Common Envelope

Every persisted artifact should include:

- `artifactType`
- `formatVersion`
- `createdAt`
- `updatedAt`
- `repositoryRoot`

### Run Identity

Run-scoped artifacts should include:

- `programId`
- `buildId` when applicable
- `parentRunId` or `parentProgramId` when applicable
- `sourceArtifactIds`
- `lineageDepth`

### Execution Summary

Execution-bearing artifacts should include:

- `status`
- `stopReason`
- `stopReasonCode`
- `validationOutcome`
- `completedContractIds`
- `pendingContractIds`

### Scope and Permission Evidence

Execution-bearing artifacts should include:

- `allowedFiles`
- `forbiddenFiles`
- `risk`
- `approvalRequired`
- `approvalRecorded`
- `actionClasses`
- `policyProfile`

### Model and Cost Evidence

Model-bearing artifacts should include:

- `provider`
- `model`
- `requestedProvider`
- `requestedModel`
- `promptHash` or prompt reference
- `tokenUsage`
- `estimatedCost`

### Command and Tool Evidence

Command-bearing artifacts should include:

- `command`
- `cwd`
- `exitCode`
- `stdoutCapturePolicy`
- `stderrCapturePolicy`
- `startedAt`
- `finishedAt`

### Diff and Validation Evidence

Change-bearing artifacts should include:

- `changedFiles`
- `outOfScopeWrites`
- `protectedPathTouches`
- `validationArtifacts`
- `reviewFindings`

## Closed Enums

The schema uses these closed enums.

### Run Status

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

### Worker Result Status

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

These codes are the normalized categories for terminal or blocking outcomes:

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

The free-form `stopReason` string remains allowed for human-readable detail, but it should map to one of these codes.

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

## Lineage Requirements

Evidence is incomplete unless lineage can be reconstructed.

At minimum:

- a `build_session` must point to its lifecycle artifacts and linked `programId`
- a `run_journal` must point to its `programId`
- a `persisted_run_record` must embed or reference the `execution_program` and `run_journal`
- contract-level outcomes must point to `contractId`
- resumed execution must preserve ancestry to the original `programId`

## Reviewability Rules

A run is reviewable only if all of the following exist:

- a validated execution program
- a run journal with terminal or current status
- contract-level execution entries
- explicit stop reason text when status is not `success`
- enough scope evidence to determine whether file ownership and allowlist rules were respected
- enough validation evidence to tell whether acceptance checks were actually exercised

A successful run is complete only if all of the following exist:

- `status = success`
- no unresolved validation failures
- no unexplained protected-path touches
- no missing lineage for child artifacts
- no missing required approval record for approved actions

## Minimum Reviewable Terminal Artifacts

### `success`

Requires:

- final run journal
- completed contract ids
- validation outcome
- changed-file evidence when files changed
- provider/model selection evidence when models were used

### `blocked`

Requires:

- final run journal
- `stopReason`
- `stopReasonCode`
- exact blocked boundary or precondition where possible
- remediation guidance or next action

### `failed`

Requires:

- final run journal
- `stopReason`
- `stopReasonCode = execution_error` or another specific code
- failing command or failing validation artifact when applicable

### `repair_required`

Requires:

- final run journal
- review or verification artifact identifying what repair is required
- clear statement that the run is terminal unless a future contract revision authorizes additional repair behavior

## Redaction and Retention

Evidence should be retained long enough to inspect and resume local runs.

The schema requires:

- secret material must be redacted or omitted from persisted artifacts
- evidence should prefer references, hashes, or summaries over raw secret-bearing payloads
- prompt content may be stored as hashes or references when raw content is sensitive
- deletion or retention profile rules may tighten storage, but may not erase artifacts required for terminal-state reviewability

## Schema Completeness Rule

A behavior is not evidence-complete unless:

1. its inputs are representable in contract artifacts
2. its execution path can be reconstructed from persisted evidence
3. its terminal state has the artifacts required by this schema
4. its approvals, scope, and lineage can be inspected after the fact
