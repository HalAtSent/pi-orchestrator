# Coding Quality Harness

This document defines the rebuild target for the harness.

The goal is not autonomous project planning. The goal is a coding-oriented
quality harness:

> Given a precise coding Work Order, produce the best scoped, reviewed, and
> verified patch the selected model can feasibly produce.

Planning may happen elsewhere: in Codex, in a human conversation, in a product
planning document, or in a future `/build` adapter. The harness starts when
there is enough information to execute a bounded coding change.

The core handoff artifact is a **Work Order**.

The JSON snippets in this overview are abbreviated examples. They show the
major controls the harness should care about, not the full persisted artifact
schemas. Detailed artifact shape authority lives in
[WORK-ORDER-SCHEMA.md](./WORK-ORDER-SCHEMA.md) and
[EVIDENCE-PACK-SCHEMA.md](./EVIDENCE-PACK-SCHEMA.md). If this overview omits or
collapses a field, the detailed schema document wins.

## Mission

The harness exists to maximize output quality from any model by combining:

- precise task handoff
- strict scope boundaries
- isolated role contexts
- independent critique
- bounded repair
- evidence-backed verification
- truthful final reporting

The harness should make strong models better, not replace judgment with ceremony.

For GPT-5.5-class models, the harness should not compensate for weakness by
adding excessive orchestration. It should instead force the model through the
quality constraints that still matter for real software work:

- scoped context
- clear acceptance criteria
- independent review
- explicit evidence
- no hidden scope widening
- no unearned confidence

## Workflow Controls

The rebuild should make the most important workflow controls explicit in Work
Orders and Evidence Packs:

- Definition of Ready before execution
- context pack provenance and truncation truth
- change class
- patch budget
- risk-appropriate review depth
- declared autonomy level
- model/tool route when it affects quality or safety
- fast verification loop evidence
- counterexample review for risky or ambiguous work
- agent scorecard data for model-backed runs

These controls are not product authority. They are execution and review
constraints that help the harness decide whether to run, stop, repair, or report
`not_reviewable`.

## Core Principle

The harness does not decide what product to build.

The harness takes a precise coding contract and produces a high-quality patch.

Recommended architecture:

```text
Planning surface -> Work Order -> Coding Quality Harness -> Evidence Pack
```

Examples of planning surfaces:

- human-written Work Order
- Codex planning chat
- issue or PR description
- design spec
- future project-template system
- future `/build` operator adapter

Those surfaces may create Work Orders. They do not belong inside the execution
kernel.

## What This Replaces

The rebuild should move away from a core centered on:

- generic project lifecycle planning
- brainstorm / blueprint / slice / audit as kernel concepts
- product-management scaffolding
- broad template inference inside `/build`
- non-technical operator mode as a core concern

Those may return later as adapters.

The rebuilt core should center on:

- Work Order validation
- scoped execution
- role isolation
- patch quality
- review and verification evidence
- truthful persistence

## Non-Goals

The kernel should not:

- invent product requirements
- choose app architecture from a vague prompt
- generate project templates during normal execution
- act as a product manager
- treat operator approval as technical approval
- rely on prompt text for policy enforcement
- run unbounded agent swarms
- accept model confidence as evidence
- claim success without reviewable proof

If an input is not executable as a bounded coding task, the correct result is
`blocked`, not improvisation.

## Primary Artifact: Work Order

A Work Order is the structured input to the harness.

It must tell the harness exactly what outcome is wanted, what scope is allowed,
what context matters, and how success should be judged.

### Abbreviated Work Order Overview Example

This compact example is not the full Work Order schema. Use
[WORK-ORDER-SCHEMA.md](./WORK-ORDER-SCHEMA.md) as the detailed Work Order
artifact shape authority.

