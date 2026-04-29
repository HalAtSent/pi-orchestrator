# Evidence Pack Schema

## Purpose

This document defines the rebuild target schema for an Evidence Pack.

An Evidence Pack is the final review artifact produced by the coding quality
harness after a Work Order run. It records what was requested, what changed,
what was reviewed, what was verified, what remains unproven, and why the run
stopped.

The Evidence Pack exists so a human reviewer can decide whether a patch is
merge-grade without trusting worker narration.

## Relationship To Work Orders

Every Evidence Pack must reference exactly one canonical Work Order identity and
fingerprint.

The Evidence Pack is downstream of:

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

Planning surfaces may explain why a Work Order exists, but the Evidence Pack
reports only validated execution, review, repair, verification, and stop-state
evidence for that Work Order.

## Status And Authority

This is a rebuild target schema. It is not a guarantee that the current code
persists or enforces these fields.

Policy authority must come from schema-aware code and validated persisted
artifacts. Prompt text, role docs, skills, formatter text, model confidence, and
worker summaries are not policy authority.

All paths are repo-relative unless a field explicitly records `repositoryRoot`
or a redacted workspace placeholder. Untrusted model or worker output cannot
widen scope, prove claims, approve actions, or replace command observations.

## Object Shape

```json
{
  "schemaVersion": 1,
  "kind": "evidence_pack",
  "id": "ep-wo-docs-schema-001",
  "createdAt": "2026-04-29T12:00:00.000Z",
  "workOrder": {
    "id": "wo-docs-schema-001",
    "fingerprint": "sha256:canonical-work-order-hash",
    "repositoryRoot": "/absolute/path/to/pi-orchestrator",
    "policyProfile": "default",
    "title": "Create replacement schema docs"
  },
  "status": "success",
  "reviewability": {
    "status": "reviewable",
    "reasons": []
  },
  "summary": "Created rebuild target Work Order and Evidence Pack schema docs.",
  "scope": {
    "planned": {
      "allowed": [
        "docs/WORK-ORDER-SCHEMA.md",
        "docs/EVIDENCE-PACK-SCHEMA.md"
      ],
      "forbidden": [".git/", ".pi/", "node_modules/", ".env"],
      "newFiles": "listed_only",
      "allowedNewFiles": [
        "docs/WORK-ORDER-SCHEMA.md",
        "docs/EVIDENCE-PACK-SCHEMA.md"
      ]
    },
    "protectedDenied": [".git/", ".pi/", "node_modules/", ".env"],
    "violations": []
  },
  "changedSurface": {
    "captureStatus": "complete",
    "observed": [
      {
        "path": "docs/WORK-ORDER-SCHEMA.md",
        "changeType": "added",
        "source": "parent_diff"
      },
      {
        "path": "docs/EVIDENCE-PACK-SCHEMA.md",
        "changeType": "added",
        "source": "parent_diff"
      }
    ],
    "plannedButUnobserved": [],
    "observedOutsidePlanned": [],
    "notes": []
  },
  "claims": [
    {
      "id": "claim-001",
      "text": "No runtime code was changed.",
      "required": true,
      "status": "proven",
      "evidenceRefs": ["changed-surface-001"]
    }
  ],
  "commands": [
    {
      "id": "cmd-001",
      "command": "git diff --check",
      "cwd": ".",
      "exitCode": 0,
      "status": "passed",
      "source": "work_order",
      "actionClasses": ["read_repository", "execute_local_command"],
      "stdout": {
        "ref": null,
        "truncated": false,
        "redacted": false
      },
      "stderr": {
        "ref": null,
        "truncated": false,
        "redacted": false
      }
    }
  ],
  "verification": {
    "commandsRun": ["cmd-001"],
    "commandsNotRun": [],
    "failedChecks": [],
    "unprovenClaims": []
  },
  "reviewFindings": [],
  "repairs": [],
  "workerModelEvidence": [
    {
      "role": "implementer",
      "provider": "openai-codex",
      "model": "gpt-5.5",
      "selectionReason": "configured_role_default",
      "fallbackReason": null
    }
  ],
  "approvalEvidence": {
    "required": false,
    "approvalId": null,
    "workOrderId": "wo-docs-schema-001",
    "workOrderFingerprint": "sha256:canonical-work-order-hash",
    "approvedActionClasses": [],
    "policyProfile": "default"
  },
  "contextEvidence": [
    {
      "kind": "explicit_file",
      "reference": "docs/CODING-QUALITY-HARNESS.md",
      "reason": "North-star harness design.",
      "included": true,
      "truncated": false,
      "budgetNote": null
    }
  ],
  "redactions": {
    "status": "verified",
    "rulesApplied": ["repo_relative_paths", "workspace_placeholder", "secret_pattern_scrub"],
    "items": []
  },
  "persistence": {
    "validatedOnWrite": true,
    "validatedOnLoad": true,
    "schemaVersion": 1
  },
  "stop": {
    "reason": "completed",
    "failureClass": null,
    "details": []
  },
  "artifacts": []
}
```

