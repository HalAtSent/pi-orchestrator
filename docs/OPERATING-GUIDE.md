# Operating Guide

This repository is building a personal Pi package for autonomous coding workflows.

The design intent is:

- keep orchestration and policy in code
- use skills only for leaf worker behavior
- isolate worker context aggressively
- trade model cost against task complexity
- stop cleanly when policy, scope, or evidence breaks down

## Current Model

The package is split into a control plane and a worker plane.

- `orchestrator`
  - strongest reasoning model
  - owns decomposition, packet creation, integration, and guardrails
- `implementer`
  - cheaper coding model
  - writes only inside the packet allowlist
- `reviewer`
  - independent read-only review
  - can require one repair loop by default
- `verifier`
  - read-only evidence collection
  - reports exact commands and outcomes

The hard rules are:

- one writer per file
- no recursive delegation
- workers are task-scoped and ephemeral
- file allowlists per worker
- one repair loop max by default
- human gate for high-risk work unless preapproved by policy

## Workflow Stages

The package currently exposes six top-level workflow stages.

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

Output:

- `AuditReport`
- status
- findings
- recommended next contracts
- evidence

### `auto`

Use when the task is already bounded enough to execute.

Current state:

- plans a bounded workflow
- runs it through the configured worker runner
- defaults to `pi_runtime`; process backend routing is only used when `processWorkerBackend` and `autoBackendMode` are explicitly configured
- supports `low_risk_process_implementer`, which routes low-risk `implementer` and `verifier` packets to the process backend
- supports `process_subagents`, which routes `explorer`, `implementer`, `reviewer`, and `verifier` packets to the process backend
- enforces read-only roles and repair-loop budget
- in process backend mode, `explorer`, `reviewer`, and `verifier` are read-only; `implementer` can write only inside packet allowlists and still respects forbidden paths
- uses the Pi-backed runner by default when the host exposes worker execution
- cleanly blocks if the live Pi runtime surface is missing or unsafe

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

1. Start with `brainstorm`
2. Freeze with `blueprint`
3. Produce milestone contracts with `slice`
4. Use `bootstrap` for the first setup contract
5. Execute contracts in sequence with `run-program`
6. Resume interrupted runs with `resume-program`

## Pi Commands

Available commands inside Pi:

- `/workflow-status`
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

Working now:

- Pi extension loads locally
- lifecycle planning commands return structured artifacts
- `audit` validates artifact consistency
- `auto` runs through the Pi-backed runner when the host exposes worker execution
- `run-program` executes an `ExecutionProgram` sequentially
- persisted run journals are written locally and can be resumed
- blocked execution is surfaced cleanly when the runtime surface is missing or unsafe

Not implemented yet:

- guaranteed live worker invocation in every Pi host
- broader live diagnostics for runtime capability mismatches
- proven end-to-end live medium/high-risk runs in Pi
- end-to-end autonomous project delivery

## Evidence Expectations

This package should prefer evidence over narrative.

That means:

- tests or commands should be named explicitly
- review findings should be concrete
- blocked states should explain why work stopped
- lifecycle artifacts should preserve the original brief constraints
- audit should fail when sequencing or ownership assumptions are unsound

## Current Development Priorities

The next highest-value work is:

1. harden live Pi runtime diagnostics and capability detection
2. prove live low-risk, then medium/high-risk runs in Pi
3. expand on-disk evidence and operator controls
4. add stronger execution-profile controls for budgets and approvals

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
