# Pi Orchestrator Package

Personal Pi-based autonomous coding harness that favors:

- trustworthy, reviewable output under strict boundaries
- a strong code-enforced control plane with a thin orchestrator
- narrow worker scopes with explicit file ownership
- independent review and verification
- automation with bounded blast radius
- evidence-first execution and persisted run journals

This repository is intended to become the main day-to-day harness, not just a scaffold.

## Current Scope

Current implemented scope includes:

- core task and result contracts
- project-lifecycle contracts for brainstorming, blueprinting, slicing, bootstrapping, and audit
- doctrine evaluation criteria instrumentation in `ExecutionProgram.evaluationCriteria[]` plus structural coverage in `AuditReport.evaluationCoverage[]` (coverage is artifact-structure only, not runtime scoring)
- operator-facing `/build` sessions with persisted `buildId` state, plain-English status views, and plan-scoped approval-by-id
- policy heuristics for risk and human gates
- workflow planning and execution-program helpers
- a pure auto-workflow executor with one in-run repair loop by default
- a Pi-backed worker adapter and runner boundary with local/scripted runners for tests
- a role-aware process worker backend for bounded out-of-process execution (`explorer`, `implementer`, `reviewer`, `verifier`)
- an opt-in `/auto` backend selector with `pi_runtime` (default), `low_risk_process_implementer`, and `process_subagents` modes
- a thin Pi extension entrypoint with program-run and resume surfaces
- local persisted run journals for execution programs
- explicit process-model probing and role-specific provider/model selection
- role skills for explorer, implementer, reviewer, and verifier workers

## Live Runtime Status

The strongest repo-local runtime evidence currently centers on the process-backed child-session backend in `src/process-worker-backend.js`, which is the current local Pi shim path.

- Native Pi host `runWorker(...)` is not reliably available across hosts, so local execution is usually routed through backend-selected runner paths instead of treated as a universal Pi-host guarantee.
- Backend selection is wired through `src/auto-backend-runner.js`, `src/pi-extension.js`, and the local Pi shim `.pi/extensions/pi-orchestrator.js`.
- The local shim currently pins `AUTO_BACKEND_MODES.PROCESS_SUBAGENTS`.
- Implemented and exercised in repo-local tests and local runtime development paths:
  - low-risk `/auto`
  - high-risk `/auto` with explicit approval
  - multi-contract `run-program`
  - explorer, implementer, reviewer, and verifier through the process backend
  - approval gating
  - persisted resume flow
  - UI launch summaries that surface selected provider/model information
- Scoped regression targets belong under `test/fixtures/`, not in public-facing `docs/` surfaces.
- Persisted `.pi/runs/*.json` and `.pi/build-sessions/*.json` records are the intended evidence-bearing surfaces described in `docs/RUN-EVIDENCE-SCHEMA.md`, but this repo does not currently ship committed examples of those artifacts.

## Current Process-Backend Provider/Model Selection

- provider: `openai-codex`
- explorer: `gpt-5.5`
- implementer: `gpt-5.5`
- reviewer: `gpt-5.5`
- verifier: `gpt-5.5`

These are selected explicitly in the current process backend path rather than inherited implicitly from Pi defaults. Process role profiles now fail closed when provider, preferred model, or thinking settings are missing unless an explicit fallback-compatibility mode is requested.

The process backend probes model availability before launch and records requested and selected provider/model evidence. When the preferred `gpt-5.5` model is unavailable, the configured fallback path is explicit; when no preferred or fallback model is available, the run blocks instead of silently inheriting a default.

Implementer process runs also require reviewable completion evidence. A launcher exit code of 0 without changed files, a structured result, or explicit validation evidence is reported as blocked/unproven rather than as plain success.

Process execution now has an explicit sandbox policy. `processSandbox: "required"` is the fail-closed path: if a supported OS sandbox provider is unavailable, the worker is blocked before launch. The built-in provider path uses macOS `sandbox-exec` when available; Linux and Windows block unless a real namespace/seccomp/bubblewrap/firejail-style or restricted-token/job-object/AppContainer provider is configured. `processSandbox: "disabled"` is a development/compatibility mode only and must be paired with `unsandboxedProcessBackendOptIn: true`. Unsandboxed process mode is observation-only, not a security boundary; its evidence records `process_backend_os_sandbox: false`, `process_backend_trust_boundary: observation_only`, and `unsandboxed_process_backend_opt_in: true`. Those runs can support trusted repo changed-surface observation for files the launcher actually changed and the parent applied, but they must not be used as proof of no external side effects, no secret reads, no network access, or descendant-process confinement.

## Layout

