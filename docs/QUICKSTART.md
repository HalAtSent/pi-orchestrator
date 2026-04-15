# Quickstart For Non-Technical Operators

This path is the thin operator shell on top of the existing harness kernel.

Use it when you want to start from a plain-English idea and avoid low-level workflow JSON.

This quickstart describes the current operator shell, which still runs under the live `default` profile. Future operator-safe profile hardening is tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md), not treated here as a live runtime toggle.

The goal is plain-English intake, bounded approval, and truthful status and evidence summaries.

## Primary Command

Use `/build` with a single plain-English idea:

```text
/build Build a simple customer feedback dashboard for local clinics.
```

You can add optional plain-English lines:

```text
/build
Build a simple customer feedback dashboard for local clinics.
Audience: clinic managers
Constraints: no paid SaaS dependencies; keep setup under one hour
Success: a manager can review weekly trends and export a report
```

## What You Get

`/build` returns:

- an intake summary of what the system understood
- a staged lifecycle plan
- a stable `buildId` for follow-up commands
- the current stored plan fingerprint and approval scope for that build session
- an approval checkpoint for the saved plan before implementation starts
- a recommended next command

The primary flow does not require:

- raw `ExecutionProgram` JSON
- manual file allowlists
- raw `approvedHighRisk` flags

## What A Non-Technical Operator Can Safely Do

In this operator shell, a zero-coding operator should be able to:

- describe the goal in plain English
- read the proposed plan in plain English
- understand what will change and what will not
- understand what evidence was gathered
- understand why execution stopped
- know whether they may safely approve
- know when technical escalation is required

The operator should not be asked to judge:

- architecture tradeoffs
- security sufficiency
- migration safety
- compatibility risk
- technical evidence sufficiency
- wrong-layer fixes

If the requested work depends on one of those judgments, the correct outcome is escalation or a blocked result, not "please decide anyway."

## How To Read The Plan Before Approval

Before any approval step, the operator-facing summary should answer these plain-English questions:

- what exactly will happen if approved
- what will change
- what will not change
- what ordinary repo-local checks are expected to run
- what could still go wrong
- whether this operator may approve
- whether technical approval is required instead

Read the summary as safe for a non-technical operator only when it stays at that level. You should not need to infer safety from raw action-class names, code diffs, stack traces, or schema details.

## Approval Step

After reviewing the staged plan, approve that saved plan with the returned build id:

```text
/build-approve <buildId>
```

This lets operators approve a previously planned build without repeating the full idea text.

What this approval means:

- it approves only the current saved execution program for that `buildId`
- it binds to the current stored `programId` and `planFingerprint` for that build session
- it does not approve future replans or a vague "whatever comes next"
- it covers only the action classes recorded in the build session approval scope for that stored plan fingerprint
- before execution starts, the harness re-checks the current stored plan fingerprint and current pre-execution derived action-class set against that recorded approval scope

Fresh approval is required if the stored plan fingerprint changes before execution, or if the current pre-execution derived action-class set contains an action class outside the recorded approval scope. This repository does not yet implement mid-run step-level reapproval.

For non-technical operators, approval is intentionally narrower than "approve whatever seems necessary." Do not use operator approval as a substitute for technical judgment on dependency changes, migrations, policy or approval logic, state-machine changes, secret or network access, git mutations, or other technically hazardous work. Future operator-safe escalation rules for those cases are tracked in [HARDENING-ROADMAP.md](./HARDENING-ROADMAP.md).

This routes the saved execution program into the existing lifecycle and execution runner (`run-program`) while preserving current safety gates and stop conditions.

Check current state any time with:

```text
/build-status <buildId>
```

If execution ends in `blocked`, `failed`, or `repair_required`, start a new `/build` after adjusting the request. `repair_required` means the in-run repair budget was exhausted or unavailable. Use `/resume-program` only for in-progress (`running`) journals. If you target a persisted terminal journal, current implementation returns a new blocked refusal result instead of continuing the original run.

## How To Read A Blocked Result

A blocked result should tell you, in plain English:

- what stopped
- why it stopped
- what is missing
- whether you can fix it yourself
- whether technical escalation is required
- the exact next step

Use this reading frame:

- `Status:` `Blocked`
- `Stopped at:` the stage or step that did not continue
- `Why it stopped:` the concrete reason
- `What is missing:` the missing approval, input, or precondition
- `Can you fix this yourself?` `Yes` or `No`
- `Technical escalation required?` `Yes` or `No`
- `Next step:` one exact command or one exact human action

If the blocked result is only technical jargon, it is not safe enough for a non-technical operator. The operator should not need to reverse-engineer what happened.

## What Evidence Summaries Should Tell You

Current formatter coverage now includes dedicated summary lines for changed surfaces, proof collected, unproven claims, reviewability, approval needed, and recovery / undo notes. The current live minimums are defined in [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md).

In practice, the current summary should make clear:

- what the system looked at
- what it changed
- what commands or checks it ran
- what passed, failed, or was not captured
- what remains uncertain
- whether the result is reviewable as complete or still needs technical follow-up

Current implementation detail: `Changed surfaces` now prefers persisted observed paths from `run_journal.contractRuns[].changedSurface`. If capture is partial or not captured, the summary must say so explicitly and may fall back to planned scope.

That summary is for readability. The deeper contract and schema details still live in [HARNESS-CONTRACT.md](./HARNESS-CONTRACT.md), [POLICY-PROFILES.md](./POLICY-PROFILES.md), and [RUN-EVIDENCE-SCHEMA.md](./RUN-EVIDENCE-SCHEMA.md).

## Safe Work Versus Escalation-Only Work

Typical work that is usually appropriate for a non-technical operator includes:

- docs or copy changes
- small bounded wording or rendering changes
- small bounded implementation work whose safety does not depend on technical hazard tradeoffs
- ordinary repo-local inspection and validation for that bounded work

Technical escalation is required for work involving:

- dependency or lockfile changes
- migrations or persisted-data semantic changes
- approval or policy logic changes
- state-machine changes
- secret, network, connector, git, deploy, publish, delete, or other irreversible-side-effect work
- operator-visible safety claims whose failure would misstate what is safe to approve

## Ambiguous Requests In Non-Technical Mode

If your request is too broad or ambiguous, the system should narrow it with guided clarification or stop with a blocked explanation. It should not silently choose a broader, riskier, or more technically invasive interpretation just to keep moving.

## Advanced Commands Still Available

The operator shell does not replace advanced flows.

You can still use:

- `/brainstorm`
- `/blueprint`
- `/slice`
- `/audit`
- `/auto`
- `/run-program`
- `/resume-program`
