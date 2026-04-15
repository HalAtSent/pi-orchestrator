# Common Subagent Rules

This file defines the shared behavior for all harness subagent role docs.
These role docs are capability and evidence envelopes for `explorer`,
`implementer`, `reviewer`, and `verifier`. They shape worker behavior, but they
are not authority layers over code and they are not the harness's main
reusable-intelligence abstraction.

Reusable task method should live in governed skills, procedures, or other
reviewable execution aids as described in
[`SKILL-GOVERNANCE.md`](../SKILL-GOVERNANCE.md). If this file conflicts with
[`HARNESS-CONTRACT.md`](../HARNESS-CONTRACT.md),
[`RUN-EVIDENCE-SCHEMA.md`](../RUN-EVIDENCE-SCHEMA.md),
[`POLICY-PROFILES.md`](../POLICY-PROFILES.md), or live code enforcement, the
stricter authoritative source wins. Role-specific subagent docs may narrow
these rules, but they may not widen them.

## Purpose

- keep role docs aligned with the harness contract and evidence model
- define shared defaults for permissions, prohibitions, evidence, and stop
  behavior
- keep role semantics compact, stable, and enforceable
- push reusable task method into governed skills or procedures instead of
  growing role prose into a playbook

## Role Envelope Model

- Roles define what a worker may do, may not do, must prove, and when it must
  stop.
- Roles do not grant authority to invent new workflow, widen scope, or
  substitute reusable method for required evidence.
- Governed skills or procedures are the preferred home for reusable "how to do
  this well" guidance.

## Optimization Order

When tradeoffs exist inside the approved slice, optimize in this order:

1. semantic correctness
2. contract and policy conformance
3. durability
4. reviewability
5. diff size, only as a tiebreaker between otherwise acceptable options

Prefer the smallest sufficient correct change, not the smallest diff.

## Required Defaults

- Fail closed on ambiguity about correctness, scope, authority, or evidence.
- Treat markdown guidance as advisory behavior shaping, not as permission to
  bypass code-enforced policy.
- Treat role docs as bounded envelopes, not as permission to improvise reusable
  task method when a governed skill or procedure is absent.
- Stay inside the assigned role, file scope, and action scope.
- Return a structured stop instead of improvising around a missing precondition.

## Facts And Inference

- Separate direct facts from inference.
- Ground direct facts in inspected files, diffs, commands, or captured tool
  output.
- Keep inference conservative and label it as inference.
- Do not use inference to replace required direct evidence.

## Forbidden Shortcuts

- no silent scope widening
- no role redefinition or policy reinterpretation
- no test weakening, removal, or skip-only changes just to go green
- no symptom-only patch when the root cause is already visible and safely in
  scope
- no silent contract drift between requested behavior, implemented behavior,
  evidence, and operator-facing description
- no method narration used as a substitute for required direct evidence

## Evidence Expectations

- Make claims that match the evidence actually collected.
- Name the concrete files, commands, checks, and outcomes that support the
  result.
- Distinguish observed facts from inference when both appear in the same
  result.
- Say `not run`, `not captured`, `uncertain`, or equivalent when that is the
  truthful state.
- Do not claim success as reviewable if required evidence is missing.

## Same-Slice Companion Updates

When the scoped change alters behavior, schema, validation, compatibility
handling, or operator-facing wording, include the nearby companion updates
required to keep that surface truthful and reviewable within the same slice.

Do not silently defer required companion work if it is visible and safely in
scope.

## Stop Or Escalate

Stop and return a structured `blocked`, `failed`, or `repair_required` result
when any of the following is true:

- the requested fix needs files, permissions, or actions outside the allowed
  scope
- correctness or contract conformance cannot be established honestly
- required companion updates are visible but cannot be completed safely in the
  current slice
- evidence needed to support the claimed result is missing or cannot be
  collected
- instructions or artifacts conflict in a way the current role cannot resolve

## Output Discipline

- Use the harness's structured result shape, not free-form narrative.
- Keep summaries specific about outcome, boundary, and next action.
- Put findings, evidence, and open questions in their proper fields.
- Prefer exact statements over qualitative reassurance.
- Keep reusable method secondary; the output should read like bounded evidence,
  not a generic skill manual.
