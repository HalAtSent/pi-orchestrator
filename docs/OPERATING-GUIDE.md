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
- runs it against the configured local worker runner
- enforces read-only roles and repair-loop budget
- cleanly blocks if there is no real worker backend

## Recommended Operating Loop

For package design or ambiguous project work:

1. Run `brainstorm`
2. Select a path
3. Run `blueprint`
4. Run `slice`
5. Run `audit`
6. Execute one contract or one bounded task with `auto`

For a well-scoped implementation task:

1. Run `audit` only if the task is risky or touches a larger milestone
2. Run `auto`
3. Review the evidence and stop reason

For zero-to-project work:

1. Start with `brainstorm`
2. Freeze with `blueprint`
3. Produce milestone contracts with `slice`
4. Use `bootstrap` for the first setup contract
5. Execute contracts in sequence once the program runner exists

## Pi Commands

Available commands inside Pi:

- `/workflow-status`
- `/brainstorm`
- `/blueprint`
- `/slice`
- `/bootstrap`
- `/audit`
- `/auto`

Matching tool surfaces also exist for programmatic use:

- `brainstorm_project`
- `blueprint_project`
- `slice_project`
- `bootstrap_project`
- `audit_project`
- `plan_workflow`
- `run_auto_workflow`
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
- `auto` runs against the local/scripted runner abstraction
- blocked execution is surfaced cleanly when no real worker backend exists

Not implemented yet:

- real Pi-backed worker spawning
- execution of a full `ExecutionProgram`
- runtime file claim registry
- persistent run journal and resume
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

1. add a `program-runner` that executes an `ExecutionProgram`
2. compile contracts into bounded worker packets
3. replace the placeholder runner with a real Pi-backed worker runner
4. add persistence for lifecycle artifacts and run journals

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