```json
{
  "schemaVersion": 1,
  "kind": "work_order",
  "state": "planned|active|completed",
  "id": "work-order-unique-id",
  "title": "Short human-readable title",
  "goal": "Exact coding outcome wanted.",
  "repositoryRoot": "/absolute/path/to/repo",
  "policyProfile": "default",
  "readiness": {
    "status": "ready"
  },
  "change": {
    "class": "product_behavior|contract_schema|refactor|test_only|documentation|infrastructure_tooling|migration_data_change",
    "reviewDepth": "low|medium|high",
    "patchBudget": {}
  },
  "scope": {
    "allowed": ["relative/path/or/directory"],
    "forbidden": ["relative/path/or/directory"],
    "newFiles": "allowed|forbidden|listed_only",
    "allowedNewFiles": ["relative/path"]
  },
  "context": {
    "files": ["SPEC.md", "src/module.ts"],
    "notes": ["Relevant human decisions or constraints."],
    "externalReferences": []
  },
  "acceptance": [
    "Observable behavior or code property that must be true."
  ],
  "verification": {
    "commands": ["npm test -- specific.test.js"],
    "allowDerivedCommands": true,
    "required": true
  },
  "execution": {
    "autonomyLevel": "assist|scoped_edit|bounded_patch|supervised_agent|autonomous_run",
    "modelToolRoute": {},
    "rolePackets": [],
    "counterexampleReview": {
      "required": false
    }
  },
  "nonGoals": [
    "Things that must not be changed."
  ],
  "risk": {
    "level": "low|medium|high",
    "reasons": ["Why this may be tricky or hazardous."]
  },
  "operationalReadiness": {
    "observability": {},
    "rollbackRecovery": {}
  },
  "reviewFocus": [
    "Specific failure modes the reviewer should hunt."
  ],
  "approval": {
    "required": false,
    "approvalId": null
  }
}
```

### Required Fields

Minimum executable Work Order:

- `schemaVersion`
- `kind`
- `state`
- `id`
- `goal`
- `repositoryRoot`
- `policyProfile`
- `readiness.status`
- `change.class`
- `change.reviewDepth`
- `change.patchBudget`
- `scope.allowed`
- `scope.forbidden`
- `acceptance`
- `verification`
- `execution.autonomyLevel`
- `execution.modelToolRoute`
- `risk.level`
- `operationalReadiness`

If any minimum field is missing, the harness should block before worker launch.

### Work Order Quality Bar

A good Work Order is:

- specific enough for implementation without guessing
- bounded to files or directories
- clear about non-goals
- explicit about verification expectations
- honest about known uncertainty
- small enough for review

A bad Work Order says:

- "build the whole app"
- "fix everything"
- "make it better"
- "use your judgment" without scope
- "implement the spec" without slicing

The harness may help diagnose a bad Work Order, but it should not execute it.

## Scope Model

Scope is a hard boundary.

### Allowed Paths

`scope.allowed` defines where write-capable workers may write.

Allowed entries may be files or directories.

Examples:

```json
["src/session/", "test/session.test.js"]
```

### Forbidden Paths

`scope.forbidden` always wins.

Examples:

```json
[".git/", ".env", "node_modules/", "build/"]
```

### Protected Paths

The harness should maintain a built-in protected-path set.

Protected paths should include at minimum:

- `.git/`
- `.pi/`
- dependency directories
- build output directories
- coverage directories
- secret files
- harness runtime state

Protected paths are denied unless a future policy explicitly supports an
approval override. The safer default is no override.

### New Files

New-file policy must be explicit:

- `forbidden`: no new files
- `allowed`: new files allowed under allowed directories
- `listed_only`: only paths in `allowedNewFiles`

Default should be `forbidden` unless the Work Order says otherwise.

### Scope Drift

Scope drift occurs when:

- implementation changes an unallowed file
- implementation changes a forbidden file
- implementation adds unapproved new files
- reviewer proposes a fix outside scope
- verifier requires checks outside allowed risk/action class

Scope drift should produce `blocked` or a fresh Work Order requirement.

## Risk And Approval

