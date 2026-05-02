# Work Order Schema

## Purpose

This document defines the rebuild target schema for a Work Order.

A Work Order is the execution handoff from a planning surface into the coding
quality harness. It is a bounded coding contract, not a product lifecycle plan.

The target architecture is:

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

The harness starts only after a Work Order is precise enough to validate,
execute, review, repair, verify, and report.

## Relationship To The Harness

This schema refines the Work Order shape described in
[CODING-QUALITY-HARNESS.md](./CODING-QUALITY-HARNESS.md).

The core execution loop is:

1. validate Work Order
2. preflight repo/runtime
3. explorer read-only context gathering
4. implementer scoped patch
5. reviewer independent critique
6. bounded repair
7. verifier read-only evidence
8. final Evidence Pack

Planning surfaces may create Work Orders. They do not bypass Work Order
validation and do not own execution policy.

## Status And Authority

This is a rebuild target schema. It is not a guarantee that the current code
enforces these fields or rules.

Policy authority must live in validated code and persisted artifacts. Prompt
text, role docs, skills, worker narration, and planning prose are not policy
authority.

All paths are repo-relative unless the field is explicitly named
`repositoryRoot`. `repositoryRoot` must be an absolute path.

Untrusted model or worker output cannot widen scope, approve actions, add new
action classes, or convert advisory verification into required proof. Invalid
worker output fails closed.

## Workflow Policy Source

The workflow-vault Work Order Validation Policy is the advisory source for the
target validation behavior.

Executable policy authority lives only in `pi-orchestrator` schema, validation
code, tests, and persisted artifacts.

When the vault policy and implemented harness behavior differ, the harness must
report only what it actually enforces.

Truthfulness rule:

- The CLI and docs must not claim enforcement before code enforces it.
- Unimplemented policy rules must be described as target behavior, not current
  behavior.
- Validation summaries, worker packets, and Evidence Packs must render persisted
  truth instead of aspirational policy text.

## Validation Gate Model

Work Order handling moves through these gates:

```text
Authority Gate
  -> Readiness Gate
  -> Execution Gate
  -> Evidence Gate
```

Gate ownership:

| Gate | Owns |
| --- | --- |
| Authority Gate | Schema and policy validation, required authority context, and change-class rules. |
| Readiness Gate | `readiness.status`, artifact state, acceptance, verification, patch budget, risk, review depth, and stop conditions. |
| Execution Gate | Scope and path safety, action classes, autonomy, model/tool route, and repair limits. |
| Evidence Gate | Evidence Pack validation, commands run versus commands planned, evidence statuses, reviewability, and residual risk. |

Each gate should reject insufficient work early. The preferred failure is a
typed `blocked` result, not agent improvisation.

## Validation Result Contract

The target validation result is a stable kernel inspection contract for code,
tests, and the `pi validate-work-order <file>` CLI. It is not a rich operator
UX surface.

Minimum result fields:

| Field | Meaning |
| --- | --- |
| `status` | `valid`, `invalid`, or `valid_with_warnings`. |
| `canonicalFingerprint` | Canonical Work Order fingerprint when the artifact can be canonicalized. |
| `state` | Artifact lifecycle state: `planned`, `active`, or `completed`. |
| `executable` | `true` only when state, readiness, schema, policy, scope, and approval checks permit execution. |
| `hardFailures` | Validation findings that block activation or execution. |
| `warnings` | Durable findings that do not block activation by default. |
| `changeClass` | Resolved `change.class`. |
| `riskLevel` | Resolved `risk.level`. |
| `autonomyLevel` | Resolved `execution.autonomyLevel`. |
| `reviewDepth` | Resolved `change.reviewDepth`. |
| `patchBudget` | Declared patch budget and whether it is internally reviewable. |
| `contextPackSummary` | Required context, freshness, provenance, and truncation status. |
| `requiredAuthorityFiles` | Authority context required by the change class and Work Order. |
| `forbiddenSources` | Sources that were explicitly rejected as policy authority. |
| `verificationCommands` | Planned commands and required action classes. |
| `counterexampleReviewRequired` | Whether counterexample review is required by policy or Work Order. |
| `stopConditions` | Conditions that require blocking, repair, or a fresh Work Order. |

Hard failures block activation or execution. Warnings do not block activation by
default, but validation output must carry them forward, and Evidence Packs must
record them.

## Object Shape