## Required Fields

| Field | Required Rule |
| --- | --- |
| `schemaVersion` | Must be present and equal to a supported Evidence Pack schema version. |
| `kind` | Must be `evidence_pack`. |
| `id` | Must be stable and unique in the evidence store. |
| `createdAt` | Must be an ISO-8601 timestamp or a schema-approved logical time. |
| `workOrder.id` | Must match the executed Work Order. |
| `workOrder.fingerprint` | Must match the canonical Work Order fingerprint used for execution. |
| `workOrder.repositoryRoot` | Must be absolute before redaction; rendered views may use placeholders. |
| `workOrder.policyProfile` | Must match the policy profile used during validation. |
| `status` | Must be `success`, `blocked`, `failed`, or `repair_required`. |
| `reviewability.status` | Must be `reviewable`, `not_reviewable`, or `unknown`. |
| `scope.planned` | Must record the planned allowed, forbidden, and new-file scope. |
| `changedSurface.captureStatus` | Must be `complete`, `partial`, or `not_captured`. |
| `claims` | Must include all required acceptance claims or an explicit not-applicable record. |
| `commands` | Must include every command actually run by harness-controlled execution. |
| `verification` | Must distinguish commands run from commands not run. |
| `reviewFindings` | Must be present, even if empty. |
| `repairs` | Must be present, even if empty. |
| `approvalEvidence` | Must be present, even when approval was not required. |
| `contextEvidence` | Must be present, even if empty. |
| `redactions.status` | Must state whether redaction was code-verified. |
| `persistence` | Must record schema validation status. |
| `stop.reason` | Must state why execution stopped. |

Missing, malformed, unsupported, or enum-drifted fields cause persisted pack load
to fail closed.

## Top-Level Statuses

| Status | Meaning |
| --- | --- |
| `success` | Execution reached a terminal completion state. This does not imply reviewability. |
| `blocked` | Execution did not proceed or stopped because safe execution requirements were not met. |
| `failed` | Execution ran and failed because a worker, command, runtime, apply step, or verifier failed. |
| `repair_required` | Blocking findings remain after repair budget was exhausted or repair could not proceed inside scope. |

Rules:

- Terminal statuses do not resume.
- Terminal continuation requires a new Work Order.
- A status summary must not hide unproven claims, skipped commands, or partial changed-surface capture.

## Reviewability

`reviewability.status` enum:

| Value | Meaning |
| --- | --- |
| `reviewable` | Evidence is sufficient for a human to review the patch seriously. |
| `not_reviewable` | The run may have completed, but evidence is insufficient or contradicted. |
| `unknown` | The harness cannot determine reviewability because required evidence is unavailable or unsupported. |

`success` does not imply `reviewable`.

Common `not_reviewable` reasons:

- `changed_surface_not_captured`
- `required_command_not_run`
- `required_command_failed`
- `required_claim_unproven`
- `review_finding_unresolved`
- `provider_model_missing`
- `approval_evidence_missing`
- `context_required_but_truncated`
- `no_op_implementer_without_evidence`
- `redaction_not_verified`
- `persisted_artifact_invalid`