Risk classification gates execution and review intensity.

### Risk Levels

`low`:

- docs-only edits
- small isolated bug fixes
- tests in narrow scope
- no public behavior change beyond the Work Order

`medium`:

- feature slice
- refactor inside bounded module
- behavior change with tests
- persistence-adjacent but not schema-changing work

`high`:

- approval logic
- security-sensitive code
- migrations
- dependency changes
- secrets, auth, permissions
- data-loss risk
- deploy/publish/delete actions
- harness policy/state-machine changes

### Approval Binding

If approval is required, it must bind to:

- Work Order id
- Work Order fingerprint
- repository root
- allowed paths
- derived action classes
- policy profile
- timestamp

Approval must not authorize:

- future Work Order rewrites
- wider scope
- new action classes
- later repair outside scope

### Technical Approval

Operator approval means "you may run this bounded work."

It does not mean:

- the design is technically sound
- the resulting patch is merge-grade
- evidence is sufficient

Technical approval remains a separate human or reviewer decision unless a future
system explicitly models it.

## Execution Loop

The default loop:

```text
validate Work Order
preflight repository
explore
implement
review
repair if needed
verify
produce Evidence Pack
```

The loop should be boring, strict, and repeatable.

## Stage 1: Validation

Before worker launch, validate:

- Work Order schema
- Definition of Ready status
- change class, review depth, and patch budget
- autonomy level and model/tool route declaration
- observability and rollback/recovery declaration
- repository root exists
- repository root is not protected runtime/dependency directory
- allowed and forbidden paths are relative and non-escaping
- allowed and forbidden paths do not overlap unsafely
- protected paths are not in scope
- context files exist when required
- verification commands are declared or derivable
- risk and approval state are consistent
- counterexample-review requirement is declared
- policy profile is valid

If validation fails, return `blocked`.

Do not ask workers to resolve invalid control-plane input.

## Stage 2: Preflight

Preflight checks runtime readiness.

Suggested checks:

- git repository exists
- worktree baseline is known
- package/build/test command discovery
- requested verification commands look available
- process backend availability
- sandbox availability when required
- model/provider availability
- stale run locks or incomplete apply transactions

Preflight may return:

- `pass`
- `warning`
- `blocked`

Warnings can proceed if they do not undermine the Work Order's claims.

Examples:

- missing default test script may warn if explicit commands exist
- dirty worktree may warn or block depending on changed-surface requirements
- unavailable sandbox blocks if sandbox was required

## Stage 3: Explorer

Explorer is read-only.

Purpose:

- reduce implementation guessing
- collect current facts
- identify relevant files
- identify hidden constraints
- identify likely implementation points
- surface open questions before writing

Explorer must not:

- edit files
- propose open-ended scope expansion
- claim authority over approval
- produce implementation patches

Explorer output should be structured:

```json
{
  "status": "success|blocked",
  "relevantFiles": [],
  "currentBehavior": [],
  "constraints": [],
  "implementationOptions": [],
  "recommendedApproach": "",
  "openQuestions": [],
  "contextForImplementer": []
}
```

The implementer should receive explorer facts, not the explorer's full chain of
thought or persuasive narrative.

## Stage 4: Implementer

Implementer is write-capable only within scope.

Purpose:

- produce the smallest correct patch satisfying the Work Order
- preserve unrelated behavior
- add or update tests when appropriate
- record claims and evidence

Implementer must output:

```json
{
  "status": "success|blocked|failed",
  "changedFiles": [],
  "summary": "",
  "claims": [],
  "commandsRun": [],
  "validationEvidence": [],
  "openQuestions": []
}
```

Implementer must not:

- edit outside scope
- weaken tests to pass
- remove validation unless explicitly required
- silently change public behavior outside the Work Order
- present unrun checks as passing
- mark no-op success without evidence

If the implementer discovers the Work Order is wrong or insufficient, it should
return `blocked` with a concrete reason.

## Stage 5: Reviewer