```json
{
  "schemaVersion": 1,
  "kind": "work_order",
  "state": "active",
  "id": "wo-docs-schema-001",
  "title": "Create replacement schema docs",
  "goal": "Create Markdown schema docs for Work Orders and Evidence Packs.",
  "repositoryRoot": "/absolute/path/to/pi-orchestrator",
  "producer": {
    "kind": "human|codex|issue|spec|adapter",
    "source": "chat",
    "sourceRef": null
  },
  "policyProfile": "default",
  "readiness": {
    "status": "ready",
    "checks": [
      {
        "id": "authority-cited",
        "status": "satisfied",
        "evidence": "docs/CODING-QUALITY-HARNESS.md"
      }
    ],
    "blockers": []
  },
  "change": {
    "class": "documentation",
    "reviewDepth": "low",
    "patchBudget": {
      "expectedFilesChanged": 2,
      "maxApproxChangedLines": 500,
      "allowedSurfaces": ["docs"],
      "mayMixSurfaces": false,
      "incidentalRefactors": false
    }
  },
  "scope": {
    "allowed": [
      "docs/WORK-ORDER-SCHEMA.md",
      "docs/EVIDENCE-PACK-SCHEMA.md"
    ],
    "forbidden": [
      ".git/",
      ".pi/",
      "node_modules/",
      "dist/",
      ".env"
    ],
    "newFiles": "listed_only",
    "allowedNewFiles": [
      "docs/WORK-ORDER-SCHEMA.md",
      "docs/EVIDENCE-PACK-SCHEMA.md"
    ]
  },
  "context": {
    "files": [
      {
        "path": "docs/CODING-QUALITY-HARNESS.md",
        "required": true,
        "reason": "North-star harness design."
      }
    ],
    "notes": [
      {
        "text": "The rebuilt harness is a coding-quality harness, not a product lifecycle planner.",
        "source": "human"
      }
    ],
    "priorArtifacts": [],
    "manifest": [
      {
        "kind": "explicit_file",
        "reference": "docs/CODING-QUALITY-HARNESS.md",
        "provenance": "work_order.context.files",
        "reason": "User listed this as required context.",
        "included": true,
        "truncated": false
      }
    ],
    "budget": {
      "maxTokens": 120000,
      "truncationPolicy": "fail_if_required_context_truncated"
    }
  },
  "acceptance": [
    {
      "id": "acc-001",
      "text": "The new docs define rebuild target schemas without claiming current enforcement.",
      "required": true
    }
  ],
  "verification": {
    "commands": [
      {
        "id": "verify-diff-check",
        "command": "git diff --check",
        "cwd": ".",
        "required": true,
        "actionClasses": ["read_repository", "execute_local_command"],
        "reason": "Check Markdown patch for whitespace errors."
      }
    ],
    "allowDerivedCommands": true,
    "required": true
  },
  "execution": {
    "autonomyLevel": "bounded_patch",
    "modelToolRoute": {
      "routeRequired": false,
      "preferredWorker": "deterministic_local",
      "preferredModels": [],
      "tools": ["read_repository", "execute_local_command"],
      "rationale": "Documentation-only schema update."
    },
    "rolePackets": [
      {
        "role": "implementer",
        "packetVersion": "implementer-v1",
        "required": true
      },
      {
        "role": "reviewer",
        "packetVersion": "reviewer-v1",
        "required": true
      }
    ],
    "counterexampleReview": {
      "required": false,
      "reason": "Low-risk documentation-only change."
    }
  },
  "nonGoals": [
    "Do not refactor runtime code.",
    "Do not purge or archive old docs in this Work Order."
  ],
  "risk": {
    "level": "low",
    "reasons": ["Documentation-only schema target."]
  },
  "operationalReadiness": {
    "observability": {
      "breakageDetection": "Documentation review and diff checks would catch formatting regressions.",
      "signals": ["git diff --check"],
      "manualChecks": ["Inspect rendered Markdown when formatting changes are non-trivial."]
    },
    "rollbackRecovery": {
      "required": false,
      "plan": null,
      "recoverySteps": [],
      "notApplicableReason": "Documentation-only patch can be reverted directly."
    }
  },
  "reviewFocus": [
    "Scope does not drift into runtime implementation.",
    "Schema language remains fail-closed and code-owned."
  ],
  "approval": {
    "required": false,
    "approvalId": null,
    "approvedAt": null,
    "approvedBy": null,
    "approvedFingerprint": null,
    "approvedActionClasses": []
  },
  "repair": {
    "maxLoops": 1,
    "mayWidenScope": false
  },
  "extensions": {}
}
```

## Required Fields

Minimum executable Work Order fields:

| Field | Required Rule |
| --- | --- |
| `schemaVersion` | Must be present and equal to a supported schema version. |
| `kind` | Must be `work_order`. |
| `state` | Must be `planned`, `active`, or `completed`. Only `active` can be executable. |
| `id` | Must be unique within the repository's Work Order store. |
| `goal` | Must describe a bounded coding outcome. |
| `repositoryRoot` | Must be an absolute path to the repository root. |
| `policyProfile` | Must resolve to a known policy profile. Unknown profiles fail closed. |
| `readiness.status` | Must be `ready` for an executable Work Order. This is separate from artifact lifecycle state. |
| `change.class` | Must be one supported change class. |
| `change.reviewDepth` | Must be `low`, `medium`, or `high`. |
| `change.patchBudget` | Must declare reviewability limits before execution. |
| `scope.allowed` | Must contain at least one repo-relative path. |
| `scope.forbidden` | Must be present. It may be empty only if built-in protected paths still apply. |
| `scope.newFiles` | Must be one of `forbidden`, `allowed`, or `listed_only`. |
| `scope.allowedNewFiles` | Required when `scope.newFiles` is `listed_only`; otherwise may be empty. |
| `context` | Must be present, even if all arrays are empty. |
| `acceptance` | Must contain at least one required acceptance item. |
| `verification` | Must be present and internally consistent. |
| `execution.autonomyLevel` | Must be one supported autonomy level. |
| `execution.modelToolRoute` | Must be present; it may declare that no model-specific route is required. |
| `execution.rolePackets` | Must be present; it may be empty only for non-role deterministic or manual paths. |
| `execution.counterexampleReview` | Must declare whether counterexample review is required. |
| `risk.level` | Must be `low`, `medium`, or `high`. |
| `operationalReadiness` | Must record observability/detection and rollback/recovery expectations. |
| `approval` | Must be present, even when approval is not required. |
| `repair.maxLoops` | Must be a non-negative integer. |