Rules:

- No-op implementer success without changed-surface evidence, explicit validation evidence, or a required no-op acceptance claim is not reviewable.
- Reviewability must be computed from typed evidence, not formatter optimism.
- A human or future policy may still reject a reviewable result.

## Changed Surface

Changed-surface evidence distinguishes planned scope from observed changes.

`changedSurface.captureStatus` enum:

| Value | Meaning |
| --- | --- |
| `complete` | Parent-side observation captured the full repository changed surface required by policy. |
| `partial` | Some changed-surface evidence exists, but known gaps remain. |
| `not_captured` | The harness did not capture reliable changed-surface evidence. |

Observed entry shape:

```json
{
  "path": "src/example.js",
  "changeType": "modified",
  "source": "parent_diff",
  "hashBefore": "sha256:before",
  "hashAfter": "sha256:after"
}
```

Rules:

- `observed[]` records what the harness observed.
- `scope.planned` records what was allowed.
- `plannedButUnobserved[]` records allowed paths that were not changed or not inspectable.
- `observedOutsidePlanned[]` records out-of-scope observations.
- Forbidden or protected path changes are violations.
- Worker-reported changed files may be recorded as claims, but parent-side observation is required for trusted changed-surface evidence.
- Partial or missing changed-surface capture usually makes success `not_reviewable`.

Violation entry shape:

```json
{
  "path": "src/out-of-scope.js",
  "type": "out_of_scope_write",
  "detectedBy": "parent_diff",
  "result": "blocked"
}
```

## Claims Ledger

Claims connect Work Order acceptance, worker statements, reviewer concerns, and
verifier evidence.

Claim status enum:

| Status | Meaning |
| --- | --- |
| `proven` | Evidence directly supports the claim. |
| `partial` | Evidence supports part of the claim or supports it under stated limits. |
| `unproven` | Claim is required or asserted, but evidence is missing or insufficient. |
| `not_applicable` | Claim is not applicable for this run, with a recorded reason. |

Claim entry shape:

```json
{
  "id": "claim-001",
  "source": "acceptance|implementer|reviewer|verifier|harness",
  "text": "No runtime code changed.",
  "required": true,
  "status": "proven",
  "evidenceRefs": ["changed-surface-001"],
  "limits": []
}
```

Required claims:

- each required acceptance item
- scope compliance
- changed-surface capture status
- required verification outcome
- unresolved blocking findings status
- approval satisfaction when approval was required
- no-op implementer justification when no files changed

Rules:

- Worker confidence is not evidence.
- Planned commands are not evidence until observed as run.
- Unproven required claims make reviewability `not_reviewable` or `unknown`.
- Claim evidence references must resolve to commands, changed-surface observations, review findings, approval records, context evidence, or other typed artifacts.

## Command Observations

Command observations record commands that actually ran.

Command entry shape:

```json
{
  "id": "cmd-001",
  "command": "npm test -- test/example.test.js",
  "cwd": ".",
  "exitCode": 0,
  "status": "passed",
  "source": "work_order",
  "actionClasses": ["read_repository", "execute_local_command"],
  "startedAt": "2026-04-29T12:00:00.000Z",
  "endedAt": "2026-04-29T12:00:05.000Z",
  "stdout": {
    "ref": "artifacts/cmd-001.stdout.txt",
    "truncated": false,
    "redacted": true,
    "bytes": 1024
  },
  "stderr": {
    "ref": "artifacts/cmd-001.stderr.txt",
    "truncated": false,
    "redacted": true,
    "bytes": 0
  }
}
```

Command status enum:

| Status | Meaning |
| --- | --- |
| `passed` | Command exited with success according to platform convention. |
| `failed` | Command ran and exited unsuccessfully. |
| `blocked` | Command did not run because policy or preflight blocked it. |
| `timed_out` | Command exceeded configured timeout. |
| `skipped` | Command was intentionally not run and must also appear in `commandsNotRun`. |
| `error` | Harness could not launch or observe the command reliably. |