Reviewer is independent and read-only.

Reviewer should receive:

- Work Order
- relevant context
- diff
- implementer claims
- command evidence

Reviewer should not receive implementer confidence framing as authority.

Purpose:

- find correctness bugs
- find scope drift
- find missing tests
- find weak assumptions
- find brittle design
- find acceptance gaps
- find evidence gaps

Reviewer output:

```json
{
  "status": "success|repair_required|blocked",
  "findings": [
    {
      "id": "finding-1",
      "severity": "blocking|non_blocking",
      "file": "relative/path",
      "line": 42,
      "problem": "",
      "requiredCorrection": "",
      "evidence": ""
    }
  ],
  "scopeConcerns": [],
  "missingVerification": [],
  "openQuestions": []
}
```

Reviewer rules:

- blocking findings must be specific and actionable
- non-blocking observations must not trigger repair loops
- reviewer cannot widen write scope
- reviewer cannot approve missing evidence by vibes
- reviewer should challenge acceptance and preservation, not just syntax

## Stage 6: Repair

Repair is bounded.

When reviewer returns blocking findings, the harness creates a repair Work Order
derived from the original Work Order.

Repair scope is clamped to:

- original allowed paths
- files implicated by blocking findings
- any explicitly approved same-slice companion files

Repair instructions should include:

- finding ids
- required corrections
- forbidden changes
- expected verification

Repair loops should be limited.

Default:

- one repair loop for normal work
- two only when the Work Order explicitly permits it

If blocking findings remain after repair budget is exhausted, terminal status is
`repair_required`.

## Stage 7: Verifier

Verifier is read-only.

Purpose:

- run or inspect verification
- separate proven claims from unproven claims
- record command results
- identify remaining uncertainty

Verifier output:

```json
{
  "status": "success|failed|blocked",
  "commandsRun": [
    {
      "command": "npm test -- test/foo.test.js",
      "exitCode": 0,
      "summary": ""
    }
  ],
  "provenClaims": [],
  "unprovenClaims": [],
  "failedChecks": [],
  "notRun": [],
  "openQuestions": []
}
```

Verifier must not:

- edit files
- treat planned commands as run commands
- hide skipped checks
- claim full correctness from narrow checks

If no verification can be run, the final Evidence Pack must say so.

## Final Artifact: Evidence Pack

The Evidence Pack is the output of the harness.

It should be useful for a human reviewer deciding whether the patch is
merge-grade.

Abbreviated Evidence Pack overview example:

This compact example is not the full Evidence Pack schema. Use
[EVIDENCE-PACK-SCHEMA.md](./EVIDENCE-PACK-SCHEMA.md) as the detailed Evidence
Pack artifact shape authority.

```json
{
  "schemaVersion": 1,
  "kind": "evidence_pack",
  "id": "evidence-pack-id",
  "workOrder": {
    "id": "work-order-id",
    "fingerprint": "sha256:canonical-work-order-hash",
    "repositoryRoot": "/absolute/path/to/repo",
    "policyProfile": "default"
  },
  "status": "success|blocked|failed|repair_required",
  "reviewability": {
    "status": "reviewable|not_reviewable|unknown",
    "reasons": []
  },
  "summary": "",
  "readinessEvidence": {},
  "runConfiguration": {
    "changeClass": "",
    "reviewDepth": "",
    "patchBudget": {},
    "autonomyLevelPlanned": "",
    "autonomyLevelUsed": "",
    "modelToolRoutePlanned": {},
    "modelToolRouteUsed": {},
    "counterexampleReview": {}
  },
  "operationalReadinessEvidence": {
    "observability": {},
    "rollbackRecovery": {}
  },
  "changedFiles": [],
  "diffRef": "",
  "scope": {
    "allowed": [],
    "forbidden": [],
    "violations": []
  },
  "claims": [
    {
      "claim": "",
      "status": "proven|manually_inspected|partial|inferred|unproven|skipped|failed|not_applicable",
      "evidenceRefs": []
    }
  ],
  "commandsRun": [],
  "fastVerificationLoop": {},
  "reviewFindings": [],
  "counterexampleFindings": [],
  "humanReview": {},
  "repairs": [],
  "verification": {},
  "unresolvedQuestions": [],
  "stopReason": null,
  "modelEvidence": [],
  "agentScorecard": [],
  "debtRegister": [],
  "residualRisk": []
}
```