If a required field is missing, malformed, ambiguous, or unsupported, the
harness blocks before worker launch.

## Field Definitions

| Field | Type | Definition |
| --- | --- | --- |
| `schemaVersion` | integer | Version of this persisted Work Order schema. |
| `kind` | string enum | Must be `work_order`. Prevents loading the wrong artifact type. |
| `state` | string enum | Artifact lifecycle state: `planned`, `active`, or `completed`. |
| `id` | string | Stable Work Order identity. Must not change during execution. |
| `title` | string | Short human-readable title. Not policy authority. |
| `goal` | string | Exact coding outcome requested. Must be executable without product planning. |
| `repositoryRoot` | absolute path string | Filesystem root for all repo-relative paths. |
| `producer.kind` | enum | `human`, `codex`, `issue`, `spec`, or `adapter`. Informational. |
| `producer.source` | string or null | Human-readable origin. Informational. |
| `producer.sourceRef` | string or null | Issue URL, file path, chat id, or adapter id. Informational. |
| `policyProfile` | string | Code-resolved policy profile. Unknown values fail closed. |
| `readiness` | object | Definition of Ready summary for activating this Work Order. Does not replace field validation. |
| `change` | object | Change class, review depth, and patch budget used for routing and review intensity. |
| `scope` | object | Hard write boundary and new-file policy. |
| `context` | object | Explicit context inputs and provenance expected by role packets. |
| `acceptance` | array | Required and optional properties that define successful work. |
| `verification` | object | Commands and proof expectations for verifier stage. |
| `execution` | object | Autonomy level, model/tool route, role packet expectations, and counterexample-review requirement. |
| `nonGoals` | array of strings | Work that must not be done in this run. |
| `risk` | object | Risk level and reasons used for approval and review intensity. |
| `operationalReadiness` | object | Breakage detection, observability signals, and rollback/recovery expectations. |
| `reviewFocus` | array of strings | Specific risks for reviewer attention. Not scope authority. |
| `approval` | object | Approval requirement and exact binding fields. |
| `repair` | object | Repair loop limits and widening policy. |
| `extensions` | object | Reserved extension bag. Non-authoritative until validated by schema-aware code. |

## Artifact State Rules

Artifact state is lifecycle state. It is separate from `readiness.status`, which
summarizes content quality.

`state` enum:

| State | Meaning |
| --- | --- |
| `planned` | Saved draft or planned artifact. It is not executable. |
| `active` | Candidate execution artifact. It is executable only if validation passes and `readiness.status` is `ready`. |
| `completed` | Finished or archived artifact. It is not executable without a fresh Work Order. |

Rules:

- `planned` is not `active`.
- `active` is not `completed`.
- Only `active` plus `ready` plus `valid` is executable.
- A Markdown planning note is not an executable artifact unless code-owned
  canonicalization has produced a valid active Work Order.
- A completed Work Order cannot be rerun without an explicit new Work Order.

## Definition Of Ready Rules

Executable Work Orders must be active and must pass a Definition of Ready gate
before any worker launch.

`readiness.status` enum:

| Status | Meaning |
| --- | --- |
| `ready` | Required authority, scope, acceptance, verification, risk, review, and stop-condition fields are present enough for execution. |
| `blocked` | The producer knows the Work Order cannot safely execute yet. |
| `draft` | Content is still an incomplete draft, regardless of artifact lifecycle state. |

`readiness.checks[].status` enum:

- `satisfied`
- `partial`
- `missing`
- `blocked`

Rules:

- Only `active` Work Orders with `readiness.status` set to `ready` may execute.
- Readiness is a gate summary, not a substitute for schema validation.
- `readiness.checks[]` records producer-side readiness evidence, but code-owned
  validation still decides whether the artifact can run.
- Missing authority, ambiguous product behavior, absent write scope,
  unverifiable acceptance, missing patch budget, or missing stop conditions
  block before worker launch.
- A Markdown planning note should not be canonicalized into an executable Work
  Order until readiness blockers are resolved and the artifact is activated.

## Change Class And Patch Budget Rules

`change.class` enum:

| Class | Meaning |
| --- | --- |
| `product_behavior` | User-visible or runtime behavior authorized by active product authority. |
| `contract_schema` | Contract, schema, interface, or persisted artifact shape. |
| `refactor` | Behavior-preserving code restructuring. |
| `test_only` | Tests or fixtures without production behavior change. |
| `documentation` | Documentation that does not itself create product authority unless stored in an authority location. |
| `infrastructure_tooling` | Build, lint, CI, harness, or developer tooling. |
| `migration_data_change` | Migration, backfill, data movement, or data-shape change. |

`change.reviewDepth` enum:

- `low`
- `medium`
- `high`

`change.patchBudget` declares the reviewability budget before implementation:

| Field | Definition |
| --- | --- |
| `expectedFilesChanged` | Approximate expected changed-file count. |
| `maxApproxChangedLines` | Approximate maximum changed lines before the run should stop or be split. |
| `allowedSurfaces` | High-level surfaces allowed by the Work Order, such as `docs`, `src`, `tests`, `contracts`, `web`, or `migrations`. |
| `mayMixSurfaces` | Whether unrelated architectural surfaces may change in one patch. |
| `incidentalRefactors` | Whether drive-by refactors are allowed. |