Command source enum:

| Source | Meaning |
| --- | --- |
| `work_order` | Explicit command from the Work Order. |
| `derived` | Command derived by harness policy or verifier. |
| `worker` | Command run inside a worker environment. |
| `preflight` | Runtime or repository readiness command. |
| `manual` | Human-provided observation, not harness-controlled proof. |

Minimum action classes:

- `read_repository`
- `write_allowed_files`
- `execute_local_command`
- `install_dependency`
- `mutate_git_state`
- `access_network`
- `access_secret`
- `destructive`
- `deploy_or_publish`
- `irreversible_side_effect`

Rules:

- Commands planned are not commands run.
- Commands must include `cwd`.
- `cwd` is repo-relative unless explicitly redacted as a workspace placeholder.
- Approval-sensitive action classes require matching approval evidence.
- stdout and stderr may be stored by reference.
- Truncation must be explicit.
- Redaction must be explicit.
- Secret-looking material must be scrubbed before human-facing output.
- A command with unreliable launch or observation cannot prove a claim.

## Verification Result

`verification` summarizes proof status.

Required fields:

| Field | Definition |
| --- | --- |
| `commandsRun` | Command ids that actually ran. |
| `commandsNotRun` | Planned or required commands that did not run, with reasons. |
| `failedChecks` | Command ids or check ids that failed. |
| `unprovenClaims` | Required claim ids still unproven after verification. |

`commandsNotRun` entry shape:

```json
{
  "id": "verify-unit",
  "command": "npm test -- test/example.test.js",
  "reason": "dependency_install_not_approved",
  "required": true,
  "impact": "reviewability_not_reviewable"
}
```

Rules:

- Required commands not run must affect reviewability.
- Failed required commands must be represented in both `commands` and `failedChecks`.
- Advisory skipped commands must be visible but need not block reviewability.
- Verifier is read-only and cannot patch files to make checks pass.

## Review Findings

Review findings are independent critique records.

Entry shape:

```json
{
  "id": "finding-001",
  "severity": "blocking",
  "file": "src/example.js",
  "line": 42,
  "problem": "The null case still throws before the guard.",
  "requiredCorrection": "Move the guard before dereferencing value.",
  "evidenceRefs": ["diff-001"],
  "statusAfterRepair": "resolved"
}
```

Severity enum:

- `blocking`
- `non_blocking`

Status after repair enum:

- `unresolved`
- `resolved`
- `not_repaired`
- `not_applicable`

Rules:

- Blocking findings must be specific and actionable.
- Non-blocking findings do not trigger repair loops by themselves.
- File and line are optional only when the finding is not location-specific.
- Reviewer output cannot widen repair scope.
- Unresolved blocking findings lead to `repair_required` or `not_reviewable`.

## Repair Records

Repair records connect reviewer findings to bounded repair attempts.

Entry shape:

```json
{
  "loop": 1,
  "sourceFindingIds": ["finding-001"],
  "workOrderId": "wo-docs-schema-001",
  "workOrderFingerprint": "sha256:repair-work-order-hash",
  "scope": {
    "allowed": ["src/example.js"],
    "forbidden": [".git/", ".pi/"],
    "newFiles": "forbidden",
    "allowedNewFiles": []
  },
  "result": "success",
  "changedSurfaceRefs": ["changed-surface-002"],
  "notes": []
}
```

Repair result enum:

- `success`
- `blocked`
- `failed`
- `exhausted`
- `scope_widening_required`

Rules:

- Repair loop numbers start at `1`.
- Repair scope must be clamped to the original Work Order.
- Repair cannot add action classes.
- Repair cannot change forbidden or protected paths.
- Repair cannot create new files unless the original Work Order permits them.
- Exhausted repair budget with blocking findings produces `repair_required`.

## Worker And Model Evidence

Model-backed worker runs should record provider and model evidence.

Entry shape:

```json
{
  "role": "reviewer",
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "reasoningSetting": "high",
  "selectionReason": "configured_role_default",
  "fallbackReason": null,
  "workerPacketRef": "artifacts/reviewer-packet.json",
  "workerResultRef": "artifacts/reviewer-result.json"
}
```

Rules:

- Record one entry per model-backed worker role launch.
- Missing provider/model evidence is a reviewability problem when model-backed workers ran.
- Fallbacks must record why the fallback happened.
- Provider/model evidence is useful for review, but it is not proof that claims are true.
- Role prompts and skills do not define permissions.

## Approval Evidence

Approval evidence records what was approved, not whether the patch is correct.

Required fields:

| Field | Definition |
| --- | --- |
| `required` | Whether approval was required. |
| `approvalId` | Approval record id or null. |
| `workOrderId` | Approved Work Order id. |
| `workOrderFingerprint` | Approved canonical Work Order fingerprint. |
| `approvedActionClasses` | Exact action classes approved. |
| `policyProfile` | Approved policy profile. |

Rules:

- Approval must bind to exact Work Order identity, fingerprint, action scope, and policy profile.
- Approval must not authorize future replans.
- Approval must not authorize scope widening.
- Approval must not authorize unapproved repair scope.
- Approval must not stand in for technical approval or reviewable success.
- Missing or stale required approval produces `blocked`.

## Context Evidence

Context evidence records what was included and why.

Entry shape:

```json
{
  "kind": "explicit_file",
  "reference": "docs/CODING-QUALITY-HARNESS.md",
  "reason": "North-star harness design.",
  "included": true,
  "truncated": false,
  "hash": "sha256:content-hash",
  "budgetNote": null
}
```

Rules:

- Required context that is missing, drifted, or truncated must be visible.
- Optional context omissions must be recorded when they affect claims.
- Prior artifacts must validate on load before they are trusted.
- Context evidence cannot widen scope.
- Context evidence must distinguish explicit files, notes, prior artifacts,
  explorer findings, diffs, review findings, and derived summaries.

## Redaction Rules

Redaction must happen at concrete trust boundaries, not only in final prose.

Rules:

- Repo absolute paths should become repo-relative where possible.
- Temporary workspace paths should become placeholders such as
  `<workspace>/role-name`.
- User home paths should be redacted unless needed for `repositoryRoot`.
- Secret-looking material must be scrubbed from persisted human-facing output.
- Secret-looking material includes tokens, private keys, env values, credentials,
  authorization headers, and provider API keys.
- Redaction metadata should be code-verified.
- Redacted output should preserve enough structure for review.
- The pack must record whether stdout, stderr, worker packets, worker results,
  context snippets, and summaries were redacted.

`redactions.status` enum:

| Status | Meaning |
| --- | --- |
| `verified` | Schema-aware redaction ran and recorded metadata. |
| `partial` | Redaction ran, but known surfaces were not checked. |
| `not_verified` | Redaction did not run or could not be verified. |

`not_verified` generally makes human-facing reviewability `unknown` or
`not_reviewable` when sensitive surfaces are present.

## Persistence And Load Validation

Persisted Evidence Packs must validate on write and on load.

Rules:

- `schemaVersion` is required.
- Unknown schema versions fail closed.
- Enum drift is rejected.
- Missing required fields are rejected.
- Fields with the wrong type are rejected.
- Artifact kind mismatch is rejected.
- Work Order id and fingerprint mismatch is rejected.
- Invalid persisted pack cannot be silently formatted as success.
- Migration must be explicit, versioned, and evidence-preserving.
- Loaded prior packs are advisory until validation succeeds.

Persistence fields:

```json
{
  "persistence": {
    "validatedOnWrite": true,
    "validatedOnLoad": true,
    "schemaVersion": 1,
    "migration": null
  }
}
```

## Stop Reason And Failure Class

`stop.reason` explains why the run stopped.

Recommended stop reasons:

- `completed`
- `invalid_work_order`
- `preflight_blocked`
- `approval_required`
- `scope_violation`
- `read_only_write_detected`
- `worker_output_invalid`
- `worker_failed`
- `runtime_unavailable`
- `context_drift`
- `apply_failed`
- `rollback_failed`
- `verification_failed`
- `repair_exhausted`
- `persistence_invalid`
- `terminal_resume_rejected`

