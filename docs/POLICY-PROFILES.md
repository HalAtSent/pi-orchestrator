# Policy Profiles

This document defines the normative policy-profile surface for the harness.

It is the source of truth for valid `policyProfile` identifiers, default profile resolution, stricter-only overrides, and fail-closed handling for invalid or denied profile-dependent behavior.

Policy profiles are live enforcement overlays on top of the contract and evidence schema. They do not define reusable procedure, role playbooks, or operator how-to guidance.

Future profile models and profile-driven hardening that are not yet enforced belong in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md), not in this file's live profile surface.

## Scope

This file defines:

- valid policy profile ids
- default profile resolution
- precedence relative to principles, contract, and evidence requirements
- the stricter-only override rule
- current invalid-profile and denied-action handling
- invalid-profile conditions and fail-closed handling

This file is not the authority for governed skills, role guidance, or operator-facing workflow guidance.

## Precedence

The harness uses layered authority rather than a doctrine-first override chain:

1. [HARNESS-PRINCIPLES.md](./HARNESS-PRINCIPLES.md) defines design doctrine and admissible system shape, but it does not override behavioral requirements.
2. [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md) is authoritative for behavioral invariants, approval floors, denial conditions, and state rules.
3. [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md) is authoritative for inspectability, lineage, and terminal-state evidence.
4. The active policy profile may add stricter denials, narrower permissions, extra approvals, or extra evidence and retention requirements, but it may not relax contract or evidence requirements.
5. Code must enforce the resolved active profile together with the contract and evidence schema. Prompt text, model output, operator intent, and explanatory summaries are never authoritative over them.

If rules differ, the stricter applicable contract, evidence, or active-profile rule wins; doctrine and summary docs do not relax those requirements.

## Valid Profile IDs

The current closed set of valid policy profile ids is:

- `default`

`default` is the baseline profile. It applies the full contract and evidence floors as written and grants no extra permissions beyond them.

Current implementation note:

- current code-owned profile registry lives in `src/policy-profiles.js`
- current code resolves and persists only the `default` profile
- unsupported, unknown, or malformed present profile ids fail closed before execution
- additional profile models, including a possible operator-safe mode, are tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md) until they are actually selectable and enforced

## Defined Profiles

### `default`

- Intended use: baseline execution with the contract and evidence floors exactly as written.
- Code-owned compiled profile fields:
  - `id = default`
  - `allowedActionClasses = [execute_local_command, install_dependency, mutate_git_state]`
  - `allowProcessBackend = true`
  - `requireHumanGateBeforeExecution = false`
- Approval floor: unchanged from the contract.
- Extra evidence requirements: none beyond the contract and evidence schema.

These fields are intentionally narrow. They describe only what current code can enforce truthfully in this slice:

- detector-backed command action classes (`execute_local_command`, `install_dependency`, `mutate_git_state`)
- process-backend allowance
- explicit human-gate requirement at pre-execution time

They do not claim complete profile coverage of the broader action-class vocabulary in [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md).

## Resolution And Default Behavior

- Exactly one active policy profile applies to a single execution.
- If no profile is requested, the active profile resolves to `default`.
- An omitted profile selection at input time is not an error because it resolves to `default`.
- Persisted execution-bearing artifacts must record the resolved `policyProfile` id, including when the value was selected by default.
- Build-session approval bindings persist that resolved `policyProfile` alongside the bound `programId`, `planFingerprint`, and approval-scoped action classes.
- A missing, null, or ambiguous resolved `policyProfile` in persisted evidence is non-conformant.

## Tightening Rule

This section describes the allowed policy-profile model for currently enforced profiles.

A policy profile may:

- deny an action class the contract would otherwise allow
- require approval where the contract would otherwise allow execution without extra approval
- add stricter evidence, retention, or redaction requirements

A policy profile may not:

- allow an action class denied by [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md)
- lower an approval floor defined by [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md)
- remove, weaken, or bypass evidence required by [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md)
- redefine contract invariants, state enums, or worker-role semantics

Profiles may tighten requirements, but they may never relax contract or evidence requirements.

## Denied Action Handling

Current implemented behavior:

- invalid, unknown, or ambiguous profile resolution must block before execution begins
- pre-execution policy gates run in code-owned contract execution paths before worker launch
- the live supported profile registry is currently closed to `default` only
- through that live supported profile-id path today:
  - `default` resolves and records an `allowed` `policyDecision` for current detector-backed enforcement inputs
  - unsupported, unknown, or malformed profile ids fail closed before execution with `policyDecision.reason = unknown_profile`
- compiled profile machinery also includes branches for process-backend disallow, detector-backed action-class disallow (`execute_local_command`, `install_dependency`, `mutate_git_state`), and profile-required human gate checks, but those branches are not currently reachable through the live supported profile-id set
- persisted evidence must carry one resolved `policyProfile`, currently `default`
- build-session approval bindings must carry that resolved `policyProfile`
- per-contract run evidence now persists a first-class typed `policyDecision` surface on `run_journal.contractRuns[]`:
  - `status`: `allowed` | `blocked` | `approval_required`
  - `reason`: `profile_allows_execution` | `profile_disallows_process_backend` | `profile_disallows_action_class` | `profile_requires_human_gate` | `unknown_profile`
- this repository may still normalize `stopReasonCode = policy_denied` from denial wording in stop reasons, but that remains conservative evidence inference and not a claim of full profile completeness

Richer profile overlays and operator-safe profile work are tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Invalid Profile Conditions

A policy profile is invalid if:

- its id is unknown, empty, or malformed
- more than one active profile is resolved for a single execution
- it attempts to relax any contract or evidence requirement
- it makes permissions or evidence depend on prompt text, free-form worker claims, or other non-authoritative inputs
- a present compiled profile object omits required fields or contains unsupported fields for the enforced compiled shape

## Invalid Profile Handling

- An explicit invalid profile request must block before execution begins.
- The harness must not silently fall back from an explicit invalid profile request to another profile.
- Invalid operator or request input must surface as `stopReasonCode = invalid_input`.
- Invalid persisted artifacts or stored plan fingerprints carrying an invalid or missing resolved `policyProfile` must surface as `stopReasonCode = invalid_artifact`.