Rules:

- Product behavior changes require active product authority in context or
  acceptance.
- Refactors require behavior-preservation evidence.
- Contract or schema changes require compatibility and consumer-impact review.
- Migration or data changes require rollback or recovery notes.
- Patch budget violations must be recorded in the Evidence Pack and should make
  the result `not_reviewable`, `blocked`, or require a fresh Work Order.
- Higher risk, wider patch budgets, and mixed surfaces require lower autonomy
  and stronger review.

## Path Rules

All Work Order paths other than `repositoryRoot` must be repo-relative.

Validation rules:

- Reject absolute paths in repo-relative fields.
- Reject empty path strings.
- Reject `.` as a write scope unless a future policy explicitly supports it.
- Reject `..` path traversal.
- Reject URL-like paths in path fields.
- Reject paths that escape `repositoryRoot` after normalization.
- Reject symlink or realpath escapes when resolving existing paths.
- Normalize path separators to `/` in persisted artifacts.
- Preserve trailing `/` only to indicate directory intent.
- Treat path matching as repository-root containment, not string-prefix trust.
- Treat case sensitivity according to the actual filesystem or configured repo policy. Ambiguity fails closed.

Worker output cannot introduce new paths into the allowed scope. A worker may
report observed paths, but the harness decides whether they are inside scope.

## Scope Rules

Scope is a hard boundary for writes. It is not a suggestion to the implementer.

### `scope.allowed`

`scope.allowed` lists files or directories that write-capable workers may modify.

Rules:

- Must be non-empty.
- Entries must be repo-relative.
- Entries may target existing files, existing directories, or approved new-file locations.
- Directory entries should end with `/`.
- An allowlisted directory allows writes under that directory only if not blocked by `scope.forbidden` or protected paths.
- Read-only roles receive no write permission even when scope is allowed.

### `scope.forbidden`

`scope.forbidden` lists files or directories that no worker may modify.

Rules:

- Forbidden paths override allowed paths.
- Forbidden paths apply to implementer and repair steps.
- Forbidden paths apply even if a worker claims the file is necessary.
- Forbidden paths are distinct from built-in protected paths. Both apply.

### `scope.newFiles`

Allowed enum values:

| Value | Meaning |
| --- | --- |
| `forbidden` | No new files may be created. Default if omitted by a producer before canonicalization. |
| `allowed` | New files may be created under `scope.allowed` directories, except forbidden or protected paths. |
| `listed_only` | New files may be created only at exact paths in `scope.allowedNewFiles`. |

### `scope.allowedNewFiles`

Rules:

- Required and non-empty when `scope.newFiles` is `listed_only`.
- Ignored for authorization when `scope.newFiles` is `forbidden`.
- Must be repo-relative.
- Must not overlap forbidden or protected paths.
- Must be contained by `scope.allowed`.
- Must list exact file paths, not broad directories, when `scope.newFiles` is `listed_only`.

### Protected Paths

The harness must maintain a built-in protected-path set. Protected paths are
denied by default.

Minimum protected set:

- `.git/`
- `.pi/`
- dependency directories such as `node_modules/`, `vendor/`, and `.venv/`
- build outputs such as `dist/`, `build/`, `coverage/`, and `.next/`
- secret-like files such as `.env`, `.env.*`, `*.pem`, `*.key`, and credential stores
- harness runtime state, run journals, locks, and apply transaction state
- OS or editor metadata that should not be task output

Protected paths may be read only when context or commands explicitly require
it and policy permits it. They are not write scope unless a future code-owned
policy defines an explicit override. The safer default is no override.

### Scope Overlap Rules

Validation must detect overlap before worker launch.

Rules:

- Allowed path equal to forbidden path blocks.
- Allowed directory containing forbidden child is valid only if the forbidden child remains denied.
- Forbidden directory containing allowed child blocks unless a future policy supports explicit child exceptions.
- Protected path in `scope.allowed` blocks.
- Protected path in `scope.allowedNewFiles` blocks.
- New-file paths outside `scope.allowed` block.
- Ambiguous normalization, symlink, realpath, or case behavior blocks.

### Scope Drift

Scope drift occurs when:

- a write changes a path outside `scope.allowed`
- a write changes a forbidden path
- a write changes a protected path
- a new file violates `scope.newFiles`
- a repair proposal needs wider scope
- worker output asks to add paths after approval
- verification or command execution requires an unapproved action class

Scope drift must produce `blocked`, `failed`, or a fresh Work Order requirement.
It must not be silently repaired by widening scope.

## Context Rules

Context is evidence-bearing input to role packets. It is not policy authority.

### Explicit Context Files

`context.files[]` entries:

| Field | Required | Definition |
| --- | --- | --- |
| `path` | yes | Repo-relative path to include or inspect. |
| `required` | yes | If true, missing or truncated content blocks. |
| `reason` | yes | Why the file is relevant to this Work Order. |
| `hash` | optional | Content fingerprint captured at validation or packet build time. |

Rules:

- Required context files must exist before worker launch.
- Missing optional context must be recorded in the Evidence Pack.
- Context files may be outside write scope.
- Context files do not authorize writes.
- Context drift between validation and worker launch fails closed when the context is required or fingerprinted.

### Notes

`context.notes[]` captures human or producer facts that are not files.

Rules:

- Notes must be attributable by `source`.
- Notes may constrain acceptance or non-goals only when copied into those fields.
- Notes cannot widen scope.
- Notes cannot substitute for missing required context files.

### Prior Artifacts

`context.priorArtifacts[]` may reference prior Work Orders, Evidence Packs,
review findings, design specs, or issue records.

Rules:

- Prior artifacts must validate on load if they are persisted harness artifacts.
- Invalid prior artifacts fail closed if required.
- Prior artifacts may inform context, but they do not authorize current scope.
- Prior Evidence Packs do not make current verification unnecessary unless the current Work Order explicitly marks the related claim as `not_applicable` with a reason.

### Context Manifest And Provenance

`context.manifest[]` records what context was included, why, and whether it was
truncated.

Recommended entry fields:

| Field | Definition |
| --- | --- |
| `kind` | `explicit_file`, `note`, `prior_artifact`, `explorer_finding`, `diff`, `review_finding`, or `derived`. |
| `reference` | Repo-relative path, artifact id, finding id, or note id. |
| `provenance` | Source field or code path that selected it. |
| `reason` | Why the role needs it. |
| `included` | Whether it was included in a role packet. |
| `truncated` | Whether content was truncated. |
| `hash` | Optional content fingerprint. |

### Budget And Truncation

Context budget rules:

- Required context must not be silently truncated.
- If required context cannot fit, block before worker launch or produce a narrower Work Order.
- Optional context may be summarized or omitted only when the omission is recorded.
- Role packets should receive scoped context, not every prior chat message.
- Explorer facts forwarded to implementer must be structured facts, not hidden policy decisions.

## Acceptance Rules

`acceptance[]` defines what must be true for the Work Order to be satisfied.

Entry shape:

```json
{
  "id": "acc-001",
  "text": "The schema states that success and reviewability are separate.",
  "required": true,
  "evidenceRequired": true
}
```

Rules:

- At least one acceptance item must be required.
- Acceptance items must be observable by code review, diff inspection, command output, or explicit human review.
- Vague acceptance such as "make it better" blocks.
- Acceptance cannot require work outside scope.
- Acceptance cannot override `nonGoals`.
- Optional acceptance items must not be reported as required proof.
- Every required acceptance item should map to a claim in the Evidence Pack.

## Verification Rules

`verification` defines proof expectations. It does not prove anything by itself.

### Explicit Commands

Command entry shape:

```json
{
  "id": "verify-unit",
  "command": "npm test -- test/work-order.test.js",
  "cwd": ".",
  "required": true,
  "actionClasses": ["read_repository", "execute_local_command"],
  "reason": "Runs the focused Work Order validation tests."
}
```

Rules:

- `command` is the planned command string.
- `cwd` is repo-relative and defaults to `.` only after canonicalization.
- Required commands must run successfully for required verification claims to be proven.
- Planned commands are not commands run.
- Command observations belong in the Evidence Pack.
- Commands with dependency install, network, git mutation, destructive, secret, deploy, publish, or irreversible action classes require approval unless policy blocks them outright.

### Derived Commands

`verification.allowDerivedCommands` controls whether the harness may derive
additional verification commands.

Rules:

- Derived commands must stay within approved action classes.
- Derived commands must be recorded with source `derived`.
- Derived commands cannot replace required explicit commands unless policy
  defines an equivalence and the Evidence Pack records it.
- Derived commands cannot require broader scope or approval than the Work Order allows.

### Required Versus Advisory Verification

`verification.required` means the Work Order requires verification evidence for
reviewable success.

Rules:

- If `verification.required` is true and no required command can run, the run may still end `success`, but reviewability must be `not_reviewable` or `unknown`.
- Advisory commands may improve evidence but cannot satisfy required acceptance unless mapped to a required claim.
- Skipped required commands must be listed in the Evidence Pack as commands not run.

## Execution Control Rules

Execution controls constrain how much authority a worker receives. They do not
grant write scope, approve action classes, or prove correctness.

`execution.autonomyLevel` enum:

| Level | Meaning |
| --- | --- |
| `assist` | Suggestions or explanation only; no repository writes. |
| `scoped_edit` | One selected area or file, usually human-directed. |
| `bounded_patch` | Worker may produce a patch only inside Work Order scope. Default for implementation Work Orders. |
| `supervised_agent` | Worker may edit and run commands with explicit review checkpoints. |
| `autonomous_run` | Only for low-risk, well-tested, strongly scoped tasks with code-owned safeguards. |

`execution.modelToolRoute` records the intended route when it affects quality or
safety. If no route matters, `routeRequired` should be `false` and the reason
should say why.

Minimum model/tool route fields:

| Field | Definition |
| --- | --- |
| `routeRequired` | Whether a specific model, provider, tool, or worker route is required. |
| `preferredWorker` | `deterministic_local`, `process_model`, `manual`, or another code-owned worker id. |
| `preferredModels` | Per-role model preferences when model-backed workers are used. |
| `tools` | Expected tool or action-class vocabulary for this Work Order. |
| `rationale` | Why the route is appropriate for the change class and risk. |

Rules:

- Autonomy level must not exceed what scope, risk, patch budget, and approval
  allow.
- Model/tool routing is evidence-bearing metadata, not permission.
- A stronger model does not relax scope, verification, or review requirements.
- Role packet entries identify expected role output contracts; prompt text or
  skill text cannot widen role permissions.
- Counterexample review should be required for high-risk work and for any
  medium-risk work with ambiguity, broad patch budget, weak verification, or
  product-authority risk.