`stop.failureClass` groups operational failures:

- `input`
- `policy`
- `scope`
- `approval`
- `runtime`
- `worker`
- `verification`
- `persistence`
- `repair`
- `unknown`

Rules:

- `status` and `stop.reason` must be consistent.
- Terminal runs do not resume.
- Rollback or apply failures must not be hidden behind generic success.
- Unknown failure classes should be rare and should not be reviewable without additional evidence.

## Examples

### Reviewable Success

```json
{
  "schemaVersion": 1,
  "kind": "evidence_pack",
  "id": "ep-reviewable-success",
  "createdAt": "2026-04-29T12:00:00.000Z",
  "workOrder": {
    "id": "wo-doc-typo",
    "fingerprint": "sha256:wo",
    "repositoryRoot": "/absolute/path/to/repo",
    "policyProfile": "default"
  },
  "status": "success",
  "reviewability": {
    "status": "reviewable",
    "reasons": []
  },
  "summary": "Fixed a docs typo.",
  "scope": {
    "planned": {
      "allowed": ["docs/README-NOTES.md"],
      "forbidden": [".git/", ".pi/"],
      "newFiles": "forbidden",
      "allowedNewFiles": []
    },
    "protectedDenied": [".git/", ".pi/"],
    "violations": []
  },
  "changedSurface": {
    "captureStatus": "complete",
    "observed": [
      {
        "path": "docs/README-NOTES.md",
        "changeType": "modified",
        "source": "parent_diff"
      }
    ],
    "plannedButUnobserved": [],
    "observedOutsidePlanned": [],
    "notes": []
  },
  "claims": [
    {
      "id": "claim-001",
      "text": "Only the target docs file changed.",
      "required": true,
      "status": "proven",
      "evidenceRefs": ["changed-surface"]
    }
  ],
  "commands": [
    {
      "id": "cmd-001",
      "command": "git diff --check",
      "cwd": ".",
      "exitCode": 0,
      "status": "passed",
      "source": "work_order",
      "actionClasses": ["read_repository", "execute_local_command"],
      "stdout": {
        "ref": null,
        "truncated": false,
        "redacted": false
      },
      "stderr": {
        "ref": null,
        "truncated": false,
        "redacted": false
      }
    }
  ],
  "verification": {
    "commandsRun": ["cmd-001"],
    "commandsNotRun": [],
    "failedChecks": [],
    "unprovenClaims": []
  },
  "reviewFindings": [],
  "repairs": [],
  "workerModelEvidence": [],
  "approvalEvidence": {
    "required": false,
    "approvalId": null,
    "workOrderId": "wo-doc-typo",
    "workOrderFingerprint": "sha256:wo",
    "approvedActionClasses": [],
    "policyProfile": "default"
  },
  "contextEvidence": [],
  "redactions": {
    "status": "verified",
    "rulesApplied": ["repo_relative_paths"],
    "items": []
  },
  "persistence": {
    "validatedOnWrite": true,
    "validatedOnLoad": true,
    "schemaVersion": 1
  },
  "stop": {
    "reason": "completed",
    "failureClass": null,
    "details": []
  },
  "artifacts": []
}
```

### Success But Not Reviewable

