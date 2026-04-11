# Pi Orchestrator Package

Temporary bootstrap package for a personal Pi workflow that favors:

- a strong orchestrator over cheap worker models
- narrow worker scopes with explicit file ownership
- independent review and verification
- automation with bounded blast radius

## Current Scope

This scaffold is intentionally small. It includes:

- core task and result contracts
- project-lifecycle contracts for brainstorming, blueprinting, slicing, bootstrapping, and audit
- policy heuristics for risk and human gates
- workflow planning and execution-program helpers
- a pure auto-workflow executor with one repair loop by default
- a Pi-backed worker adapter and runner boundary with local/scripted runners for tests
- a role-aware process worker backend for bounded out-of-process execution (`explorer`, `implementer`, `reviewer`, `verifier`)
- an opt-in `/auto` backend selector with `pi_runtime` (default), `low_risk_process_implementer`, and `process_subagents` modes
- a thin Pi extension entrypoint with program-run and resume surfaces
- local persisted run journals for execution programs
- role skills for explorer, implementer, reviewer, and verifier workers

It does not yet include guaranteed worker invocation in every Pi host, fully proven
live medium/high-risk runs, or richer runtime diagnostics. That work should build on
the contracts in `src/`.

## Layout

- `src/contracts.js`: task packet and worker result validation
- `src/project-contracts.js`: project-lifecycle artifact validation
- `src/project-workflows.js`: brainstorm, blueprint, slice, bootstrap, and audit helpers
- `src/policies.js`: risk classification and human gate rules
- `src/orchestrator.js`: initial workflow and packet planning
- `src/auto-workflow.js`: sequential workflow execution and repair-loop control
- `src/worker-runner.js`: local/scripted worker dispatch abstractions for tests
- `src/pi-worker-runner.js`: Pi-backed bounded worker runner with file claims
- `src/pi-adapter.js`: live Pi worker adapter boundary
- `src/process-worker-backend.js`: role-aware process backend with temp-workspace isolation and read-only/write enforcement
- `src/auto-backend-runner.js`: `/auto` backend selector for `pi_runtime`, `low_risk_process_implementer`, and `process_subagents`
- `src/spike-worker-backend.js`: compatibility exports for existing spike imports
- `src/program-runner.js`: sequential execution-program runner with stop states
- `src/run-store.js`: local JSON-backed persisted run journals
- `src/pi-extension.js`: Pi extension entrypoint and orchestration tools
- `examples/spike-worker-smoke.js`: local smoke helper that runs the process backend once
- `docs/OPERATING-GUIDE.md`: how to run and evolve the workflow
- `skills/`: worker role instructions
- `test/`: deterministic unit tests and regression fixtures

## `/auto` Backend Modes (Current)

- Default path is `pi_runtime`, which keeps `/auto` on the configured Pi worker runner; process backend routing only happens when explicitly configured.
- `low_risk_process_implementer` requires `processWorkerBackend` and routes only low-risk `implementer` and `verifier` packets to the process backend.
- `process_subagents` requires `processWorkerBackend` and routes `explorer`, `implementer`, `reviewer`, and `verifier` packets to the process backend.
- Process backend safety boundaries are role-specific: `explorer`, `reviewer`, and `verifier` are read-only and fail if files change; `implementer` writes are limited to packet allowlists and fail on forbidden/out-of-scope edits.
- Process-backed Pi launches inherit Pi defaults for provider/model unless the launcher `argsBuilder` explicitly includes `--provider` and/or `--model`; worker evidence records whether those flags were implicit or explicit.

## Operating Guide

See [`docs/OPERATING-GUIDE.md`](./docs/OPERATING-GUIDE.md) for the intended stage flow, runtime expectations, and current limitations.

## Intended Pi Commands

The first extension cut exposes:

- `brainstorm_project`: generate structured alternatives and milestone tracks
- `blueprint_project`: freeze a project blueprint from a brief
- `slice_project`: compile a brief into milestone execution contracts
- `bootstrap_project`: produce the first bootstrap contract
- `audit_project`: audit the lifecycle scaffolding before execution
- `plan_workflow`: build a bounded execution plan from a coding request
- `run_auto_workflow`: plan and execute a workflow with the configured worker runner
- `run_execution_program`: execute a compiled execution program contract-by-contract
- `resume_execution_program`: resume a persisted execution program run from local snapshots
- `inspect_worker_runtime`: inspect whether the live Pi host exposes worker execution
- `validate_worker_result`: validate structured worker output
- `/brainstorm`: command entrypoint for structured alternatives
- `/blueprint`: command entrypoint for a frozen project blueprint
- `/slice`: command entrypoint for milestone execution contracts
- `/bootstrap`: command entrypoint for the first bootstrap contract
- `/audit`: command entrypoint for lifecycle audit
- `/auto`: command entrypoint for bounded workflow execution
- `/run-program`: command entrypoint for execution-program runs
- `/resume-program`: command entrypoint to continue a persisted run
- `/worker-runtime-status`: inspect live Pi worker-runtime support
- `/workflow-status`: confirm the package loaded inside Pi

## Move-Out Plan

Once the structure feels right:

1. Move `.scratch/pi-orchestrator` into its own repository.
2. Install Pi.
3. Point Pi at the package or publish it as a Pi package.
4. Prove live worker execution in your Pi host and keep growing regression fixtures from real tasks.