- LLM-council or multi-model disagreement may be recorded as review signal, but
  model agreement is not evidence.

## Risk Rules

`risk.level` enum:

| Level | Typical Scope |
| --- | --- |
| `low` | Docs-only edits, small isolated bug fixes, narrow tests, no public behavior change beyond the Work Order. |
| `medium` | Feature slice, bounded refactor, behavior change with tests, persistence-adjacent work without schema migration. |
| `high` | Approval logic, security-sensitive code, migrations, dependency changes, secrets, auth, permissions, data-loss risk, deploy, publish, delete, harness policy, or state-machine changes. |

Rules:

- `risk.reasons[]` must explain the selected level.
- Risk may be escalated by validation or preflight.
- Risk must not be downgraded by worker opinion.
- High-risk work requires approval unless policy blocks it entirely.
- Risk escalation examples include protected path contact, broader action classes, missing sandbox for sandbox-required runs, schema migration, persistence format changes, and destructive commands.

## Operational Readiness Rules

`operationalReadiness` records how breakage would be noticed and how the change
would be rolled back or recovered. It is input to review and evidence; it does
not authorize unsafe actions.

`operationalReadiness.observability` shape:

```json
{
  "breakageDetection": "How a regression would be noticed.",
  "signals": ["tests, logs, metrics, traces, contract checks, or manual inspections"],
  "manualChecks": ["Any human checks expected after the run."]
}
```

`operationalReadiness.rollbackRecovery` shape:

```json
{
  "required": true,
  "plan": "How to roll back or recover if this change breaks.",
  "recoverySteps": ["Concrete rollback, revert, migration, backfill, or mitigation steps."],
  "notApplicableReason": null
}
```

Rules:

- Medium-risk and high-risk Work Orders must include meaningful observability
  and rollback/recovery notes.
- Migration, persistence, deploy, external-integration, data-loss, auth,
  permission, publish, or destructive work requires `rollbackRecovery.required`
  to be true unless policy blocks the Work Order entirely.
- Low-risk Work Orders may mark rollback/recovery not applicable, but the reason
  must be explicit.
- Observability signals may be manual before production, but missing detection
  for medium-risk or high-risk work should block or downgrade reviewability.
- Rollback/recovery notes do not authorize destructive, deploy, network, or git
  mutation action classes. Those still require policy and approval.

## Approval Rules

Approval is required when policy, risk, action classes, or environment gates
require it.

Approval binding fields:

| Field | Definition |
| --- | --- |
| `approvalId` | Stable approval record id. |
| `approvedAt` | Timestamp of approval. |
| `approvedBy` | Human or system actor that approved. |
| `approvedFingerprint` | Must match the normalized canonical Work Order policy fingerprint. |
| `approvedActionClasses` | Must equal the canonical requested command action-class set after de-duplication and sorting. |

Approval authorizes only the exact Work Order identity, fingerprint, repository
root, action scope, and policy profile. Work Order id, repository root, scope,
policy profile, risk, verification requirements, and repair limits are bound
through `approvedFingerprint`; action-class coverage is also checked directly by
canonical `approvedActionClasses` equality.

Approval does not authorize:

- future Work Order rewrites
- wider allowed paths
- fewer forbidden or protected paths
- broader new-file policy
- new action classes
- approval-sensitive derived commands
- repair outside clamped scope
- technical correctness
- reviewable success
- prompt or skill override of code-owned policy

If the Work Order changes after approval, the approval is stale and execution
blocks until a new approval is recorded.

## Role Policy

Roles are capability envelopes, not personalities.

| Role | Write Capability | Required Boundary |
| --- | --- | --- |
| `explorer` | read-only | May inspect repository and context. Must not write. |
| `implementer` | write-capable | May write only inside allowed scope and new-file policy. |
| `reviewer` | read-only | May inspect diff, context, claims, and evidence. Must not write. |
| `verifier` | read-only | May run or inspect verification. Must not write. |

Rules:

- Read-only roles cannot write, even if prompt text asks them to.
- Implementer writes only in allowlist.
- Forbidden paths override implementer allowlist.
- Protected paths are denied by default.
- Role docs, prompts, and skills cannot grant permissions.
- One write-capable worker should own a path within a single execution step.
- Worker output cannot widen role capabilities.

## New File Policy

New files are denied unless explicitly authorized by `scope.newFiles`.

Validation rules:

- `forbidden`: any new file blocks or fails the implementer result.
- `allowed`: new files must be under `scope.allowed` and outside forbidden/protected paths.
- `listed_only`: new files must exactly match `scope.allowedNewFiles`.
- New directories follow the same policy as new files.
- Generated cache, build, coverage, lock, or runtime files are not automatically accepted.
- A worker claim that a new file is required is not authorization.

## Repair Policy

Repair starts only from blocking reviewer findings or verifier failures that are
inside the original Work Order scope.

Repair Work Order rules:

- Derived from the original Work Order.
- References source `workOrderId` and `workOrderFingerprint`.
- Includes concrete `findingIds`.
- Carries the original forbidden and protected paths.
- Clamps allowed scope to original allowed paths plus files implicated by blocking findings.
- Uses the original risk level or an escalated level.
- Does not reduce approval requirements.
- Does not widen action classes.
- Does not create new files unless the original new-file policy permits them.

Repair loop fields:

```json
{
  "repair": {
    "maxLoops": 1,
    "mayWidenScope": false
  }
}
```

Rules:

- Default repair budget is one loop.
- `maxLoops` may be `0` for no automatic repair.
- More than one repair loop requires explicit Work Order permission.
- Repair cannot widen scope.
- If findings require wider scope, stop with `repair_required` or `blocked` and request a new Work Order.
- Repair output is subject to the same validation as initial implementer output.

## Status And Failure Behavior

Pre-worker validation statuses:

| Condition | Result |
| --- | --- |
| Invalid schema | `blocked` |
| Unknown schema version | `blocked` |
| Unknown policy profile | `blocked` |
| Missing required field | `blocked` |
| Ambiguous goal or acceptance | `blocked` |
| Empty write scope | `blocked` |
| Protected path in write scope | `blocked` |
| Path traversal or repo-root escape | `blocked` |
| Approval required but missing | `blocked` |
| Required context missing or drifted | `blocked` |
| Required verification impossible under policy | `blocked` or `not_reviewable` success, depending on whether execution can still satisfy the Work Order without proof. |

Worker result validation statuses:

- Invalid worker output fails closed.
- Worker-reported changed files are not trusted without parent-side observation.
- Scope violations block or fail the run.
- Read-only writes fail the role result.
- No-op implementer success without evidence is not reviewable.
- Runtime context drift fails closed.
- Persisted artifacts validate on load. Invalid persisted artifacts fail closed.
- Terminal runs do not resume.

## Fingerprinting And Canonicalization

The harness must compute a canonical Work Order fingerprint before approval and
execution.

Canonicalization expectations:

- Normalize paths to repo-relative `/` separators.
- Resolve `repositoryRoot` to a stable absolute root.
- Sort order-insensitive arrays where schema declares order irrelevant.
- De-duplicate and sort action-class arrays before hashing.
- Preserve order-sensitive arrays such as acceptance and command lists.
- Remove presentation-only fields from the policy fingerprint only if schema
  explicitly marks them non-binding.
- Neutralize volatile approval record fields before hashing:
  `approvalId`, `approvedAt`, `approvedBy`, and `approvedFingerprint`.
- Include schema version, kind, state, id, goal, repository root, policy profile,
  readiness, change class, review depth, patch budget, scope, context requirements,
  acceptance, verification requirements, execution controls, risk, operational
  readiness, approval requirements, canonical approved action classes,
  non-goals, and repair limits.
- Include extension fields only when schema-aware code validates and declares
  them binding.
- Hash the canonical JSON representation with a documented algorithm.

Approval, worker packets, repair Work Orders, and Evidence Packs must reference
the canonical fingerprint they were built from.

## Minimal Valid Work Order

```json
{
  "schemaVersion": 1,
  "kind": "work_order",
  "state": "active",
  "id": "wo-minimal-doc-edit",
  "goal": "Fix a typo in docs/README-NOTES.md.",
  "repositoryRoot": "/absolute/path/to/repo",
  "policyProfile": "default",
  "readiness": {
    "status": "ready",
    "checks": [
      {
        "id": "authority-cited",
        "status": "satisfied",
        "evidence": "docs/README-NOTES.md"
      }
    ],
    "blockers": []
  },
  "change": {
    "class": "documentation",
    "reviewDepth": "low",
    "patchBudget": {
      "expectedFilesChanged": 1,
      "maxApproxChangedLines": 20,
      "allowedSurfaces": ["docs"],
      "mayMixSurfaces": false,
      "incidentalRefactors": false
    }
  },
  "scope": {
    "allowed": ["docs/README-NOTES.md"],
    "forbidden": [".git/", ".pi/", "node_modules/", ".env"],
    "newFiles": "forbidden",
    "allowedNewFiles": []
  },
  "context": {
    "files": [
      {
        "path": "docs/README-NOTES.md",
        "required": true,
        "reason": "Target document."
      }
    ],
    "notes": [],
    "priorArtifacts": [],
    "manifest": [],
    "budget": {
      "maxTokens": 20000,
      "truncationPolicy": "fail_if_required_context_truncated"
    }
  },
  "acceptance": [
    {
      "id": "acc-001",
      "text": "The typo is corrected without changing runtime code.",
      "required": true
    }
  ],
  "verification": {
    "commands": [
      {
        "id": "verify-diff-check",
        "command": "git diff --check",
        "cwd": ".",
        "required": true,
        "actionClasses": ["read_repository", "execute_local_command"],
        "reason": "Check patch formatting."
      }
    ],
    "allowDerivedCommands": true,
    "required": true
  },
  "execution": {
    "autonomyLevel": "scoped_edit",
    "modelToolRoute": {
      "routeRequired": false,
      "preferredWorker": "deterministic_local",
      "preferredModels": [],
      "tools": ["read_repository", "execute_local_command"],
      "rationale": "A deterministic local edit is enough for a typo fix."
    },
    "rolePackets": [],
    "counterexampleReview": {
      "required": false,
      "reason": "Low-risk documentation typo fix."
    }
  },
  "nonGoals": ["Do not edit runtime files."],
  "risk": {
    "level": "low",
    "reasons": ["Single documentation edit."]
  },
  "operationalReadiness": {
    "observability": {
      "breakageDetection": "A reviewer would notice an incorrect typo fix in the rendered docs or diff.",
      "signals": ["git diff --check"],
      "manualChecks": ["Inspect the changed sentence."]
    },
    "rollbackRecovery": {
      "required": false,
      "plan": null,
      "recoverySteps": [],
      "notApplicableReason": "Single-file documentation edit can be reverted directly."
    }
  },
  "reviewFocus": ["Confirm no runtime files changed."],
  "approval": {
    "required": false,
    "approvalId": null,
    "approvedAt": null,
    "approvedBy": null,
    "approvedFingerprint": null,
    "approvedActionClasses": []
  },
  "repair": {
    "maxLoops": 1,
    "mayWidenScope": false
  },
  "extensions": {}
}
```