```json
{
  "schemaVersion": 1,
  "kind": "evidence_pack",
  "id": "ep-success-not-reviewable",
  "createdAt": "2026-04-29T12:00:00.000Z",
  "workOrder": {
    "id": "wo-no-evidence",
    "fingerprint": "sha256:wo",
    "repositoryRoot": "/absolute/path/to/repo",
    "policyProfile": "default"
  },
  "status": "success",
  "reviewability": {
    "status": "not_reviewable",
    "reasons": ["changed_surface_not_captured", "required_command_not_run"]
  },
  "summary": "Worker reported completion, but required evidence is missing.",
  "scope": {
    "planned": {
      "allowed": ["src/example.js"],
      "forbidden": [".git/", ".pi/"],
      "newFiles": "forbidden",
      "allowedNewFiles": []
    },
    "protectedDenied": [".git/", ".pi/"],
    "violations": []
  },
  "changedSurface": {
    "captureStatus": "not_captured",
    "observed": [],
    "plannedButUnobserved": ["src/example.js"],
    "observedOutsidePlanned": [],
    "notes": ["Parent-side diff observation was unavailable."]
  },
  "claims": [
    {
      "id": "claim-001",
      "text": "Implementation satisfied the requested behavior.",
      "required": true,
      "status": "unproven",
      "evidenceRefs": []
    }
  ],
  "commands": [],
  "verification": {
    "commandsRun": [],
    "commandsNotRun": [
      {
        "id": "verify-unit",
        "command": "npm test -- test/example.test.js",
        "reason": "command_not_run",
        "required": true,
        "impact": "reviewability_not_reviewable"
      }
    ],
    "failedChecks": [],
    "unprovenClaims": ["claim-001"]
  },
  "reviewFindings": [],
  "repairs": [],
  "workerModelEvidence": [],
  "approvalEvidence": {
    "required": false,
    "approvalId": null,
    "workOrderId": "wo-no-evidence",
    "workOrderFingerprint": "sha256:wo",
    "approvedActionClasses": [],
    "policyProfile": "default"
  },
  "contextEvidence": [],
  "redactions": {
    "status": "verified",
    "rulesApplied": [],
    "items": []
  },
  "persistence": {
    "validatedOnWrite": true,
    "validatedOnLoad": true,
    "schemaVersion": 1
  },
  "stop": {
    "reason": "completed",
    "failureClass": null,
    "details": ["Terminal success without required proof."]
  },
  "artifacts": []
}
```

### Blocked Due To Invalid Scope

```json
{
  "schemaVersion": 1,
  "kind": "evidence_pack",
  "id": "ep-blocked-invalid-scope",
  "createdAt": "2026-04-29T12:00:00.000Z",
  "workOrder": {
    "id": "wo-invalid-scope",
    "fingerprint": "sha256:wo",
    "repositoryRoot": "/absolute/path/to/repo",
    "policyProfile": "default"
  },
  "status": "blocked",
  "reviewability": {
    "status": "not_reviewable",
    "reasons": ["invalid_work_order", "scope_violation"]
  },
  "summary": "Blocked before worker launch because scope escaped the repository root.",
  "scope": {
    "planned": {
      "allowed": ["../outside-repo/file.js"],
      "forbidden": [".git/", ".pi/"],
      "newFiles": "forbidden",
      "allowedNewFiles": []
    },
    "protectedDenied": [".git/", ".pi/"],
    "violations": [
      {
        "path": "../outside-repo/file.js",
        "type": "repo_root_escape",
        "detectedBy": "work_order_validation",
        "result": "blocked"
      }
    ]
  },
  "changedSurface": {
    "captureStatus": "not_captured",
    "observed": [],
    "plannedButUnobserved": [],
    "observedOutsidePlanned": [],
    "notes": ["No worker launched."]
  },
  "claims": [],
  "commands": [],
  "verification": {
    "commandsRun": [],
    "commandsNotRun": [],
    "failedChecks": [],
    "unprovenClaims": []
  },
  "reviewFindings": [],
  "repairs": [],
  "workerModelEvidence": [],
  "approvalEvidence": {
    "required": false,
    "approvalId": null,
    "workOrderId": "wo-invalid-scope",
    "workOrderFingerprint": "sha256:wo",
    "approvedActionClasses": [],
    "policyProfile": "default"
  },
  "contextEvidence": [],
  "redactions": {
    "status": "verified",
    "rulesApplied": ["repo_relative_paths"],
    "items": []
  },
  "persistence": {
    "validatedOnWrite": true,
    "validatedOnLoad": true,
    "schemaVersion": 1
  },
  "stop": {
    "reason": "invalid_work_order",
    "failureClass": "scope",
    "details": ["Allowed path contains path traversal."]
  },
  "artifacts": []
}
```