- `src/contracts.js`: task packet and worker result validation
- `src/project-contracts.js`: project-lifecycle artifact validation
- `src/project-workflows.js`: brainstorm, blueprint, slice, bootstrap, and audit helpers
- `src/operator-intake.js`: plain-English intake normalization for `/build`
- `src/operator-formatters.js`: plain-English summary, staged plan, and approval formatting for `/build`
- `src/build-session-store.js`: local JSON-backed persisted build sessions for the operator shell
- `src/policies.js`: risk classification and human gate rules
- `src/orchestrator.js`: initial workflow and packet planning
- `src/auto-workflow.js`: sequential workflow execution and repair-loop control
- `src/worker-runner.js`: local/scripted worker dispatch abstractions for tests
- `src/pi-worker-runner.js`: Pi-backed bounded worker runner with file claims
- `src/pi-adapter.js`: live Pi worker adapter boundary
- `src/process-worker-backend.js`: role-aware process backend with temp-workspace isolation and read-only/write enforcement
- `src/auto-backend-runner.js`: `/auto` backend selector for `pi_runtime`, `low_risk_process_implementer`, and `process_subagents`
- `src/program-runner.js`: sequential execution-program runner with stop states
- `src/run-store.js`: local JSON-backed persisted run journals
- `src/pi-extension.js`: Pi extension entrypoint and orchestration tools
- `examples/`: sample workflow inputs and reference model notes
- `docs/OPERATING-GUIDE.md`: how to run and evolve the workflow
- `docs/QUICKSTART.md`: non-technical operator quickstart path
- `skills/`: worker role instructions
- `test/`: deterministic unit tests and regression fixtures

## `/auto` Backend Modes (Current)

- Default path is `pi_runtime`, which keeps `/auto` on the configured Pi worker runner; process backend routing only happens when explicitly configured.
- The local shim in `.pi/extensions/pi-orchestrator.js` currently overrides that default and runs `/auto` in `process_subagents` mode.
- `low_risk_process_implementer` requires `processWorkerBackend` and routes only low-risk `implementer` and `verifier` packets to the process backend.
- `process_subagents` requires `processWorkerBackend` and routes `explorer`, `implementer`, `reviewer`, and `verifier` packets to the process backend.
- Process backend safety boundaries are role-specific: `explorer`, `reviewer`, and `verifier` are read-only and fail if files change; `implementer` writes are limited to packet allowlists and fail on forbidden/out-of-scope edits.
- Process-backed Pi launches now probe and select provider/model combinations explicitly per role; worker evidence records the requested and selected provider/model.

## Operating Guide

See [`docs/OPERATING-GUIDE.md`](./docs/OPERATING-GUIDE.md) for the stage flow, runtime expectations, and remaining limits.
For non-technical usage, see [`docs/QUICKSTART.md`](./docs/QUICKSTART.md).
For the repo doctrine and feature bar, see [`docs/HARNESS-PRINCIPLES.md`](./docs/HARNESS-PRINCIPLES.md).
For authoritative behavior, state rules, active-profile tightening, and inspectability requirements, see [`docs/HARNESS-CONTRACT.md`](./docs/HARNESS-CONTRACT.md), [`docs/POLICY-PROFILES.md`](./docs/POLICY-PROFILES.md), and [`docs/RUN-EVIDENCE-SCHEMA.md`](./docs/RUN-EVIDENCE-SCHEMA.md).
For future-facing hardening that is not yet enforced, see [`docs/HARDENING-ROADMAP.md`](./docs/HARDENING-ROADMAP.md).
If a README summary differs from those normative docs, the normative docs win.

## Pi Commands And Tools

Available Pi command and tool surfaces:

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
- `/build`: operator-facing plain-English intake, staged plan, and approval checkpoint for a stored build plan
- `/build-approve`: approve and execute the current stored build plan by `buildId`; approval is limited to that plan revision and its approved action classes
- `/build-status`: inspect plain-English build-session status by `buildId`
- `/blueprint`: command entrypoint for a frozen project blueprint
- `/slice`: command entrypoint for milestone execution contracts
- `/bootstrap`: command entrypoint for the first bootstrap contract
- `/audit`: command entrypoint for lifecycle audit
- `/auto`: command entrypoint for bounded workflow execution
- `/tiny-edit`: command entrypoint for small scoped documentation or file edits with explicit `allowedFiles`, without creating a `/build` lifecycle session
- `/run-program`: command entrypoint for execution-program runs
- `/resume-program`: command entrypoint to continue a persisted run
- `/worker-runtime-status`: inspect live Pi worker-runtime support
- `/workflow-status`: confirm the package loaded inside Pi

## Current Limits

- Native Pi worker execution is still not reliable in every host, so the process backend remains the current local runtime path that matters most.
- Operator controls, evidence surfaces, and runtime diagnostics should continue to harden from real task runs.
- Policy and safety should remain code-enforced rather than prompt-dependent as the harness grows.
