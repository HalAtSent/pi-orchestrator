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
- workflow planning helpers
- a pure auto-workflow executor with one repair loop by default
- a local worker runner abstraction for bounded task dispatch
- a thin Pi extension entrypoint
- role skills for explorer, implementer, reviewer, and verifier workers

It does not yet include live subagent spawning or model routing. That work
should build on the contracts in `src/`.

## Layout

- `src/contracts.js`: task packet and worker result validation
- `src/project-contracts.js`: project-lifecycle artifact validation
- `src/project-workflows.js`: brainstorm, blueprint, slice, bootstrap, and audit helpers
- `src/policies.js`: risk classification and human gate rules
- `src/orchestrator.js`: initial workflow and packet planning
- `src/auto-workflow.js`: sequential workflow execution and repair-loop control
- `src/worker-runner.js`: local worker dispatch abstractions
- `src/pi-extension.js`: Pi extension entrypoint and orchestration tools
- `docs/OPERATING-GUIDE.md`: how to run and evolve the workflow
- `skills/`: worker role instructions
- `test/`: deterministic unit tests and regression fixtures

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
- `run_auto_workflow`: plan and execute a workflow with a configured local runner
- `validate_worker_result`: validate structured worker output
- `/brainstorm`: command entrypoint for structured alternatives
- `/blueprint`: command entrypoint for a frozen project blueprint
- `/slice`: command entrypoint for milestone execution contracts
- `/bootstrap`: command entrypoint for the first bootstrap contract
- `/audit`: command entrypoint for lifecycle audit
- `/auto`: command entrypoint for bounded workflow execution
- `/workflow-status`: confirm the package loaded inside Pi

## Move-Out Plan

Once the structure feels right:

1. Move `.scratch/pi-orchestrator` into its own repository.
2. Install Pi.
3. Point Pi at the package or publish it as a Pi package.
4. Replace the local runner with live worker execution and keep growing regression fixtures from real tasks.
