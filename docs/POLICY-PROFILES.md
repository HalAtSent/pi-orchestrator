# Policy Profiles

This document defines the normative policy-profile surface for the harness.

It is the source of truth for valid `policyProfile` identifiers, default profile resolution, stricter-only overrides, and fail-closed handling for invalid or denied profile-dependent behavior.

Future profile models and profile-driven hardening that are not yet enforced belong in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md), not in this file's live profile surface.

## Scope

This file defines:

- valid policy profile ids
- default profile resolution
- precedence relative to principles, contract, and evidence requirements
- the stricter-only override rule
- current invalid-profile and denied-action handling
- invalid-profile conditions and fail-closed handling

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

- current code resolves and persists only the `default` profile
- current code fail-closes on invalid or unresolved profile ids
- additional profile models, including a possible operator-safe mode, are tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md) until they are actually selectable and enforced

## Defined Profiles

### `default`

- Intended operator class: general repository use with the contract and evidence floors exactly as written.
- Allowed action classes: whatever the contract and live implementation currently permit, including detector-backed command-signal classes such as `install_dependency` and `mutate_git_state` when those signals are present.
- Approval floor: unchanged from the contract.
- Extra evidence requirements: none beyond the contract and evidence schema.

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
- persisted evidence must carry one resolved `policyProfile`, currently `default`
- build-session approval bindings must carry that resolved `policyProfile`
- this repository may still normalize `stopReasonCode = policy_denied` from denial wording in stop reasons, but that is conservative evidence inference, not proof of a detector-backed profile overlay for every action class

Richer profile overlays and operator-safe profile work are tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

## Invalid Profile Conditions

A policy profile is invalid if:

- its id is unknown, empty, or malformed
- more than one active profile is resolved for a single execution
- it attempts to relax any contract or evidence requirement
- it makes permissions or evidence depend on prompt text, free-form worker claims, or other non-authoritative inputs

## Invalid Profile Handling

- An explicit invalid profile request must block before execution begins.
- The harness must not silently fall back from an explicit invalid profile request to another profile.
- Invalid operator or request input must surface as `stopReasonCode = invalid_input`.
- Invalid persisted artifacts or stored plan fingerprints carrying an invalid or missing resolved `policyProfile` must surface as `stopReasonCode = invalid_artifact`.
