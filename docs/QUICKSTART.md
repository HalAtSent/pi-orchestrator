# Quickstart For Non-Technical Operators

This path is the thin operator shell on top of the existing orchestration kernel.

Use it when you want to start from a plain-English idea and avoid low-level workflow JSON.

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
- an approval checkpoint before implementation starts
- a recommended next command

The primary flow does not require:

- raw `ExecutionProgram` JSON
- manual file allowlists
- raw `approvedHighRisk` flags

## Approval Step

After reviewing the staged plan, approve kickoff with the returned build id:

```text
/build-approve <buildId>
```

This lets operators approve a previously planned build without repeating the full idea text.

This routes into the existing lifecycle and execution runner (`run-program`) while preserving current safety gates and stop conditions.

Check current state any time with:

```text
/build-status <buildId>
```

If execution ends in `blocked`, `failed`, or `repair_required`, start a new `/build` after adjusting the request. Use `/resume-program` only for in-progress (`running`) journals.

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
