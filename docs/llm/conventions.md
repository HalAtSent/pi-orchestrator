---
status: context
owner: engineering
last_verified: 2026-05-08
authority_sources:
  - ../../AGENTS.md
  - ../IMPLEMENTATION-SEQUENCE.md
  - ../WORK-ORDER-SCHEMA.md
verify_with:
  - git diff --check
---

# Conventions

Use this page as working context. If it conflicts with `AGENTS.md` or the
rebuild docs, those sources win.

## Change Discipline

- Keep changes narrowly scoped to the user's request.
- Prefer small, reviewable diffs.
- Do not make opportunistic refactors.
- Do not modify unrelated files.
- Do not add dependencies, package managers, build systems, frameworks, or test
  runners without explicit approval.
- Preserve public CLI output, schema vocabulary, validation result shape, and
  persisted artifact contracts unless the task explicitly changes them.
- Follow existing code patterns before introducing new abstractions.

## Documentation Discipline

Update docs when behavior, public contracts, configuration, or operational
procedures change.

For planning or documentation tasks, do not start implementation unless the user
explicitly asks for code changes.

## Work Order Narrowness

Harness implementation Work Orders default to micro narrowness:

- one invariant
- one primary implementation file
- one primary test file
- no docs unless a doc contradiction must be corrected

Split or stop when one Work Order mixes:

- CLI and validator logic
- Work Order and Evidence Pack logic
- schema fields and policy interactions
- fixtures and new validator behavior
- fingerprinting and validation behavior
- path normalization and protected-path policy

Also stop on more than three acceptance criteria or more than two repair or
audit passes.

## Micro Work Order Review Defaults

Classification: `documented-target`; reinforced by chat-derived review
practice in `docs/llm/scratch/current-state-classification.md`.

- One Work Order should name one enforceable invariant.
- Validator work should introduce at most one failure-code family.
- Implementation guidance is non-authoritative; invariant, scope, acceptance,
  non-goals, tests, and stop/split triggers win.
- Do not repair prerequisite behavior inside a later Work Order. Stop and split.
- Do not let CLI, fixtures, fingerprinting, path safety, Evidence Pack, worker,
  or journal work leak into each other.

## Current Sequencing Context

Classification: `repo-confirmed` for implemented files/tests,
`documented-target` for future gates.

- Current repo has implemented early Work Order validation, CLI wrapper,
  fixtures, fingerprint primitive, approval bindings, lexical path
  normalization, write-scope lexical validation, and protected-path detection
  for Work Order write allowlists.
- Work Order validation also applies limited lexical and existing-path realpath
  forbidden-over-allowed checks for `scope.allowed`, plus lexical and parent
  realpath forbidden-over-allowed checks for `scope.allowedNewFiles` when
  new-file policy allows them.
- Work Order validation checks existing `scope.allowed` entries and allowed or
  listed `scope.allowedNewFiles` parents for repository-root containment and
  exact filesystem spelling when those paths resolve.
- Protected-path rejection is limited to `scope.allowed` and
  `scope.allowedNewFiles`; it is not full scope authorization or runtime worker
  write enforcement.
- Full runtime scope authorization, observed worker path enforcement, broader
  case-ambiguity handling beyond current existing-path and new-file-parent
  spelling checks, Evidence Pack validation, artifact store, run journal,
  worker execution, repair loops, model-backed workers, templates, and `/build`
  remain future work unless a current Work Order explicitly implements them.

## Uncommitted Changes

Uncommitted user changes may be intentional. Work with them if they affect the
task, and leave them alone if they do not.