The Evidence Pack must distinguish:

- planned readiness and actual readiness evidence
- planned autonomy and actual autonomy used
- planned model/tool route and actual route used
- planned breakage detection and actual detection evidence
- planned rollback/recovery and actual recovery evidence
- observed facts
- worker claims
- verifier-proven claims
- unproven claims
- planned scope
- actual changed surface
- patch budget respected versus exceeded
- human review evidence when required
- accepted debt and cleanup triggers
- residual risk

Do not let summaries blur those categories.

## Definition Of Done

Definition of Done is a named gate over existing evidence. It is not a terminal
status and it must not bypass the Evidence Pack.

A run is done only when:

- the Work Order validated and was ready before execution
- the Evidence Pack validates on write and load
- scope, forbidden paths, and protected paths were respected
- changed-surface evidence was captured or the gap is explicit
- required commands ran successfully, or skipped/failed commands are explained
- required acceptance claims are proven or manually inspected, or their limits
  are explicit
- reviewability was computed from typed evidence
- required counterexample review was performed or explicitly missing
- required human review was recorded
- observability and rollback/recovery expectations were reviewed for the risk
- residual risk is recorded
- accepted debt has a cleanup trigger
- the stop reason explains why the run ended

`success` does not imply done. A successful run can still fail Definition of
Done when evidence is missing, reviewability is downgraded, human review is
required but absent, recovery is unreviewed, or debt is accepted without a
cleanup trigger.

## State Machine

Use a closed state machine.

Recommended run states:

- `created`
- `validated`
- `preflight_warning`
- `running`
- `success`
- `blocked`
- `failed`
- `repair_required`

Terminal states:

- `success`
- `blocked`
- `failed`
- `repair_required`

Resume policy:

- only `running` or explicitly resumable interrupted states may resume
- terminal states do not resume
- terminal continuation requires a new Work Order

## Reviewability

`success` and `reviewable` are different.

A run can structurally finish with `success` but still be `not_reviewable` if:

- validation was not captured
- required commands were not run
- changed surface was not observed
- provider/model evidence is missing when required
- required claims are unproven
- patch budget was exceeded
- actual autonomy exceeded planned autonomy
- required counterexample review was not performed
- required human review was not recorded
- observability or rollback/recovery evidence is missing for the risk
- accepted debt lacks a cleanup trigger
- reviewer findings are unresolved

The harness should prefer:

```text
status: success
reviewability: not_reviewable
reason: validation_not_captured
```

over pretending the result is merge-grade.

## Context Isolation

Context isolation is a quality tool.

Each role should receive only what it needs:

Explorer:

- Work Order
- explicit context files
- repo inspection access

Implementer:

- Work Order
- selected context
- explorer facts
- relevant files

Reviewer:

- Work Order
- diff
- selected context
- implementer evidence
- acceptance criteria

Verifier:

- Work Order
- final diff
- verification commands
- implementer/reviewer claims

Avoid dumping every prior message into every role.

The harness should record why context was included:

```json
{
  "kind": "explicit_file|explorer_finding|diff|review_finding|prior_result",
  "reference": "SPEC.md",
  "reason": "User listed this as source spec."
}
```

## Confirmation Bias Controls

Use role isolation to reduce confirmation bias.

Recommended controls:

- reviewer sees the diff before implementer self-praise
- verifier treats claims as hypotheses
- reviewer prompt asks for counterexamples
- repair Work Order includes concrete findings, not broad criticism
- final summary separates implementer summary from verifier evidence