## Bad Work Order Examples

### Vague Goal

```json
{
  "schemaVersion": 1,
  "kind": "work_order",
  "id": "wo-bad-vague",
  "goal": "Make the app better.",
  "repositoryRoot": "/absolute/path/to/repo",
  "policyProfile": "default",
  "scope": {
    "allowed": ["src/"],
    "forbidden": [],
    "newFiles": "allowed",
    "allowedNewFiles": []
  },
  "context": {
    "files": [],
    "notes": [],
    "priorArtifacts": [],
    "manifest": [],
    "budget": {
      "maxTokens": 50000,
      "truncationPolicy": "record_optional_omissions"
    }
  },
  "acceptance": [
    {
      "id": "acc-001",
      "text": "It works well.",
      "required": true
    }
  ],
  "verification": {
    "commands": [],
    "allowDerivedCommands": true,
    "required": true
  },
  "risk": {
    "level": "medium",
    "reasons": ["Unknown."]
  },
  "approval": {
    "required": false,
    "approvalId": null
  },
  "repair": {
    "maxLoops": 1,
    "mayWidenScope": false
  },
  "extensions": {}
}
```

Why it blocks:

- Goal is not bounded.
- Acceptance is not observable.
- Verification is required but no command exists.
- Forbidden paths omit built-in protected paths only if code applies them; this artifact should still be canonicalized before execution.

### Path Escape

```json
{
  "schemaVersion": 1,
  "kind": "work_order",
  "id": "wo-bad-escape",
  "goal": "Edit an external config file.",
  "repositoryRoot": "/absolute/path/to/repo",
  "policyProfile": "default",
  "scope": {
    "allowed": ["../outside-repo/config.json"],
    "forbidden": [],
    "newFiles": "forbidden",
    "allowedNewFiles": []
  },
  "context": {
    "files": [],
    "notes": [],
    "priorArtifacts": [],
    "manifest": [],
    "budget": {
      "maxTokens": 10000,
      "truncationPolicy": "fail_if_required_context_truncated"
    }
  },
  "acceptance": [
    {
      "id": "acc-001",
      "text": "Config is changed.",
      "required": true
    }
  ],
  "verification": {
    "commands": [],
    "allowDerivedCommands": false,
    "required": false
  },
  "risk": {
    "level": "high",
    "reasons": ["External write."]
  },
  "approval": {
    "required": true,
    "approvalId": "approval-1",
    "approvedAt": "2026-04-29T12:00:00.000Z",
    "approvedBy": "reviewer",
    "approvedFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "approvedActionClasses": []
  },
  "repair": {
    "maxLoops": 0,
    "mayWidenScope": false
  },
  "extensions": {}
}
```

Why it blocks:

- `scope.allowed` escapes `repositoryRoot`.
- Approval cannot authorize repo-root escape.

### Worker-Driven Scope Expansion

```json
{
  "schemaVersion": 1,
  "kind": "work_order",
  "id": "wo-bad-worker-scope",
  "goal": "Apply whatever files the implementer decides are needed.",
  "repositoryRoot": "/absolute/path/to/repo",
  "policyProfile": "default",
  "scope": {
    "allowed": ["src/requested.js"],
    "forbidden": [".git/", ".pi/"],
    "newFiles": "forbidden",
    "allowedNewFiles": []
  },
  "context": {
    "files": [],
    "notes": [
      {
        "text": "Worker may add files if needed.",
        "source": "human"
      }
    ],
    "priorArtifacts": [],
    "manifest": [],
    "budget": {
      "maxTokens": 10000,
      "truncationPolicy": "record_optional_omissions"
    }
  },
  "acceptance": [
    {
      "id": "acc-001",
      "text": "Requested behavior changes.",
      "required": true
    }
  ],
  "verification": {
    "commands": [],
    "allowDerivedCommands": true,
    "required": false
  },
  "risk": {
    "level": "medium",
    "reasons": ["Behavior change."]
  },
  "approval": {
    "required": false,
    "approvalId": null
  },
  "repair": {
    "maxLoops": 1,
    "mayWidenScope": true
  },
  "extensions": {}
}
```

Why it blocks or canonicalization rejects it:

- Notes cannot authorize worker-driven scope expansion.
- `repair.mayWidenScope` must be false for the rebuild target.
- New-file policy is `forbidden`.

## Future Extension Fields

`extensions` is reserved for future producers and adapters.

Rules:

- Extension fields are non-authoritative until schema-aware code validates them.
- Unknown extension fields must not affect scope, approval, role capability,
  verification requirements, policy profile, repair budget, or status.
- If an extension field claims authority over a policy decision, validation must reject it unless the active schema explicitly supports it.
- Extension fields included in approval or execution fingerprints must be declared binding by code.
- Extension fields omitted from fingerprints must be treated as presentation or advisory only.
