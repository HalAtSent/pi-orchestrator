# Operating Guide

This repository is a personal Pi package for autonomous coding workflows, and the current local runtime path uses a process-backed worker path when native Pi worker execution is unavailable or unreliable.

For the design doctrine behind those choices, see [`HARNESS-PRINCIPLES.md`](./HARNESS-PRINCIPLES.md).
For normative behavior, active-profile rules, and evidence requirements, see [`HARNESS-CONTRACT.md`](./HARNESS-CONTRACT.md), [`POLICY-PROFILES.md`](./POLICY-PROFILES.md), and [`RUN-EVIDENCE-SCHEMA.md`](./RUN-EVIDENCE-SCHEMA.md).

This guide explains how to operate the current harness. It does not override the contract, evidence schema, or active policy profile.

Where this guide says "current" or "live," it refers to implemented behavior that is locally exercised in this repository.

Future-facing hardening and zero-coding operator-mode targets live in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

The design intent is:

- keep deterministic policy and persisted truth surfaces in code and normative docs
- treat roles as permission and evidence envelopes
- use governed skills for reusable procedure
- improve context construction, tool and result contracts, and evidence quality before adding orchestration complexity
- isolate worker context aggressively
- treat context-selection provenance as a typed execution-boundary surface (`contextManifest[]`) instead of ad hoc carry-forward only
- trade model cost against task complexity
- stop cleanly when policy, scope, or evidence breaks down

If no policy profile is selected for an execution, the active profile is `default`. Explicit invalid profile requests fail closed.

Current code resolves `default` only. Stricter profile work, including any future operator-safe mode, is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

Current policy-surface note:

- the live enforcement surface is narrower than the full action-class vocabulary used in the contract and evidence docs
- current runtime gating is primarily high-risk approval, allowlist and forbidden-path checks, protected-path rejection in declared scope, and pre-execution approval-scope checks against the current stored plan
- persisted `actionClasses` should be read as plan-derived scope or conservative evidence, depending on the field, not as a complete detector-backed policy trace
- current post-run command/tool evidence is first-class typed `run_journal.contractRuns[].commandObservations[]` for the detector-backed command subset (`execute_local_command`, `install_dependency`, `mutate_git_state`), with legacy command-string fallback only when that typed field is absent

The harness is meant to get safer and more useful through better context assembly, tool and result boundaries, evidence quality, and fail-closed enforcement, not through multiplying lifecycle or routing complexity.

## Current Model

The package is split into a control plane and a worker plane.

Roles here are capability boundaries with permission and evidence duties. Reusable task method belongs in governed skills rather than in broader role semantics.

- `orchestrator`
  - strongest reasoning model
  - owns decomposition, packet creation, integration, and guardrails
- `implementer`
  - cheaper coding model
  - writes only inside the packet allowlist
- `reviewer`
  - independent read-only review
  - can request repair; the orchestrator spends at most one in-run repair loop by default
- `verifier`
  - read-only evidence collection
  - reports exact commands and outcomes

The contract currently requires:

- one write-capable worker per file within a single execution step
- no recursive delegation
- workers are task-scoped and ephemeral
- file allowlists per worker
- one in-run repair loop max by default
- human gate for high-risk work unless the active policy profile denies the action entirely

## Workflow Stages

The package currently exposes six core lifecycle stages plus one operator shell stage.

These stages are bounded interfaces, not a claim that more staging is itself the safety mechanism.

### `build`

Use when a non-technical operator wants to start from plain-English intent.

`/build` currently runs under the live `default` profile. Future operator-safe profile hardening for this surface is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

Output:

- persisted build session id (`buildId`)
- persisted plan fingerprint for the current stored execution program
- persisted approval scope for that stored plan
- plain-English intake summary
- plain-English staged plan
- explicit approval checkpoint for the current stored plan before execution
- plain-English status lookup by `buildId`
- routing into the existing lifecycle and execution runner when that stored plan is approved

Approval meaning:

- `/build-approve <buildId>` approves only the current saved execution program for that build session.
- The binding is the stored `programId` plus the stored `planFingerprint` for that build session.
- It is not blanket approval for the idea, repository, or future replans.
- The approval covers only the action classes recorded in that build session's approval scope for the stored plan fingerprint.
- In current code that approval scope is derived from detector-backed stored-plan signals (planned workflow command surfaces plus explicit verification-command signals) and is narrower than the broader schema vocabulary.
- Before execution starts, the harness re-checks the current stored `programId`, `planFingerprint`, and current pre-execution derived action-class set against that recorded approval scope.

#### Operator-Readable Evidence Summary

Operator-facing run summaries should stay readable without hiding uncertainty. The live minimums are defined in [`RUN-EVIDENCE-SCHEMA.md`](./RUN-EVIDENCE-SCHEMA.md).

Current formatter coverage now includes dedicated summary lines for changed surfaces, proof collected, unproven claims, reviewability, approval needed, and recovery / undo notes.

In practice, the current summary should make clear:

- what was looked at
- what changed
- what commands or checks were run
- what passed, failed, or was not captured
- what remains uncertain
- whether the current result is reviewable as complete or instead needs technical follow-up

This guide does not add new evidence-schema fields. The authoritative operator-readable evidence model now lives in [`RUN-EVIDENCE-SCHEMA.md`](./RUN-EVIDENCE-SCHEMA.md).

In current v1, operator summaries should use persisted `run_journal.contractRuns[].changedSurface` evidence when available, explicitly mark partial capture when only some runs have observed paths, and fall back to planned scope with a caveat when capture is unavailable.

### `brainstorm`

Use when the goal is still ambiguous or multiple approaches are viable.

Output:

- `ProposalSet`
- alternatives
- milestone track
- recommended path
- open decisions

### `blueprint`

Use when you want to freeze one path into a concrete project plan.

Output:

- `ProjectBlueprint`
- repository layout
- module boundaries
- execution profile
- quality gates

### `slice`

Use when you want a sequence of executable milestone contracts.

Output:

- `ExecutionProgram`
- ordered contracts
- dependency edges
- integration points
- completion checks

### `bootstrap`

Use when you want the first concrete contract for creating or normalizing the repo skeleton.

Output:

- `BootstrapContract`
- scope paths
- commands
- deliverables
- acceptance checks

### `audit`

Use before autonomous execution or when validating lifecycle artifacts.

Current `audit` surface:

- `AuditReport`
- shape validation for the supplied `ProjectBlueprint` and `ExecutionProgram`
- blueprint/program identity alignment
- presence of a reserved `test/` surface in the blueprint
- bootstrap-first ordering
- duplicate contract-id detection
- missing dependency detection
- dependency-cycle detection
- autonomous-mode versus interactive-gate conflict detection
- missing verification-plan detection
- missing scope-path detection
- structural doctrine evaluation coverage over canonical criteria in
  `ExecutionProgram.evaluationCriteria[]` and `AuditReport.evaluationCoverage[]`
- findings for missing canonical criteria, missing required hook refs, and
  structurally empty hook targets

Coverage here means lifecycle hooks are present and populated. It is not a
runtime score and does not claim outcomes such as lower review effort were
already achieved.

### `auto`

Use when the task is already bounded enough to execute.

Current state:

- plans a bounded workflow
- runs it through the configured worker runner
- defaults to `pi_runtime`; process backend routing is only used when `processWorkerBackend` and `autoBackendMode` are explicitly configured
- the local Pi shim currently pins `process_subagents`, so local development `/auto` runs use the process backend by default
- supports `low_risk_process_implementer`, which routes low-risk `implementer` and `verifier` packets to the process backend
- supports `process_subagents`, which routes `explorer`, `implementer`, `reviewer`, and `verifier` packets to the process backend
- enforces read-only roles and an in-run repair-loop budget
- in process backend mode, `explorer`, `reviewer`, and `verifier` are read-only; `implementer` can write only inside packet allowlists and still respects forbidden paths
- uses the Pi-backed runner by default when the host exposes worker execution
- cleanly blocks if the live Pi runtime surface is missing or unsafe
- surfaces selected provider/model information in the workflow summary when process-backed execution runs
- persists typed command observations from process-backed launcher commands
- emits typed worker context-selection manifests (`contextManifest[]`) that explain why context entered worker scope (explicit context files, prior runs, repair review, trusted changed-surface carry-forward)

Current context-selection note:

- `contextManifest[]` is structural provenance instrumentation, not a retrieval engine
- entries carry stable references and typed reasons; they do not embed full file contents or prior-result payloads
- stale/conflict scoring, broader retrieval quality heuristics, and repository-wide redaction hardening are tracked separately in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md)

Current action-class honesty:

- high-risk approval is driven by workflow risk and `humanGate`, not by a full live per-class detector matrix
- current plan-derived approval scope tracks the classes the stored plan can derive today, including command-signal detection for `install_dependency` and `mutate_git_state`
- current post-run `actionClasses` evidence is conservative; it now prefers typed command observations for `execute_local_command`, `install_dependency`, and `mutate_git_state`, and may still omit target-policy classes that are listed in the schema vocabulary but are not detector-backed

## Current Runtime Status

Current repo-local runtime evidence is strongest for the process backend in `src/process-worker-backend.js`.

Implemented and locally exercised today:

- low-risk `/auto`
- high-risk `/auto` with explicit approval
- multi-contract `run-program`
- explorer, implementer, reviewer, and verifier running through the process backend
- approval gating for high-risk work
- persisted resume flow for program runs
- workflow summaries that show provider/model selection

Important limits on that claim:

- scoped regression targets should live under `test/fixtures/`, not in public-facing `docs/` material
- `docs/RUN-EVIDENCE-SCHEMA.md` describes the current persisted reviewability surfaces, but this repo does not currently ship committed `.pi/runs` or `.pi/build-sessions` examples that prove the flows above
- native Pi worker execution is still host-dependent, so cross-host "proven live" wording would outrun the current evidence

Current process-backend provider/model selection:

- provider: `openai-codex`
- explorer: `gpt-5.4`
- implementer: `gpt-5.3-codex`
- reviewer: `gpt-5.4`
- verifier: `gpt-5.4-mini`

## Recommended Operating Loop

For package design or ambiguous project work:

1. Run `brainstorm`
2. Select a path
3. Run `blueprint`
4. Run `slice`
5. Run `audit`
6. Execute one contract or one bounded task with `run-program` or `auto`

For a well-scoped implementation task:

1. Run `audit` only if the task is risky or touches a larger milestone
2. Run `auto`
3. Review the evidence and stop reason

For zero-to-project work:

1. Start with `build` for operator intake and plan review
2. Approve the stored plan with `build-approve <buildId>` when the plan and its current approval scope look correct
3. Inspect status any time with `build-status <buildId>`
4. Resume only in-progress (`running`) journals with `resume-program`; persisted terminal `blocked`, `failed`, and `repair_required` journals do not continue execution. Current implementation returns a new blocked refusal result for those resume attempts, so use a new `build` run to continue work
5. `repair_required` is not a separate repair phase; it is the terminal outcome emitted when review still requires changes after the allowed in-run repair loop is exhausted or unavailable
6. Use `brainstorm`, `blueprint`, `slice`, `bootstrap`, and `audit` directly when deeper control is needed

In plain English, `/build-approve <buildId>` means "record approval for this saved plan identified by its stored `programId` and `planFingerprint` within the recorded approval scope, then try to start it if the pre-execution gate still passes," not "do anything later needed to finish the project." If the stored plan fingerprint changes before execution, or if the current pre-execution derived action-class set contains a newly introduced or stricter class outside the recorded approval scope, the harness should stop and require another approval path rather than silently widening authority. That fail-closed stop can happen after approval is recorded but before execution starts. Mid-run reapproval and richer operator-safe mode hardening are tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Pi Commands

Available commands inside Pi:

- `/workflow-status`
- `/build`
- `/build-approve`
- `/build-status`
- `/brainstorm`
- `/blueprint`
- `/slice`
- `/bootstrap`
- `/audit`
- `/auto`
- `/run-program`
- `/resume-program`
- `/worker-runtime-status`

Matching tool surfaces also exist for programmatic use:

- `brainstorm_project`
- `blueprint_project`
- `slice_project`
- `bootstrap_project`
- `audit_project`
- `plan_workflow`
- `run_auto_workflow`
- `run_execution_program`
- `resume_execution_program`
- `inspect_worker_runtime`
- `validate_worker_result`

## Example Inputs

Project-level example:

- [examples/sample-project-brief.json](/C:/Users/Hal/Desktop/Projects/pi-orchestrator/examples/sample-project-brief.json)

Task-level example:

- [examples/sample-workflow-input.json](/C:/Users/Hal/Desktop/Projects/pi-orchestrator/examples/sample-workflow-input.json)

## What Is Actually Runtime-Ready

Implemented and locally exercised:

- Pi extension loads locally
- lifecycle planning commands return structured artifacts
- `audit` validates the lifecycle artifact shape and the specific consistency checks listed in the `audit` section above
- `auto` runs through the process backend in the local Pi shim and can still use the Pi-backed runner when the host exposes worker execution
- low-risk and high-risk `/auto` behavior is covered by repo-local tests; high-risk execution still requires explicit approval
- `run-program` executes an `ExecutionProgram` sequentially
- multi-contract `run-program` execution and resume behavior are covered by repo-local tests
- explorer, implementer, reviewer, and verifier all execute through the current process backend path
- approval gating works for high-risk execution
- persisted run journals and build sessions are written locally and can be resumed or synchronized
- blocked execution is surfaced cleanly when the runtime surface is missing or unsafe
- workflow summaries expose the selected provider/model during process-backed runs

Target surfaces or still missing durable evidence:

- guaranteed live worker invocation in every Pi host
- broader live diagnostics for runtime capability mismatches
- committed evidence-bearing `.pi/runs` and `.pi/build-sessions` examples that demonstrate the current runtime claims end to end
- end-to-end autonomous project delivery

## Evidence Expectations

This package should prefer evidence over narrative.

That means:

- tests or commands should be named explicitly
- review findings should be concrete
- blocked states should explain why work stopped
- lifecycle artifacts should preserve the original brief constraints
- audit should fail when the checked sequencing assumptions are unsound or when a contract omits scope paths

## Current Development Priorities

The next highest-value work is:

1. harden live Pi runtime diagnostics and capability detection across hosts
2. expand on-disk evidence and operator-readable review surfaces
3. improve context construction and tool/result contract quality
4. grow regression coverage from real day-to-day task runs

## Local Verification

Useful checks in this repo:

```powershell
node --check src\pi-extension.js
node --check src\project-workflows.js
node --check src\project-contracts.js
node --test --test-isolation=none
```

If Pi is already running after local file changes:

1. run `/reload`
2. rerun `/workflow-status`
3. rerun the workflow you changed