Do not make every role read the same persuasive narrative.

## Model Usage

The harness should be model-agnostic but model-aware.

Record:

- provider
- model
- reasoning/thinking setting if available
- role
- selection reason
- fallback reason

GPT-5.5-class models can handle larger, more nuanced tasks, but the harness
should still keep tasks bounded. Stronger models reduce the need for extra
ceremony; they do not remove the need for evidence.

Suggested defaults:

- explorer: strong model, high reasoning for ambiguous codebase discovery
- implementer: strong coding model, medium/high reasoning based on risk
- reviewer: strongest available reasoning
- verifier: deterministic tools first, model only to interpret evidence

Autonomy defaults:

- `assist`: no write-capable execution
- `scoped_edit`: one selected file or area
- `bounded_patch`: default for implementation Work Orders
- `supervised_agent`: requires review checkpoints
- `autonomous_run`: only for low-risk, strongly scoped, well-tested work

The actual autonomy level used must be recorded. Model strength never widens
scope or lowers the evidence bar.

## Tool And Command Policy

Commands are action classes.

At minimum classify:

- read repository
- write allowed files
- execute local command
- install dependency
- mutate git state
- access network
- access secret
- irreversible side effect

The first rebuild can support a small subset, but it must not pretend to support
more than it can detect.

Command rules:

- verification commands should be explicit or derivable
- dependency installs require approval
- git mutation requires approval
- network access requires approval
- destructive commands require approval
- commands run by workers must be recorded

## Persistence

Persist enough to review and resume truthfully.

Suggested persisted records:

- Work Order
- normalized Work Order fingerprint
- approvals
- run journal
- worker packets
- worker outputs
- changed-surface observations
- command observations
- review findings
- verifier results
- final Evidence Pack

Persistence should be append-friendly where possible.

Never trust persisted artifacts without schema validation on load.

## Patch Handling

The harness should treat patches as controlled outputs.

Preferred process-backend model:

1. Copy allowed/context files into isolated workspace.
2. Worker modifies workspace.
3. Harness observes changed files.
4. Harness rejects out-of-scope changes.
5. Harness applies allowed changes transactionally.
6. Harness records changed surface.

Do not let worker output directly authoritatively claim changed files without
parent-side observation.

## What To Do When Input Is Bad

The harness should block with a useful explanation.

Examples:

- Work Order lacks acceptance criteria.
- Work Order scope is empty.
- Allowed path is protected.
- Verification is required but no command exists and derivation is disabled.
- Spec asks for whole-app build with no slice.
- Requested action needs approval.

Blocked output should include:

- why it blocked
- what is missing
- whether a human can fix it
- the smallest next action

## Work Order Producers

Future systems can produce Work Orders:

- `/build`
- template fragment compiler
- issue importer
- PR review fixer
- design-spec slicer
- Codex planning chat exporter

Work Order producers must not bypass kernel validation.

If a producer emits bad scope, bad commands, or vague acceptance criteria, the
kernel blocks.

## Template Systems Are Adapters

Project templates are not core execution.

A template system can help turn a spec into Work Orders, but normal harness
execution should not depend on live template invention.

Correct template behavior:

- detect project facts
- compose trusted fragments
- produce one or more Work Orders
- block if template coverage is missing

Incorrect template behavior:

- silently collapse unknown apps into generic web layout
- invent untrusted fragments during execution
- emit commands unrelated to the project platform
- make `/build` the policy authority

## Minimal Viable Rebuild

The smallest useful rebuild should support:

1. Load a Work Order from JSON or command input.
2. Validate Definition of Ready, change class, patch budget, autonomy, scope,
   protected paths, risk, and approval.
3. Run explorer read-only.
4. Run implementer with allowlist writes.
5. Observe changed files.
6. Run reviewer read-only, including counterexample review when required.
7. Run one repair loop if needed.
8. Run verifier and record the fast verification loop.
9. Persist Evidence Pack with run configuration and scorecard data when
   model-backed workers ran.