### Repair Required After Exhausted Repair Loop

```json
{
  "schemaVersion": 1,
  "kind": "evidence_pack",
  "id": "ep-repair-required",
  "createdAt": "2026-04-29T12:00:00.000Z",
  "workOrder": {
    "id": "wo-fix-null-case",
    "fingerprint": "sha256:wo",
    "repositoryRoot": "/absolute/path/to/repo",
    "policyProfile": "default"
  },
  "status": "repair_required",
  "reviewability": {
    "status": "not_reviewable",
    "reasons": ["review_finding_unresolved", "repair_exhausted"]
  },
  "summary": "Blocking reviewer finding remains after the allowed repair loop.",
  "scope": {
    "planned": {
      "allowed": ["src/example.js", "test/example.test.js"],
      "forbidden": [".git/", ".pi/"],
      "newFiles": "forbidden",
      "allowedNewFiles": []
    },
    "protectedDenied": [".git/", ".pi/"],
    "violations": []
  },
  "changedSurface": {
    "captureStatus": "complete",
    "observed": [
      {
        "path": "src/example.js",
        "changeType": "modified",
        "source": "parent_diff"
      }
    ],
    "plannedButUnobserved": ["test/example.test.js"],
    "observedOutsidePlanned": [],
    "notes": []
  },
  "claims": [
    {
      "id": "claim-001",
      "text": "Null input no longer throws.",
      "required": true,
      "status": "unproven",
      "evidenceRefs": ["finding-001"]
    }
  ],
  "commands": [
    {
      "id": "cmd-001",
      "command": "npm test -- test/example.test.js",
      "cwd": ".",
      "exitCode": 1,
      "status": "failed",
      "source": "work_order",
      "actionClasses": ["read_repository", "execute_local_command"],
      "stdout": {
        "ref": "artifacts/cmd-001.stdout.txt",
        "truncated": false,
        "redacted": true
      },
      "stderr": {
        "ref": "artifacts/cmd-001.stderr.txt",
        "truncated": false,
        "redacted": true
      }
    }
  ],
  "verification": {
    "commandsRun": ["cmd-001"],
    "commandsNotRun": [],
    "failedChecks": ["cmd-001"],
    "unprovenClaims": ["claim-001"]
  },
  "reviewFindings": [
    {
      "id": "finding-001",
      "severity": "blocking",
      "file": "src/example.js",
      "line": 42,
      "problem": "Null input still reaches the dereference.",
      "requiredCorrection": "Guard null before reading value.name.",
      "evidenceRefs": ["cmd-001"],
      "statusAfterRepair": "unresolved"
    }
  ],
  "repairs": [
    {
      "loop": 1,
      "sourceFindingIds": ["finding-001"],
      "workOrderId": "wo-fix-null-case",
      "workOrderFingerprint": "sha256:repair-wo",
      "scope": {
        "allowed": ["src/example.js"],
        "forbidden": [".git/", ".pi/"],
        "newFiles": "forbidden",
        "allowedNewFiles": []
      },
      "result": "exhausted",
      "changedSurfaceRefs": [],
      "notes": ["Blocking finding remained after repair."]
    }
  ],
  "workerModelEvidence": [],
  "approvalEvidence": {
    "required": false,
    "approvalId": null,
    "workOrderId": "wo-fix-null-case",
    "workOrderFingerprint": "sha256:wo",
    "approvedActionClasses": [],
    "policyProfile": "default"
  },
  "contextEvidence": [],
  "redactions": {
    "status": "verified",
    "rulesApplied": ["repo_relative_paths", "secret_pattern_scrub"],
    "items": []
  },
  "persistence": {
    "validatedOnWrite": true,
    "validatedOnLoad": true,
    "schemaVersion": 1
  },
  "stop": {
    "reason": "repair_exhausted",
    "failureClass": "repair",
    "details": ["One allowed repair loop was used."]
  },
  "artifacts": []
}
```