10. Record human review, observability, rollback/recovery, residual risk, and
    accepted debt evidence when required.

Everything else can wait.

## Suggested File Boundaries

Possible module layout:

```text
src/kernel/work-order.js
src/kernel/scope.js
src/kernel/policy.js
src/kernel/approval.js
src/kernel/state-machine.js
src/kernel/evidence.js
src/kernel/run-store.js

src/runners/runner-interface.js
src/runners/process-runner.js
src/runners/pi-runner.js

src/roles/explorer.js
src/roles/implementer.js
src/roles/reviewer.js
src/roles/verifier.js

src/execution/work-order-runner.js
src/execution/repair-loop.js
src/execution/evidence-pack.js

src/adapters/pi-extension.js
src/adapters/cli.js

src/planning/templates/
src/planning/work-order-producers/
```

The exact paths can change. The boundary should not.

## Acceptance Tests For The Rebuild

Required early tests:

- rejects empty allowed scope
- rejects path traversal
- rejects protected paths
- blocks Work Orders that are not ready
- blocks missing change class, patch budget, or autonomy level
- blocks missing acceptance criteria
- blocks missing approval for high-risk work
- records model/tool route and provider/model evidence when model-backed workers run
- read-only worker write is detected
- implementer out-of-scope write is rejected
- implementer no-op success without evidence is not reviewable
- patch budget overrun is surfaced as blocked, repair-required, or not-reviewable
- actual autonomy exceeding planned autonomy is not reviewable
- reviewer blocking finding triggers repair
- required counterexample review is recorded or reviewability is downgraded
- required human review is recorded or reviewability is downgraded
- missing rollback/recovery or observability evidence affects reviewability for
  medium-risk and high-risk work
- repair cannot widen scope
- verifier records commands run
- fast verification loop records inspect/test/repair iterations
- failed verification yields not-reviewable result
- terminal run cannot resume
- final Evidence Pack separates proven, manually inspected, inferred, unproven,
  skipped, and failed claims
- accepted debt requires a cleanup trigger

## Quality Metrics

Judge the harness by:

- review burden per accepted patch
- number of scope violations blocked
- number of unproven claims surfaced
- repair success rate
- escaped defect rate after accepted runs
- percentage of runs with complete changed-surface evidence
- percentage of runs with required verification captured
- operator/human time to understand final state

Do not judge primarily by:

- number of agents
- number of lifecycle stages
- amount of generated code
- how autonomous the system sounds
- how polished the final prose is

## Migration From Current Repo

Preserve lessons, not necessarily files.

Likely worth preserving conceptually:

- task packet validation
- worker result validation
- path safety
- allowlist/forbidden scope checks
- process backend workspace/apply model
- changed-surface observation
- provider/model evidence
- run journal state machine
- reviewability distinction
- role skill output contracts

Likely should become optional adapters:

- `/build`
- brainstorm/blueprint/slice/audit
- project lifecycle contracts
- operator formatting
- project template system
- non-technical operator shell

Likely should be rewritten simpler:

- Pi extension command surface
- project workflow planning
- broad evidence vocabulary
- policy profile expansion

## Decision Rules

When adding anything to the rebuilt harness, ask:

1. Does this improve patch correctness, reviewability, or evidence?
2. Does this enforce a boundary in code?
3. Can this fail closed?
4. Can this be tested deterministically?
5. Does this belong in the kernel, or is it a Work Order producer?
6. Would a human reviewer trust the final Evidence Pack more because of this?

If not, leave it out.

## Final North Star

The harness is successful when a human can hand it a precise Work Order and get
back a patch that is:

- scoped
- correct enough to review seriously
- independently critiqued
- repaired when needed
- verified where possible
- honest about uncertainty
- backed by persisted evidence

The harness should make the model produce better software than it would in a
single unstructured pass.

That is the product.
